'use strict';

class RingBuffer {
  constructor(maxSize = 200) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new TypeError('maxSize must be positive');
    this.maxSize = maxSize;
    this.buffer = [];
  }
  push(item) {
    if (this.buffer.length === this.maxSize) this.buffer.shift();
    this.buffer.push(item);
  }
  getAll() { return [...this.buffer]; }
  clear() { this.buffer.length = 0; }
  get size() { return this.buffer.length; }
}

module.exports = { RingBuffer };
