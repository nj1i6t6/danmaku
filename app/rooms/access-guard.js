'use strict';

class BoundedWindow {
  constructor({ limit, windowMs, now, maxEntries }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }
  hit(key) {
    const at = this.now();
    let times = (this.entries.get(key) || []).filter((time) => at - time < this.windowMs);
    const allowed = times.length < this.limit;
    if (allowed) times.push(at);
    this.entries.delete(key);
    this.entries.set(key, times);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return { allowed, retryAfterMs: allowed ? 0 : Math.max(1, this.windowMs - (at - times[0])) };
  }
  cleanup() {
    const at = this.now();
    for (const [key, times] of this.entries) {
      const active = times.filter((time) => at - time < this.windowMs);
      if (active.length) this.entries.set(key, active); else this.entries.delete(key);
    }
  }
}

class AccessGuard {
  constructor({ now = Date.now, maxEntries = 10_000, lookupLimit = 30 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.clientLookups = new BoundedWindow({ limit: lookupLimit, windowMs: 60_000, now, maxEntries });
    this.ipLookups = new BoundedWindow({ limit: lookupLimit, windowMs: 60_000, now, maxEntries });
    this.password = new Map();
  }

  allowLookup(clientId, ip) {
    const client = this.clientLookups.hit(clientId);
    const address = this.ipLookups.hit(ip);
    if (!client.allowed || !address.allowed) return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: Math.max(client.retryAfterMs, address.retryAfterMs) };
    return { allowed: true };
  }

  _passwordKey(clientId, ip, roomCode) { return `${clientId}\0${ip}\0${roomCode}`; }

  passwordAllowed(clientId, ip, roomCode) {
    const key = this._passwordKey(clientId, ip, roomCode);
    const entry = this.password.get(key);
    if (!entry) return { allowed: true };
    if (entry.lockedUntil > this.now()) return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: entry.lockedUntil - this.now() };
    if (entry.lockedUntil) this.password.delete(key);
    return { allowed: true };
  }

  recordPasswordFailure(clientId, ip, roomCode) {
    const key = this._passwordKey(clientId, ip, roomCode);
    const at = this.now();
    let entry = this.password.get(key) || { failures: [], lockedUntil: 0 };
    if (entry.lockedUntil > at) return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: entry.lockedUntil - at };
    entry.failures = entry.failures.filter((time) => at - time < 600_000);
    entry.failures.push(at);
    if (entry.failures.length >= 5) {
      entry.lockedUntil = at + 900_000;
      this.password.delete(key); this.password.set(key, entry);
      return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: 900_000 };
    }
    this.password.delete(key); this.password.set(key, entry);
    while (this.password.size > this.maxEntries) this.password.delete(this.password.keys().next().value);
    return { allowed: true };
  }

  recordPasswordSuccess(clientId, ip, roomCode) { this.password.delete(this._passwordKey(clientId, ip, roomCode)); }

  cleanup() {
    this.clientLookups.cleanup(); this.ipLookups.cleanup();
    const at = this.now();
    for (const [key, entry] of this.password) {
      entry.failures = entry.failures.filter((time) => at - time < 600_000);
      if (entry.lockedUntil <= at && entry.failures.length === 0) this.password.delete(key);
    }
  }
}

module.exports = { AccessGuard, BoundedWindow };
