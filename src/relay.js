'use strict';
/**
 * 本地 relay：给手机提供 PWA 静态页 + WebSocket 通道。
 *
 * 安全边界（重要）：
 *  - 所有 HTTP 与 WS 入口都强制校验 token。token 由调用方注入（扩展会持久化它，
 *    否则人在外面遇到一次重启就再也拿不到新二维码）；没注入时退回临时随机值。
 *  - 默认可绑定局域网（手机同 WiFi 直连）。绑 LAN 意味着同网段任何设备都能到达
 *    这个端口，token 是唯一的门；因此 token 用 32 字节随机并做定时比较。
 *  - 不做公网暴露。要外网访问请自行叠加隧道，并清楚那等于把 IDE 控制面放到公网。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WsServer, MAX_PAYLOAD } = require('./wsServer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** 防暴力猜测：同一 IP 每分钟最多 60 次失败 */
const FAIL_WINDOW_MS = 60000;
const FAIL_LIMIT = 60;
/** 超过这个条数就顺手清一次过期记录 */
const FAIL_TABLE_SOFT_MAX = 256;
/** 清完还超过这个条数就整表重置，保证内存有上界 */
const FAIL_TABLE_HARD_MAX = 4096;

/**
 * 公开资源：不校验 token 也能取。
 *
 * 这么做是因为 token 只在扫码那一次出现在 URL 里。PWA 从主屏启动时用的是
 * manifest 里的 start_url（不含 query），如果外壳页也要 token，页面根本加载不出来，
 * 用户看到的是一行 unauthorized。
 *
 * 安全性没有降低：这些文件是纯 UI 骨架，不含任何会话数据。真正的门在
 * WebSocket 与 /api/*，它们仍然强制校验 token。
 */
const PUBLIC_PATHS = new Set([
  '/app.html',
  '/qr.js',
  '/manifest.json',
  '/icon.svg',
]);

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

class Relay {
  /**
   * @param {{mediaDir:string, log:(m:string)=>void, handlers:Record<string,Function>}} opts
   */
  constructor(opts) {
    this.mediaDir = opts.mediaDir;
    this.log = opts.log || (() => {});
    this.handlers = opts.handlers || {};
    // 调用方可以传入持久化的 token（见 extension.js 的 TOKEN_FILE）；不传就临时随机一个
    this.token = opts.token || crypto.randomBytes(32).toString('base64url');
    this.server = null;
    this.wss = new WsServer();
    this.port = null;
    this.bindLan = true;
    this.failures = new Map();

    this.wss.on('connection', (conn, req) => this._onWsConnection(conn, req));
  }

  _rateLimited(ip) {
    const now = Date.now();
    const rec = this.failures.get(ip);
    if (!rec || now - rec.since > FAIL_WINDOW_MS) return false;
    return rec.count >= FAIL_LIMIT;
  }

  _noteFailure(ip) {
    const now = Date.now();
    const rec = this.failures.get(ip);
    if (!rec || now - rec.since > FAIL_WINDOW_MS) {
      this.failures.set(ip, { since: now, count: 1 });
    } else {
      rec.count++;
    }
    // 顺手清掉过期条目。这张表原来只增不减：每个来过的 IP 都会留下一条记录，
    // 而记录在窗口过期后已经没有任何作用。局域网里增长很慢，但没有上界。
    if (this.failures.size > FAIL_TABLE_SOFT_MAX) this._pruneFailures(now);
  }

  /** 丢掉窗口已过期的记录；若仍然过大，说明正在被大量不同源打，整表重置 */
  _pruneFailures(now = Date.now()) {
    for (const [ip, rec] of this.failures) {
      if (now - rec.since > FAIL_WINDOW_MS) this.failures.delete(ip);
    }
    // 全都在窗口内还超限，只能整表丢：宁可放宽限速，也不能让内存无上界。
    // 这是刻意的取舍 —— 限速是为了拖慢暴力猜 token，而 token 有 256 位熵。
    if (this.failures.size > FAIL_TABLE_HARD_MAX) {
      this.log(`[relay] 失败记录表超过 ${FAIL_TABLE_HARD_MAX} 条，已重置`);
      this.failures.clear();
    }
  }

  _checkToken(req) {
    let provided = null;
    try {
      const u = new URL(req.url, 'http://localhost');
      provided = u.searchParams.get('token');
    } catch (_) {
      /* ignore */
    }
    if (!provided) {
      const auth = req.headers['authorization'];
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        provided = auth.slice(7);
      }
    }
    if (!provided) return false;
    return timingSafeEqualStr(provided, this.token);
  }

  start(port, bindLan) {
    this.bindLan = bindLan !== false;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._onRequest(req, res));
      server.on('upgrade', (req, socket) => {
        const ip = socket.remoteAddress || 'unknown';
        if (this._rateLimited(ip)) {
          socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          return;
        }
        this.wss.handleUpgrade(req, socket, (r) => {
          const ok = this._checkToken(r);
          if (!ok) this._noteFailure(ip);
          return ok;
        });
      });
      server.on('error', reject);
      const host = this.bindLan ? '0.0.0.0' : '127.0.0.1';
      server.listen(port, host, () => {
        this.server = server;
        this.port = server.address().port;
        this.log(
          `[relay] 已监听 ${host}:${this.port}（绑定局域网=${this.bindLan}，token 认证已启用）`
        );
        resolve(this.port);
      });
    });
  }

  urls() {
    const list = [`http://127.0.0.1:${this.port}/?token=${this.token}`];
    if (this.bindLan) {
      for (const ip of lanAddresses()) {
        list.push(`http://${ip}:${this.port}/?token=${this.token}`);
      }
    }
    return list;
  }

  _onRequest(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (this._rateLimited(ip)) {
      res.writeHead(429).end('too many requests');
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      /* ignore */
    }
    if (pathname === '/') pathname = '/app.html';

    // 认证探测端点：让前端能区分「token 失效」和「网络不通」。
    // WebSocket 的 onerror 拿不到 HTTP 状态码，所以需要这样一个可查的入口。
    if (pathname === '/api/auth') {
      const ok = this._checkToken(req);
      if (!ok) this._noteFailure(ip);
      res.writeHead(ok ? 200 : 401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ ok }));
      return;
    }

    if (!PUBLIC_PATHS.has(pathname) && !this._checkToken(req)) {
      this._noteFailure(ip);
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized');
      return;
    }

    // 只允许 mediaDir 下的文件，杜绝路径穿越
    const rel = pathname.replace(/^\/+/, '');
    const target = path.resolve(this.mediaDir, rel);
    if (!target.startsWith(path.resolve(this.mediaDir) + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(target, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
        // 这是本机控制面，禁止被第三方页面嵌套
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      res.end(buf);
    });
  }

  _onWsConnection(conn, req) {
    const ip = req.socket.remoteAddress || 'unknown';
    this.log(`[relay] 手机端已连接 ${ip}（当前 ${this.wss.connections.size} 个客户端）`);
    conn.on('message', async (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        conn.sendJson({ type: 'error', message: 'invalid json' });
        return;
      }
      const handler = this.handlers[msg.type];
      if (!handler) {
        conn.sendJson({ type: 'error', message: `unknown type: ${msg.type}`, reqId: msg.reqId });
        return;
      }
      try {
        const result = await handler(msg, conn);
        if (result !== undefined) {
          conn.sendJson({ ...result, reqId: msg.reqId });
        }
      } catch (err) {
        this.log(`[relay] 处理 ${msg.type} 失败: ${err && err.message}`);
        conn.sendJson({
          type: 'error',
          message: String(err && err.message ? err.message : err),
          reqId: msg.reqId,
        });
      }
    });
    conn.on('close', () => {
      this.log(`[relay] 手机端断开（剩余 ${this.wss.connections.size} 个客户端）`);
    });
    if (this.handlers.__onConnect) {
      Promise.resolve(this.handlers.__onConnect(conn)).catch(() => {});
    }
  }

  /**
   * @param {object} obj
   * @param {{droppable?: boolean}} [opts] 周期性全量快照（sessions / status）应传
   *   droppable，积压时可以直接丢 —— 下一个周期会带来更新的同一份数据。
   *   delta / history 不要传：丢掉就永久少了几条消息，而界面上看不出来。
   */
  broadcast(obj, opts) {
    return this.wss.broadcastJson(obj, opts);
  }

  /**
   * 只发给满足条件的连接。
   * 会话级的推送（history / delta / muxUpdate）都该走这条 —— 广播给全部客户端时，
   * 另一台手机会收到它没打开的会话的内容，靠前端自己丢掉。能耗和流量都是白花的，
   * 而且历史消息可能有几 MB。
   */
  broadcastTo(pred, obj, opts) {
    let n = 0;
    for (const conn of this.wss.connections) {
      let want = false;
      try {
        want = !!pred(conn);
      } catch (_) {
        want = false;
      }
      if (want && conn.sendJson(obj, opts) !== false) n++;
    }
    return n;
  }

  /** 当前连接集合，供上层做按连接的状态归集 */
  get connections() {
    return this.wss.connections;
  }

  /** 单帧字节上限。握手时告诉手机端，让它按真实值算附件预算，而不是自己写死一份 */
  get maxPayload() {
    return MAX_PAYLOAD;
  }

  get clientCount() {
    return this.wss.connections.size;
  }

  stop() {
    this.wss.closeAll();
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {
        /* ignore */
      }
      this.server = null;
    }
    this.log('[relay] 已停止');
  }
}

module.exports = { Relay, lanAddresses };
