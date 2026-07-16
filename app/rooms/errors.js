'use strict';

class RoomError extends Error {
  constructor(code, message = code, details) {
    super(`${code}: ${message}`);
    this.name = 'RoomError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new RoomError(code, message, details);
}

module.exports = { RoomError, fail };
