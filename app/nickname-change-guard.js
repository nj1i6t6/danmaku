'use strict';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiParts(timestamp) {
  const shifted = new Date(timestamp + TAIPEI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function taipeiDate(timestamp = Date.now()) {
  const { year, month, day } = taipeiParts(timestamp);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function msUntilNextTaipeiDay(timestamp = Date.now()) {
  const { year, month, day } = taipeiParts(timestamp);
  const nextTaipeiMidnightUtc = Date.UTC(year, month, day + 1) - TAIPEI_OFFSET_MS;
  return Math.max(1, nextTaipeiMidnightUtc - timestamp);
}

class NicknameChangeGuard {
  constructor({ now = Date.now, maxEntries = 10_000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError('maxEntries must be a positive integer');
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get size() { return this.entries.size; }
  has(clientId) { return this.entries.has(clientId); }

  touch(clientId, entry) {
    entry.touchedAt = this.now();
    this.entries.delete(clientId);
    this.entries.set(clientId, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  observe(clientId, nickname) {
    const existing = this.entries.get(clientId);
    if (!existing) {
      this.touch(clientId, { nickname, changeDate: null, touchedAt: this.now() });
      return { allowed: true, initialized: true, nickname };
    }
    this.touch(clientId, existing);
    return { allowed: existing.nickname === nickname, initialized: false, nickname: existing.nickname };
  }

  change(clientId, nickname) {
    const timestamp = this.now();
    const date = taipeiDate(timestamp);
    const existing = this.entries.get(clientId);
    if (existing?.nickname === nickname) {
      this.touch(clientId, existing);
      return { allowed: true, changed: false, nickname, changeDate: existing.changeDate };
    }
    if (existing?.changeDate === date) {
      this.touch(clientId, existing);
      return {
        allowed: false,
        changed: false,
        nickname: existing.nickname,
        changeDate: existing.changeDate,
        retryAfterMs: msUntilNextTaipeiDay(timestamp),
      };
    }
    const updated = { nickname, changeDate: date, touchedAt: timestamp };
    this.touch(clientId, updated);
    return { allowed: true, changed: true, nickname, changeDate: date };
  }
}

module.exports = { NicknameChangeGuard, taipeiDate, msUntilNextTaipeiDay };
