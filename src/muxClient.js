'use strict';
/**
 * 连接 Kiro IDE 的 agent mux server。
 *
 * 每个 IDE 窗口在启动时都会 createAgentMuxServer() 并把 {port, token} 注册进
 * kiro.agentRegistry；mux 支持多客户端接入，本模块以额外客户端身份加入，
 * 不影响 IDE 自身的聊天前端。
 *
 * 协议：JSON-RPC 2.0 over WebSocket，ACP 形状 + `_kiro/*` 扩展方法。
 * 连接串（取自扩展产物的 StandaloneClient.connect）：
 *   ws://127.0.0.1:<port>?token=<token>
 *
 * 注意：mux 在收到任何带 sessionId 的请求时会自动把本客户端订阅到该会话，
 * 并重发待处理的权限请求与 user_input。所以「订阅」不需要单独的方法。
 *
 * 本模块对方法名做了保守处理：只依赖 initialize 与 session/prompt（两者已从
 * 产物中确认），其余一律记录而不假设。未知方法会进日志，便于后续补齐。
 */
const { EventEmitter } = require('events');
const { WsClient } = require('./wsClient');

const CLIENT_INFO = { name: 'kiro-remote-bridge', version: '0.1.0' };

/**
 * session/prompt 的超时。它要等整个回合跑完才返回（中途还可能停下来等人批准工具），
 * 所以绝不能用默认的 30s —— 实测那会把「已送达且正在处理」误报成发送失败，
 * 而且降级重发还会撞上 "A prompt is already in-flight"。
 * 这里只作为「连接已经不可能再回话」的兜底，不参与正常判定。
 */
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

class MuxConnection extends EventEmitter {
  /**
   * @param {{port:number, token:string, windowId:string, folders:Array}} endpoint
   * @param {(msg:string)=>void} log
   */
  constructor(endpoint, log) {
    super();
    this.endpoint = endpoint;
    this.log = log || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.initializeResult = null;
    this.lastError = null;
    /** 收到过的入站方法名 -> 次数，用于自诊断摸清可用面 */
    this.seenMethods = new Map();
    this.ws = null;
  }

  get label() {
    const f = (this.endpoint.folders || [])[0];
    return f && f.label ? f.label : `window ${this.endpoint.windowId}`;
  }

  connect() {
    return new Promise((resolve) => {
      const { port, token } = this.endpoint;
      const url = `ws://127.0.0.1:${port}?token=${encodeURIComponent(token || '')}`;
      const ws = new WsClient(url, { timeoutMs: 8000 });
      this.ws = ws;
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      ws.on('open', async () => {
        this.log(`[mux] 已连接 port=${port} (${this.label})`);
        try {
          const res = await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: CLIENT_INFO,
          });
          this.initializeResult = res;
          this.ready = true;
          this.log(
            `[mux] initialize 成功 port=${port} protocolVersion=${
              res && res.protocolVersion
            } capabilities=${JSON.stringify((res && res.agentCapabilities) || {}).slice(0, 300)}`
          );
          this.emit('ready', res);
          settle(true);
        } catch (err) {
          this.lastError = String(err && err.message ? err.message : err);
          this.log(`[mux] initialize 失败 port=${port}: ${this.lastError}`);
          settle(false);
        }
      });

      ws.on('message', (text) => this._onMessage(text));
      ws.on('error', (err) => {
        this.lastError = String(err && err.message ? err.message : err);
        this.log(`[mux] 连接错误 port=${port}: ${this.lastError}`);
      });
      ws.on('close', (code, reason) => {
        this.ready = false;
        if (code || reason) {
          this.lastError = `closed code=${code} reason=${reason || ''}`;
        }
        this.log(`[mux] 连接关闭 port=${port} code=${code || '-'} reason=${reason || '-'}`);
        for (const [, p] of this.pending) p.reject(new Error('connection closed'));
        this.pending.clear();
        this.emit('closed');
        settle(false);
      });
    });
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      this.log(`[mux] 收到非 JSON 帧（${text.length} 字节），已忽略`);
      return;
    }
    // 响应
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        /*
         * 把 JSON-RPC error 的结构化字段挂到 Error 上。
         *
         * 原先只有 `new Error(JSON.stringify(msg.error))`，于是 message 里虽然带着
         * `{"code":-32001,...}` 的字面量，但 `err.code` 永远是 undefined ——
         * 任何 `err.code === -32001` 的判据都是死代码，只有正则匹配 message 在真正起作用。
         * 而正则要在一个 JSON 字面量里找子串，稍微改个措辞就失效。
         *
         * 这个坑还会污染测试:测试里手工构造 `Object.assign(new Error(''), { code })`
         * 就能让判据通过，而真实对端给的错误从来没有 code —— mock 比真实情况宽容，
         * 于是判据看着有测试覆盖，实际在生产里从没生效过。
         *
         * message 的格式保持不变，免得动到已有的文本兜底判据。
         */
        const e = new Error(JSON.stringify(msg.error).slice(0, 300));
        if (msg.error && typeof msg.error.code === 'number') e.code = msg.error.code;
        if (msg.error && msg.error.message) e.rpcMessage = String(msg.error.message);
        e.rpcError = msg.error;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    // agent → client 的请求或通知
    if (msg.method) {
      this.seenMethods.set(msg.method, (this.seenMethods.get(msg.method) || 0) + 1);
      const isRequest = msg.id !== undefined;
      this.emit('inbound', {
        method: msg.method,
        params: msg.params,
        id: isRequest ? msg.id : undefined,
        connection: this,
      });
    }
  }

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.state !== 'open') {
        reject(new Error('mux connection not open'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.sendJson({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (!this.ws || this.ws.state !== 'open') return false;
    return this.ws.sendJson({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    if (id === undefined) return false;
    return this.ws.sendJson({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    if (id === undefined) return false;
    return this.ws.sendJson({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /**
   * 向指定会话发送用户消息。方法名与参数形状取自 kiroAgent.sessions.sendPrompt 的实现。
   *
   * 返回的 Promise 要到**整个回合结束**才 settle，不是「已送达」。调用方想判断送达，
   * 应该只看短时间内有没有回错误，不要 await 它跑完（见 extension.js 的 sendToSession）。
   */
  sendPrompt(sessionId, promptOrText, timeoutMs = PROMPT_TIMEOUT_MS) {
    // 传数组就当成已经组好的 ContentBlock[]（带附件时用），传字符串按纯文本处理
    const prompt = Array.isArray(promptOrText)
      ? promptOrText
      : [{ type: 'text', text: String(promptOrText) }];
    return this.request('session/prompt', { sessionId, prompt }, timeoutMs);
  }

  /**
   * 提交权限请求的结果。
   *
   * 必须走 `_kiro/permission/respond` 这个扩展方法，**不能**用 respond() 回 JSON-RPC 应答。
   * 依据是 Kiro 产物里 MultiplexStream 的分发逻辑：mux 给每个客户端标了 role，
   *   observer 的 permission 应答会被直接丢弃，日志原文
   *     "discarded observer permission response ... (waiting for _kiro/permission/respond)"
   *   只有 primary（拥有会话的桌面面板）的 JSON-RPC 应答才会被转发。
   * 而 bridge 是 observer，所以此前回的应答全部被静默丢掉 —— 表现为手机点了「允许」，
   * 电脑上的框继续挂着，直到 5 分钟（产物里 300*1e3）超时后以 cancelled 收场。
   *
   * 参数形状照 Kiro 自己的两处调用抄：
   *   resolve-permission-request.ts  { toolCallId, optionId, _meta }
   *   supervised-mode.ts             { toolCallId, optionId, sessionId, fileDecisions? }
   */
  /**
   * @param {string|null} scope 持久化范围,只对 *_always 选项有意义:
   *   'user'      写 ~/.kiro/settings/permissions.yaml,永久生效（桌面端的默认）
   *   'workspace' 写工作区的 permissions.yaml
   *   'session'   只进内存,会话结束即失效
   *   不传        agent 侧落到默认值 'session'
   *
   * 依据 Kiro 产物：cr9() 里 `scope: metaConsent?.scope || "session"`,
   * metaConsent 取自本方法的 `_meta.kiro.consent`；persistConsent() 再按 scope 分三路写盘。
   * Kiro 自己在 resolve-permission-request.ts 里也是这样带 _meta 调用的。
   */
  respondPermission(sessionId, toolCallId, optionId, scope = null, timeoutMs = 15000) {
    const params = { toolCallId, optionId, sessionId };
    // 只在需要持久化时才声明 scope。once 类选项不生成 consent,带上去也不会被读，
    // 但显式一点，日志里也能一眼看出这次是不是永久授权。
    if (scope) params._meta = { kiro: { consent: { scope } } };
    return this.request('_kiro/permission/respond', params, timeoutMs);
  }
  cancel(sessionId) {
    return this.notify('session/cancel', { sessionId });
  }

  /**
   * 新建会话。参数形状取自扩展产物里 kiroAgent.sessions.create 的实现：
   * client.newSession({ ...workspaceMeta, mcpServers: [] })，返回值含 sessionId
   * 与 configOptions（模型 / 自主度 / 投入度都要靠它二次配置）。
   */
  newSession(cwd, mcpServers) {
    return this.request('session/new', {
      cwd: cwd || process.cwd(),
      mcpServers: mcpServers || [],
    });
  }

  /**
   * 设置会话配置项。mode / model / autopilot / contentCollection 都走这一个方法，
   * configId 取自 configOptions 里的 id。返回更新后的 configOptions。
   *
   * 实测结论：这是 Kiro 实际使用的通道（产物里 configureSessionModel 与
   * configureSessionAutonomy 都调它）。ACP 标准方法里 session/set_mode 确实存在，
   * 但 session/set_model 在本 agent 上返回 -32601 Method not found，不能用。
   */
  setConfigOption(sessionId, configId, value) {
    return this.request('session/set_config_option', { sessionId, configId, value });
  }

  /** 删除会话。实测可用，返回 { success: true }。这是不可逆操作。 */
  deleteSession(sessionId) {
    return this.request('_kiro/session/delete', { sessionId });
  }

  /** 列出 agent 侧的会话。实测可用，返回 { sessions: [...] }。 */
  listSessions(params) {
    return this.request('session/list', params || {});
  }

  /**
   * 取配置模板（可用模型、模式等）。
   * `_kiro/config/template` 出现在 agentCapabilities._meta.kiro.extensionMethods 里，
   * 但返回结构未在文档中说明，调用方需要容错。
   */
  configTemplate() {
    return this.request('_kiro/config/template', {});
  }

  dispose() {
    try {
      if (this.ws) this.ws.close(1000, 'bridge shutting down');
    } catch (_) {
      /* ignore */
    }
  }
}

class MuxPool extends EventEmitter {
  /**
   * @param {any} vscode
   * @param {(msg:string)=>void} log
   */
  constructor(vscode, log) {
    super();
    this.vscode = vscode;
    this.log = log || (() => {});
    /** port -> MuxConnection */
    this.connections = new Map();
    this.endpointsAvailable = false;
    this.lastEndpointError = null;
  }

  async fetchEndpoints() {
    try {
      const eps = await this.vscode.commands.executeCommand(
        'kiro.agentRegistry.getAgentEndpoints'
      );
      if (!Array.isArray(eps)) {
        this.endpointsAvailable = false;
        this.lastEndpointError = `unexpected return: ${typeof eps}`;
        return [];
      }
      this.endpointsAvailable = true;
      this.lastEndpointError = null;
      return eps;
    } catch (err) {
      this.endpointsAvailable = false;
      this.lastEndpointError = String(err && err.message ? err.message : err);
      this.log(`[mux] getAgentEndpoints 不可用: ${this.lastEndpointError}`);
      return [];
    }
  }

  /** 建立/刷新到所有 IDE 窗口 agent server 的连接 */
  async refresh() {
    const eps = await this.fetchEndpoints();
    const livePorts = new Set();
    for (const ep of eps) {
      if (typeof ep.port !== 'number') continue;
      livePorts.add(ep.port);
      if (this.connections.has(ep.port)) continue;
      const conn = new MuxConnection(ep, this.log);
      conn.on('inbound', (m) => this.emit('inbound', m));
      conn.on('closed', () => this.connections.delete(ep.port));
      this.connections.set(ep.port, conn);
      const ok = await conn.connect();
      if (!ok) {
        this.connections.delete(ep.port);
      }
    }
    // 清理已消失的窗口
    for (const [port, conn] of Array.from(this.connections)) {
      if (!livePorts.has(port)) {
        conn.dispose();
        this.connections.delete(port);
      }
    }
    return {
      endpointCount: eps.length,
      connectedCount: this.connections.size,
    };
  }

  anyReady() {
    for (const c of this.connections.values()) if (c.ready) return c;
    return null;
  }

  /** 优先用工作区路径匹配窗口，匹配不到则退回任一可用连接 */
  pickForWorkspace(workspacePath) {
    if (workspacePath) {
      for (const c of this.connections.values()) {
        if (!c.ready) continue;
        const folders = c.endpoint.folders || [];
        if (folders.some((f) => f && f.path === workspacePath)) return c;
      }
    }
    return this.anyReady();
  }

  diagnostics() {
    const conns = [];
    for (const [port, c] of this.connections) {
      conns.push({
        port,
        label: c.label,
        windowId: c.endpoint.windowId,
        ready: c.ready,
        lastError: c.lastError,
        protocolVersion: c.initializeResult && c.initializeResult.protocolVersion,
        agentCapabilities: (c.initializeResult && c.initializeResult.agentCapabilities) || null,
        inboundMethods: Object.fromEntries(c.seenMethods),
      });
    }
    return {
      endpointsAvailable: this.endpointsAvailable,
      lastEndpointError: this.lastEndpointError,
      connections: conns,
    };
  }

  dispose() {
    for (const c of this.connections.values()) c.dispose();
    this.connections.clear();
  }
}

module.exports = { MuxPool, MuxConnection };
