'use strict';

class DeliveryLatencyTracker {
  constructor() {
    this.acceptedAt = new Map();
    this.observedAt = new Map();
    this.latencies = [];
  }

  accepted(messageId, submittedAt) {
    if (!messageId || !Number.isFinite(submittedAt)) return;
    const observedAt = this.observedAt.get(messageId);
    if (Number.isFinite(observedAt)) {
      this.observedAt.delete(messageId);
      this.latencies.push(Math.max(0, observedAt - submittedAt));
      return;
    }
    this.acceptedAt.set(messageId, submittedAt);
  }

  observed(messageId, observedAt) {
    if (!messageId || !Number.isFinite(observedAt)) return;
    const submittedAt = this.acceptedAt.get(messageId);
    if (Number.isFinite(submittedAt)) {
      this.acceptedAt.delete(messageId);
      this.latencies.push(Math.max(0, observedAt - submittedAt));
      return;
    }
    this.observedAt.set(messageId, observedAt);
  }

  get pendingCount() {
    return this.acceptedAt.size + this.observedAt.size;
  }
}

module.exports = { DeliveryLatencyTracker };
