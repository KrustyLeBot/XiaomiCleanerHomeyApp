'use strict';

// Minimal miIO client: UDP handshake + encrypted JSON calls.
// Standalone so it can run outside Homey (plain Node) for probing.

const dgram = require('dgram');
const Packet = require('miio/lib/packet');

const PORT = 54321;

class MiioClient {
  constructor(address, token, { timeout = 5000 } = {}) {
    this.address = address;
    this.token = token;
    this.timeout = timeout;
    this.packet = new Packet();
    this.packet.token = Buffer.from(token, 'hex');
    this.socket = dgram.createSocket('udp4');
    this.id = 0;
    this.pending = new Map();

    this.socket.on('message', (msg) => this._onMessage(msg));
  }

  _onMessage(msg) {
    this.packet.raw = msg;
    const data = this.packet.data;
    if (data === null) {
      // Handshake reply carries no payload.
      if (this.handshakeResolve) {
        this.handshakeResolve();
        this.handshakeResolve = null;
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data.toString('utf8').replace(/\0+$/, ''));
    } catch (err) {
      return;
    }

    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    this.pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (parsed.error) entry.reject(new Error(JSON.stringify(parsed.error)));
    else entry.resolve(parsed.result);
  }

  _send(buf) {
    this.socket.send(buf, 0, buf.length, PORT, this.address);
  }

  // Handshake syncs the device stamp, required before any command.
  handshake() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Handshake timeout to ${this.address}`)),
        this.timeout
      );
      this.handshakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.packet.handshake();
      this._send(this.packet.raw);
    });
  }

  async call(method, params = []) {
    if (this.packet.needsHandshake) await this.handshake();

    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout calling ${method}`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.packet.data = Buffer.from(payload, 'utf8');
      this._send(this.packet.raw);
    });
  }

  destroy() {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.socket.close();
  }
}

module.exports = MiioClient;
