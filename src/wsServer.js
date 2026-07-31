'use strict';
/**
 * 零依赖的最小 WebSocket 服务端（RFC 6455 子集）。
 *
 * 只实现本项目需要的部分：text 帧、ping/pong、close、分片重组。
 * 不引入 ws 包，避免 vsix 打包 node_modules。
 *
 * 用法：
 *   const wss = new WsServer();
 *   wss.on('connection', (conn, req) => { conn.send('hi'); conn.on('message', ...) });
 *   httpServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head));
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
/** 单帧上限，防止恶意超大 payload 打爆内存 */
const MAX_PAYLOAD = 8 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 服务端发出的帧不掩码 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 高 32 位写 0：本项目单帧不会超过 4GB
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN=1
  return Buffer.concat([header, payload]);
}

class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];
    this._fragLen = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this._finish();
      this.emit('error', err);
    });
    socket.on('close', () => this._finish());

    // 心跳：30s 一次 ping，2 个周期无 pong 视为断开
    this._alive = true;
    this._hb = setInterval(() => {
      if (this.closed) return;
      if (!this._alive) {
        this.terminate();
        return;
      }
      this._alive = false;
      this.ping();
    }, 30000);
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._hb);
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** 从缓冲里取出一个完整帧；不足则返回 null 等更多数据 */
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
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
        this.close(1009, 'payload too large');
        return null;
      }
      len = lo;
      offset += 8;
    }
    if (len > MAX_PAYLOAD) {
      this.close(1009, 'payload too large');
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
        this._alive = true;
        return;
      case OP_CLOSE:
        this.close(1000, '');
        return;
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
          this.close(1009, 'payload too large');
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
        this.close(1002, 'unsupported opcode');
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('binary', payload);
    }
  }

  _sendRaw(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch (_) {
      this.terminate();
    }
  }

  send(text) {
    this._sendRaw(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    this._sendRaw(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendRaw(OP_CLOSE, payload);
    this._finish();
    try {
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
  }

  terminate() {
    this._finish();
    try {
      this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

class WsServer extends EventEmitter {
  constructor() {
    super();
    this.connections = new Set();
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} socket
   * @param {(req) => boolean} authorize 返回 false 则拒绝（用于 token 校验）
   */
  handleUpgrade(req, socket, authorize) {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || String(version) !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (typeof authorize === 'function' && !authorize(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const conn = new WsConnection(socket, req);
    this.connections.add(conn);
    conn.on('close', () => this.connections.delete(conn));
    this.emit('connection', conn, req);
  }

  broadcastJson(obj) {
    const text = JSON.stringify(obj);
    for (const c of this.connections) c.send(text);
  }

  closeAll() {
    for (const c of Array.from(this.connections)) c.terminate();
    this.connections.clear();
  }
}

module.exports = { WsServer, WsConnection };
