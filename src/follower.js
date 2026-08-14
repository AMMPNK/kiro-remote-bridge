'use strict';
/**
 * 从属模式：没抢到端口的那些窗口，连回抢到端口的那个实例待命。
 *
 * ## 为什么需要它
 *
 * 手机上新建会话时，会话建在哪个窗口是可以指定的（`session/new` 发给那个窗口的 mux
 * 连接就行）。但紧接着必须让**桌面面板**打开它，否则它的审批请求会在几十毫秒内被判
 * cancelled，手机上根本批不动。而"打开面板"只能通过 `vscode.commands.executeCommand`，
 * **那个 API 只在自己所在的窗口生效** —— 扩展宿主是一个窗口一个进程，命令跨不了窗口。
 *
 * 结果就是：主实例只能在**自己**窗口打开那个会话，于是自己的窗口接管了它，
 * 连 agent 看到的工作区上下文一起接管。实测表现是「选了 A 工作区，agent 在 B 里干活」。
 *
 * 解法不复杂：那些没抢到端口的窗口里，我们的扩展实例本来就在跑、而且完全闲着。
 * 让它们连回主实例、报一句自己是哪个 workspace，主实例需要在某个窗口打开会话时，
 * 就把这件事**派给那个窗口的实例去做**。
 *
 * ## 通道用现成的
 *
 * 就是手机端在用的那条 WebSocket + token。同一台机器上 token 文件自己读得到，
 * 不需要另立协议、另开端口。三条消息：
 *   → `follower:hello`     连上就报自己的 workspacePaths
 *   ← `follower:attach`    主实例派活：在你窗口打开这个会话
 *   → `follower:attached`  回报结果，用 reqId 对上号
 *
 * ## 刻意的取舍
 *
 * - **只在已经有主实例在跑时才连。** 探测不到就安静退出，绝不重试等待 ——
 *   用户从没开过 Bridge 的窗口，不该因为装了这个扩展就多一条后台连接。
 * - **连不上不影响任何现有功能。** 主实例发现没有对应的从属连接时会退回原来的行为
 *   （在自己窗口 attach）并照旧提示，所以最坏情况不比现在差。
 * - **不做指数退避的长期重连。** 主实例重启时从属会断开，这里只做有限次快速重连；
 *   长期离线就放弃，等下次窗口重载。这条通道是"锦上添花"，不值得为它常驻定时器。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WsClient } = require('./wsClient');

/** 主实例把 token 写在这里；从属实例读它来通过认证 */
const TOKEN_FILE = path.join(os.homedir(), '.kiro-bridge', 'relay-token.json');

/**
 * 重连退避序列。最后一档会**一直重复**，不再放弃。
 *
 * 原先是固定三次（1s/3s/8s）然后永久放弃，理由是"不想常驻定时器"。那是资源考量，
 * 不是判据 —— 这是本地连接，重连成本近乎零；而放弃之后待命能力**静默失效**，
 * 要等到人真正去用的时候才暴露。两边代价严重不对称。
 *
 * 而且失效窗口恰好是最修不了的时候：触发场景是机器睡眠唤醒、或者主实例所在的窗口
 * 被重载（重载耗时通常超过 8 秒，刚好错过原来那三次），而这些事发生时人可能已经出门了。
 */
const RETRY_DELAYS_MS = [1000, 3000, 8000, 20000, 60000];

/**
 * 刚撞到「端口被占」时，主实例可能正在启动、token 还没落盘。
 * 这种情况下不能立刻判定"没有主实例"，短暂等一下再读。
 * 只在这个场景重试 —— 端口没被占时压根不会走到从属逻辑。
 */
const TOKEN_WAIT_TRIES = 6;
const TOKEN_WAIT_MS = 250;

function readToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const t = raw && (raw.token || raw.value);
    return t ? String(t) : null;
  } catch (_) {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从属实例。
 *
 * @param {object} deps
 *   port           主实例监听的端口（就是本窗口没抢到的那个）
 *   workspacePaths 本窗口打开的工作区路径，用来让主实例认出该派谁
 *   log            日志
 *   onAttach       收到派活时执行：(sessionId) => Promise<void>，抛错就算失败
 *   tryPromote     可选。连接断开后先问一次「我能不能自己上位」，返回 true 就停止从属逻辑。
 *                  主实例所在的窗口被关掉时靠这个恢复服务。
 */
class Follower {
  constructor({ port, workspacePaths, log, onAttach, tryPromote }) {
    this.port = port;
    this.workspacePaths = Array.isArray(workspacePaths) ? workspacePaths : [];
    this.log = log || (() => {});
    this.onAttach = onAttach;
    this.tryPromote = tryPromote || null;
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
    this.connected = false;
    /** 只统计给测试看：确认退避真的在往后走，而不是一直用第一档 */
    this.retryTotal = 0;
  }

  async start() {
    /*
     * 走到这里说明端口已经被占了，也就是**有另一个实例正在起或已经起好**。
     * 所以读不到 token 有两种可能，必须分开：
     *   - 主实例正在启动、token 还没落盘 → 等一下就有（多窗口同时启动时的常见竞态）
     *   - 端口被无关程序占着 → 等也没有
     * 只在前一种情况下重试有意义，而两者都靠"等一小会儿再读"来区分，代价很低。
     */
    let token = readToken();
    for (let i = 0; !token && i < TOKEN_WAIT_TRIES; i++) {
      await sleep(TOKEN_WAIT_MS);
      token = readToken();
      if (token) this.log(`[follower] token 稍后才出现（等了 ${(i + 1) * TOKEN_WAIT_MS}ms）`);
    }
    if (!token) {
      this.log('[follower] 等不到 relay token，端口可能被无关程序占着，不进入从属模式');
      return false;
    }
    return this._connect(token);
  }

  _connect(token) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(false);
      const url = `ws://127.0.0.1:${this.port}/?token=${encodeURIComponent(token)}`;
      const ws = new WsClient(url, { timeoutMs: 5000 });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.connected = true;
        // 连上了就把退避重置到第一档：下一次断开该快速重试，而不是继承上一轮的长间隔
        this.retry = 0;
        this.log(`[follower] 已连上主实例 127.0.0.1:${this.port}，待命中`);
        ws.sendJson({ type: 'follower:hello', workspacePaths: this.workspacePaths });
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });

      ws.on('message', (text) => this._onMessage(text));

      ws.on('error', () => {
        /* 具体原因在 close 里统一处理，这里不重复记 */
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        const wasFirstAttempt = !settled;
        if (!settled) {
          settled = true;
          this.log('[follower] 连不上主实例（可能刚好在重启），本窗口不进入从属模式');
          resolve(false);
        }
        if (this.stopped) return;
        // 第一次就没连上时不做后续重连：那属于"压根没进入从属模式"，
        // 由调用方决定要不要重来，不该在这里悄悄常驻一个重试循环。
        if (wasFirstAttempt) return;
        this._scheduleReconnect();
      });
    });
  }

  /**
   * 断线之后：先问能不能自己上位，不能就退避重连。
   *
   * 顺序是刻意的 —— 主实例所在的窗口被关掉时，端口会随之释放，这时**该有人接管**，
   * 而不是一直重连一个已经不存在的服务。反过来如果主实例只是重载（端口很快被它自己
   * 或别的窗口占回去），抢端口会失败，那就继续当从属，语义也正确。
   * 端口 listen 天然互斥，所以多个窗口同时尝试是安全的，恰好一个成功。
   */
  async _scheduleReconnect() {
    if (this.stopped) return;
    if (this.tryPromote) {
      let promoted = false;
      try {
        promoted = await this.tryPromote();
      } catch (_) {
        promoted = false;
      }
      if (promoted) {
        this.log('[follower] 已升为主实例，停止从属逻辑');
        this.stopped = true;
        return;
      }
    }
    if (this.stopped) return;
    // 退避到最后一档就一直用它重试，不再放弃 —— 理由见 RETRY_DELAYS_MS 的说明
    const idx = Math.min(this.retry, RETRY_DELAYS_MS.length - 1);
    const delay = RETRY_DELAYS_MS[idx];
    this.retry += 1;
    this.retryTotal += 1;
    this.log(`[follower] 与主实例断开，${delay}ms 后重连（累计第 ${this.retryTotal} 次）`);
    const t = setTimeout(() => {
      if (this.stopped) return;
      const fresh = readToken(); // token 可能在主实例重启时换过
      if (fresh) this._connect(fresh);
      else this._scheduleReconnect(); // 连 token 都没了，等下一轮再看
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    this._retryTimer = t;
  }

  async _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!msg || msg.type !== 'follower:attach') return;
    const { sessionId, reqId } = msg;
    let ok = false;
    let error = null;
    try {
      // 关键的一步：这行代码跑在**本窗口**的扩展宿主里，所以 viewSession 作用于本窗口，
      // 而本窗口正是那个会话真正归属的窗口。
      await this.onAttach(sessionId);
      ok = true;
      this.log(`[follower] 已在本窗口打开会话 ${sessionId}`);
    } catch (err) {
      error = String((err && err.message) || err);
      this.log(`[follower] 打开会话 ${sessionId} 失败: ${error}`);
    }
    if (this.ws) this.ws.sendJson({ type: 'follower:attached', reqId, sessionId, ok, error });
  }

  stop() {
    this.stopped = true;
    // 清掉已排上的重连 —— 少了这一步，「停止远程会话」之后还会再连回去一次，
    // 而用户以为这个窗口已经完全退出了
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = { Follower, TOKEN_FILE, RETRY_DELAYS_MS };
