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

/** 连接断开后重试几次、间隔多久。刻意有限次：见上面「刻意的取舍」 */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

function readToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const t = raw && (raw.token || raw.value);
    return t ? String(t) : null;
  } catch (_) {
    return null;
  }
}

/**
 * 从属实例。
 *
 * @param {object} deps
 *   port           主实例监听的端口（就是本窗口没抢到的那个）
 *   workspacePaths 本窗口打开的工作区路径，用来让主实例认出该派谁
 *   log            日志
 *   onAttach       收到派活时执行：(sessionId) => Promise<void>，抛错就算失败
 */
class Follower {
  constructor({ port, workspacePaths, log, onAttach }) {
    this.port = port;
    this.workspacePaths = Array.isArray(workspacePaths) ? workspacePaths : [];
    this.log = log || (() => {});
    this.onAttach = onAttach;
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
    this.connected = false;
  }

  async start() {
    const token = readToken();
    if (!token) {
      // 没有 token 文件说明主实例从没启动过。不报错、不重试 —— 这是正常状态。
      this.log('[follower] 没找到 relay token，主实例大概没在跑，不进入从属模式');
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
        if (!settled) {
          settled = true;
          this.log('[follower] 连不上主实例（可能刚好在重启），本窗口不进入从属模式');
          resolve(false);
        }
        if (this.stopped) return;
        const delay = RETRY_DELAYS_MS[this.retry];
        if (delay === undefined) {
          this.log('[follower] 重连次数用完，放弃。下次重载窗口会再试');
          return;
        }
        this.retry += 1;
        this.log(`[follower] 与主实例断开，${delay}ms 后重连（第 ${this.retry} 次）`);
        const t = setTimeout(() => {
          const fresh = readToken(); // token 可能在主实例重启时换过
          if (fresh) this._connect(fresh);
        }, delay);
        if (t && typeof t.unref === 'function') t.unref();
      });
    });
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
