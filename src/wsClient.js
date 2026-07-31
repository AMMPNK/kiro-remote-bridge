'use strict';
/**
 * 零依赖的最小 WebSocket 客户端（RFC 6455 子集）。
 *
 * 不使用全局 WebSocket：扩展宿主是 Electron 的 node，版本随 Kiro 变动，
 * 全局 WebSocket 只在较新 node 才有。自己实现可以确定行为。
 * 客户端发出的帧必须掩码，这是与 wsServer.js 的关键差异。
 */
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_PAYLOAD = 64 * 1024 * 1024; // agent 侧上限 500MB，这里取够用的量

class WsClient extends EventEmitter {
  /**
   * @param {string} url 形如 ws://127.0.0.1:1234/path?query
   * @param {{timeoutMs?: number, headers?: Record<string,string>}} [opts]
   */
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.opts = opts;
    this.state = 'connecting';
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    /** close 事件只发一次；state 会在多条路径上被置为 closed，不能拿它当发射条件 */
    this._closeEmitted = false;
    this._fragOpcode = null;
    this._fragChunks = [];
    this._fragLen = 0;
    this._connect();
  }

  _connect() {
    let u;
    try {
      u = new URL(this.url);
    } catch (e) {
      this._fail(new Error(`invalid ws url: ${this.url}`));
      return;
    }
    if (u.protocol !== 'ws:') {
      this._fail(new Error(`only ws:// supported, got ${u.protocol}`));
      return;
    }
    const port = Number(u.port || 80);
    const host = u.hostname;
    const pathWithQuery = `${u.pathname || '/'}${u.search || ''}`;
    this._key = crypto.randomBytes(16).toString('base64');
    this._expectAccept = crypto
      .createHash('sha1')
      .update(this._key + GUID)
      .digest('base64');

    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);

    const timeoutMs = this.opts.timeoutMs || 10000;
    this._connectTimer = setTimeout(() => {
      this._fail(new Error(`ws connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => {
      const extra = Object.entries(this.opts.headers || {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      socket.write(
        `GET ${pathWithQuery} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${this._key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          extra +
          '\r\n'
      );
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._emitClose());
  }

  /** 唯一的 close 出口：底层 socket 关闭、收到 close 帧、出错都汇总到这里 */
  _emitClose() {
    clearTimeout(this._connectTimer);
    this.state = 'closed';
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close', this._closeCode, this._closeReason);
  }

  _fail(err) {
    clearTimeout(this._connectTimer);
    if (this._closeEmitted) return;
    const wasOpen = this.state !== 'closed';
    this.state = 'closed';
    if (wasOpen) this.emit('error', err);
    try {
      if (this.socket) this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    this._emitClose();
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._handshakeDone) {
      const idx = this._buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this._buf.subarray(0, idx).toString('latin1');
      this._buf = this._buf.subarray(idx + 4);
      const statusLine = head.split('\r\n')[0] || '';
      if (!/ 101 /.test(statusLine)) {
        this._fail(new Error(`handshake failed: ${statusLine.trim()}`));
        return;
      }
      const m = /sec-websocket-accept:\s*(\S+)/i.exec(head);
      if (!m || m[1] !== this._expectAccept) {
        this._fail(new Error('handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      this._handshakeDone = true;
      this.state = 'open';
      clearTimeout(this._connectTimer);
      this.emit('open');
    }
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.state === 'closed') return;
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0; // 服务端不应掩码，但按协议处理
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      if (hi !== 0) {
        this._fail(new Error('frame too large'));
        return null;
      }
      len = lo;
      offset += 8;
    }
    if (len > MAX_PAYLOAD) {
      this._fail(new Error('frame exceeds MAX_PAYLOAD'));
      return null;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_PING:
        this._sendRaw(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        this._closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this._closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        // 协议要求回一个 close 帧，然后立刻拆连接（不等对端，避免 close 事件迟迟不来）
        this._sendRaw(OP_CLOSE, payload.subarray(0, Math.min(2, payload.length)));
        try {
          this.socket.destroy();
        } catch (_) {
          /* ignore */
        }
        this._emitClose();
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (fin) {
          this._deliver(opcode, payload);
        } else {
          this._fragOpcode = opcode;
          this._fragChunks = [payload];
          this._fragLen = payload.length;
        }
        return;
      case OP_CONT: {
        if (this._fragOpcode === null) return;
        this._fragChunks.push(payload);
        this._fragLen += payload.length;
        if (this._fragLen > MAX_PAYLOAD) {
          this._fail(new Error('fragmented message exceeds MAX_PAYLOAD'));
          return;
        }
        if (fin) {
          const full = Buffer.concat(this._fragChunks);
          const op = this._fragOpcode;
          this._fragOpcode = null;
          this._fragChunks = [];
          this._fragLen = 0;
          this._deliver(op, full);
        }
        return;
      }
      default:
        this._fail(new Error(`unsupported opcode ${opcode}`));
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _sendRaw(opcode, payload) {
    if (this.state !== 'open' || !this.socket || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
      return true;
    } catch (_) {
      this._fail(new Error('socket write failed'));
      return false;
    }
  }

  send(text) {
    return this._sendRaw(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = '') {
    if (this.state === 'closed') return;
    const r = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendRaw(OP_CLOSE, payload);
    this._closeCode = code;
    this._closeReason = reason;
    this.state = 'closed';
    try {
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
    this._emitClose();
  }

  destroy() {
    try {
      if (this.socket) this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    this._emitClose();
  }
}

module.exports = { WsClient };
