// 全局唯一的 WebSocket，断线自动重连
class WS {
  constructor() {
    this.listeners = new Map();
    this.queue = [];
    this.connected = false;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.sock = new WebSocket(`${proto}://${location.host}/ws`);
    this.sock.onopen = () => {
      this.connected = true;
      const q = this.queue.splice(0);
      for (const m of q) this.sock.send(m);
      this.emit('_open', {});
    };
    this.sock.onclose = () => {
      this.connected = false;
      this.emit('_close', {});
      setTimeout(() => this.connect(), 2000);
    };
    this.sock.onerror = () => {};
    this.sock.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.emit(msg.type, msg);
      } catch {}
    };
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, msg) {
    this.listeners.get(type)?.forEach((fn) => fn(msg));
  }

  send(obj) {
    const s = JSON.stringify(obj);
    if (this.connected && this.sock.readyState === 1) this.sock.send(s);
    else if (this.queue.length < 500) this.queue.push(s);
  }
}

export const ws = new WS();
