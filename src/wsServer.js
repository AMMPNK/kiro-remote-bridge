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
/**
 * 心跳间隔与容忍的周期数。提出来是为了让测试能不真等 30 秒就验到「连续两个周期
 * 没动静才断」这个行为 —— 那是这两个值唯一值得测的地方，写死在 setInterval 里
 * 就只能靠读代码确认。
 */
const HB_INTERVAL_MS = 30000;
const HB_MAX_MISSED = 2;

const OP_PING = 0x9;
const OP_PONG = 0xa;
/** 单帧上限，防止恶意超大 payload 打爆内存 */
const MAX_PAYLOAD = 8 * 1024 * 1024;
/**
 * 积压超过这个字节数后，可丢弃的周期性帧就不再往队列里堆。
 * 取 512KB：正常局域网下 writableLength 基本是 0，能持续到这个量级就说明对端确实
 * 不在收了（心跳会在约 60 秒后收掉连接）。
 */
const HIGH_WATER_BYTES = 512 * 1024;

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

    /*
     * 心跳：每 HB_INTERVAL_MS 发一次 ping，连续 HB_MAX_MISSED 个周期没有任何动静才断开。
     *
     * 这里原先有两个问题，合起来会误杀正常连接（实测症状：手机在前台好好用着，
     * 却间歇性显示「已断开，重连中」，而网络本身没问题）：
     *
     * ① 注释写着「2 个周期无 pong 视为断开」，代码却是检查和重置在同一个 tick 里 ——
     *    发完 ping 立刻把 _alive 置 false，下一次检查就在 30 秒后。**实际容忍度只有
     *    一个周期**。经 VPN 或移动网络时，隧道抖动一下、或者手机切换基站，
     *    30 秒就可能过不去。
     * ② _alive 只由 PONG 帧恢复，**正常的消息帧不算**。于是一条正在收发数据的连接
     *    也可能因为单个 pong 没赶上而被杀掉 —— 判据错了：要判的是「这条连接还有没有
     *    活动」，而不是「有没有收到 pong」。pong 只是在没有别的流量时用来探活的手段。
     *
     * 现在两条都改了：任何入站帧都算活着（见 _handleFrame），且要连续两个周期
     * 彻底没动静才断。代价是死连接最多多占 30 秒，对单用户的本机工具无所谓；
     * 而误杀的代价是用户可见的断线重连，两者不对称。
     */
    this._alive = true;
    this._missedBeats = 0;
    this._hb = setInterval(() => {
      if (this.closed) return;
      if (this._alive) {
        this._missedBeats = 0;
      } else if (++this._missedBeats >= HB_MAX_MISSED) {
        this.terminate();
        return;
      }
      this._alive = false;
      this.ping();
    }, HB_INTERVAL_MS);
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._hb);
    this.emit('close');
  }

  _onData(chunk) {
    /*
     * 收到任何字节都说明这条连接还活着 —— 判据放在这里而不是逐个帧类型里处理，
     * 是为了不漏：将来加新的 opcode 分支也自动算作活动。
     *
     * 这一行是「前台正常使用时也会间歇性断线」的修复关键：此前只有 PONG 帧会
     * 重置存活标记，一条正在收发消息的连接照样可能被心跳判死。
     */
    this._alive = true;
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
        // pong 只是「没有别的流量时」的探活手段，不是唯一的存活证据 ——
        // 每个入站帧都会在 _onData 里把 _alive 置 true，见那里的说明。
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
    if (this.closed || this.socket.destroyed) return false;
    try {
      // 返回值刻意向上传。socket.write 返回 false 表示这一帧进了 Node 的内存队列而不是
      // 内核缓冲 —— 原来这个返回值被丢掉，于是「手机走进隧道」这种状态在服务端完全
      // 不可观测（心跳会在约 60 秒后收掉连接，但期间的积压看不见也说不清）。
      const ok = this.socket.write(encodeFrame(opcode, payload));
      this.slowSince = ok ? 0 : this.slowSince || Date.now();
      return ok;
    } catch (_) {
      this.terminate();
      return false;
    }
  }

  /** 还积压在 Node 内存队列里的字节数（尚未进内核缓冲的部分） */
  get bufferedBytes() {
    return (this.socket && this.socket.writableLength) || 0;
  }

  /**
   * @param {string} text
   * @param {{droppable?: boolean}} [opts] droppable：这一帧丢掉不造成信息损失
   */
  send(text, opts) {
    // 只有「周期性全量快照」允许丢，因为下一个周期会带来更新的同一份数据。
    // delta / history 绝不能丢 —— store 的游标已经推进，丢掉就永久少了几条消息，
    // 而界面上完全看不出来。这类帧宁可继续排队，让心跳去判定连接死没死。
    if (opts && opts.droppable && this.bufferedBytes > HIGH_WATER_BYTES) {
      this.dropped = (this.dropped || 0) + 1;
      return false;
    }
    return this._sendRaw(OP_TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(obj, opts) {
    return this.send(JSON.stringify(obj), opts);
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

  broadcastJson(obj, opts) {
    const text = JSON.stringify(obj);
    let n = 0;
    for (const c of this.connections) if (c.send(text, opts) !== false) n++;
    return n;
  }

  closeAll() {
    for (const c of Array.from(this.connections)) c.terminate();
    this.connections.clear();
  }
}

// MAX_PAYLOAD 导出，让上层能把真实上限告诉手机端 —— 客户端此前是自己写死一个
// 6MB 的预算，与这里的 8MB 只靠注释关联，改一处另一处会静默失配。
module.exports = { WsServer, WsConnection, MAX_PAYLOAD, HB_INTERVAL_MS, HB_MAX_MISSED };
