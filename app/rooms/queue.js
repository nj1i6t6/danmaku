'use strict';

const { fail } = require('./errors');

class TokenBucket {
  constructor({ rate, burst, now = Date.now }) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.updatedAt = now();
  }

  refill() {
    const at = this.now();
    const elapsed = Math.max(0, at - this.updatedAt);
    this.updatedAt = at;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate / 1000);
  }

  consume(cost = 1) {
    this.refill();
    if (cost < 0 || this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

class DeliveryBudget extends TokenBucket {
  constructor({ rate = 20_000, burst = 40_000, now = Date.now } = {}) {
    super({ rate, burst, now });
  }
}

class FairRoomQueue {
  constructor({ rate, burst, maxSize, ttlMs = 5000, now = Date.now, budget = null, deliver, status = () => {} }) {
    if (!(rate > 0) || burst < 0 || !(maxSize > 0) || ttlMs > 5000) throw new TypeError('invalid queue limits');
    this.rate = rate;
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.now = now;
    this.bucket = new TokenBucket({ rate, burst, now });
    this.budget = budget;
    this.deliver = deliver;
    this.status = status;
    this.clients = new Map();
    this.order = [];
    this.size = 0;
  }

  _canDeliver(item) {
    this.bucket.refill();
    const cost = Math.max(0, typeof item.recipientCount === 'function' ? item.recipientCount() : (item.recipients || 0));
    this.budget?.refill();
    if (this.bucket.tokens < 1 || (this.budget && this.budget.tokens < cost)) return false;
    this.bucket.tokens -= 1;
    if (this.budget) this.budget.tokens -= cost;
    return true;
  }

  _deliver(item, queued) {
    this.deliver(item);
    if (queued) this.status(item, 'delivered');
  }

  _estimatedWaitMs() {
    this.bucket.refill();
    return Math.max(0, this.size + 1 - this.bucket.tokens) / this.rate * 1000;
  }

  submit(item) {
    if (!item || typeof item.clientId !== 'string' || !item.clientId || typeof item.messageId !== 'string') {
      fail('VALIDATION_ERROR', 'invalid queue item');
    }
    this.expire();
    if (this.clients.has(item.clientId)) fail('ROOM_BUSY', 'client already has a queued message');
    if (this.size === 0 && this._canDeliver(item)) {
      this._deliver(item, false);
      return { state: 'sent', messageId: item.messageId };
    }
    if (this.size >= this.maxSize) fail('QUEUE_FULL', 'room queue is full');
    const estimate = this._estimatedWaitMs();
    if (estimate > this.ttlMs) fail('ROOM_BUSY', 'estimated wait exceeds five seconds', { estimatedWaitMs: Math.ceil(estimate) });
    const queued = { ...item, queuedAt: this.now(), expiresAt: this.now() + this.ttlMs };
    this.clients.set(item.clientId, queued);
    this.order.push(item.clientId);
    this.size += 1;
    return { state: 'queued', messageId: item.messageId, position: this.size, estimatedWaitMs: Math.ceil(estimate) };
  }

  _remove(clientId) {
    const item = this.clients.get(clientId);
    if (!item) return null;
    this.clients.delete(clientId);
    const index = this.order.indexOf(clientId);
    if (index >= 0) this.order.splice(index, 1);
    this.size -= 1;
    return item;
  }

  expire() {
    const at = this.now();
    let count = 0;
    for (const clientId of [...this.order]) {
      const item = this.clients.get(clientId);
      if (item && at >= item.expiresAt) {
        this._remove(clientId);
        this.status(item, 'expired');
        count += 1;
      }
    }
    return count;
  }

  drain() {
    this.expire();
    let delivered = 0;
    while (this.order.length) {
      const clientId = this.order[0];
      const item = this.clients.get(clientId);
      if (!item) { this.order.shift(); continue; }
      if (!this._canDeliver(item)) break;
      this._remove(clientId);
      this._deliver(item, true);
      delivered += 1;
    }
    return delivered;
  }

  cancelClient(clientId) {
    return this._remove(clientId) ? 1 : 0;
  }

  cancelSocket(socketId) {
    for (const clientId of this.order) {
      const item = this.clients.get(clientId);
      if (item?.socketId !== socketId) continue;
      this._remove(clientId);
      this.status(item, 'cancelled');
      return 1;
    }
    return 0;
  }

  clear(state = 'expired') {
    for (const clientId of [...this.order]) {
      const item = this._remove(clientId);
      if (item) this.status(item, state);
    }
  }
}

module.exports = { TokenBucket, DeliveryBudget, FairRoomQueue };
