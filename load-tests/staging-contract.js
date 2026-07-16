'use strict';

const assert = require('node:assert/strict');

const FORBIDDEN_SECRET_FIELDS = [
  'password_hash',
  'passwordHash',
  'password_salt',
  'passwordSalt',
  'owner_hash',
  'ownerHash',
  'owner_token_hash',
  'ownerTokenHash',
  'ownerCredential',
  'roomId',
];

function assertNoSecrets(response, { allowTopLevelOwnerCredential = false } = {}) {
  assert.equal(Boolean(response) && typeof response === 'object' && !Array.isArray(response), true, 'response must be an object');
  let inspected = response;
  let expectedCredential = null;
  if (allowTopLevelOwnerCredential) {
    assert.equal(typeof response.ownerCredential, 'string', 'create ACK must include a top-level ownerCredential');
    expectedCredential = response.ownerCredential;
    inspected = { ...response };
    delete inspected.ownerCredential;
  }
  const text = JSON.stringify(inspected);
  for (const forbidden of FORBIDDEN_SECRET_FIELDS) {
    assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
  }
  if (expectedCredential) {
    assert.equal(text.includes(expectedCredential), false, 'owner credential leaked outside the create ACK top level');
  }
}

async function cleanupCreatedRooms(createdRooms, emitAck) {
  const failures = [];
  for (const room of [...createdRooms].reverse()) {
    if (!room.socket?.connected) {
      failures.push({ roomCode: room.roomCode, code: 'SOCKET_DISCONNECTED' });
      continue;
    }
    const payload = {
      roomCode: room.roomCode,
      ...(room.ownerCredential ? { ownerCredential: room.ownerCredential } : {}),
    };
    try {
      const response = await emitAck(room.socket, 'room-delete', payload);
      if (!response?.ok) failures.push({
        roomCode: room.roomCode,
        code: response?.error?.code || 'CLEANUP_REJECTED',
      });
    } catch {
      failures.push({ roomCode: room.roomCode, code: 'CLEANUP_FAILED' });
    }
  }
  return failures;
}

module.exports = { assertNoSecrets, cleanupCreatedRooms };
