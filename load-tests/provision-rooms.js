'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const appRequire = createRequire(path.resolve(__dirname, '../app/package.json'));
const { io } = appRequire('socket.io-client');

function emitAck(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function connect(baseUrl, clientId) {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    auth: { clientId },
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

async function main() {
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4399';
  const customRooms = Number.parseInt(process.env.CUSTOM_ROOMS || '10', 10);
  if (!Number.isInteger(customRooms) || customRooms < 0 || customRooms > 20) {
    throw new Error('CUSTOM_ROOMS must be an integer from 0 to 20');
  }
  const runId = randomUUID().slice(0, 8);
  const sockets = [];
  const rooms = [];

  try {
    let creatorIndex = -1;
    for (let roomIndex = 0; roomIndex < customRooms; roomIndex += 1) {
      if (roomIndex % 3 === 0) {
        creatorIndex += 1;
        sockets.push(await connect(baseUrl, `load-provision-${runId}-${creatorIndex}`));
      }
      const socket = sockets[sockets.length - 1];
      const response = await emitAck(socket, 'room-create', {
        name: `壓測房 ${runId}-${String(roomIndex + 1).padStart(2, '0')}`,
        visibility: 'unlisted',
        retentionDays: 1,
      });
      if (!response?.ok || !/^\d{8}$/.test(String(response.room?.roomCode || response.room?.code || ''))) {
        throw new Error(`room-create failed at ${roomIndex}: ${JSON.stringify(response)}`);
      }
      rooms.push({
        roomCode: String(response.room.roomCode || response.room.code),
        roomName: response.room.roomName || response.room.name,
        capacity: response.room.capacity,
      });
    }
    process.stdout.write(`${JSON.stringify({ runId, baseUrl, rooms }, null, 2)}\n`);
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
