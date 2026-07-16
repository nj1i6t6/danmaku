export function validRoomCode(value) {
  return /^\d{8}$/.test(String(value || '').trim());
}

export function normalizeRoom(source = {}) {
  const code = String(source.roomCode ?? source.code ?? '').trim();
  if (!validRoomCode(code)) return null;
  const visibility = source.visibility === 'unlisted' ? 'unlisted' : 'public';
  const count = Math.max(0, Number(source.count) || 0);
  const capacity = Math.max(count, Number(source.capacity) || 0);
  return {
    name: String(source.name ?? source.roomName ?? ''),
    roomCode: code,
    count,
    capacity,
    requiresPassword: Boolean(source.requiresPassword),
    visibility,
    retentionDays: [1, 3, 7].includes(Number(source.retentionDays)) ? Number(source.retentionDays) : null,
    expiresAt: source.expiresAt == null ? null : String(source.expiresAt),
    ownedByClient: Boolean(source.ownedByClient),
  };
}

export function normalizeRoomList(response = {}) {
  const source = Array.isArray(response.data)
    ? response.data
    : (Array.isArray(response.rooms) ? response.rooms : []);
  return source.map(normalizeRoom).filter(Boolean);
}

export function findDefaultRoom(response = {}) {
  return normalizeRoomList(response).find((room) => (
    room.name === '預設' && room.retentionDays === null && room.capacity === 1000
  )) || null;
}

export function createJoinedRoomStore(storage, key = 'kolvid-joined-room-codes') {
  function list() {
    try {
      const parsed = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(parsed)
        ? [...new Set(parsed.map((code) => String(code)).filter(validRoomCode))]
        : [];
    } catch {
      return [];
    }
  }

  function save(codes) {
    storage.setItem(key, JSON.stringify(codes));
  }

  return {
    list,
    add(value) {
      const code = String(typeof value === 'string' ? value : value?.roomCode || '');
      if (!validRoomCode(code)) return;
      save([code, ...list().filter((item) => item !== code)]);
    },
    remove(value) {
      const code = String(value || '');
      save(list().filter((item) => item !== code));
    },
  };
}

export function createRoomTransitionGate() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    isCurrent(value) {
      return value === generation;
    },
  };
}

export function createRoomCommandQueue() {
  let tail = Promise.resolve();
  return {
    run(command) {
      if (typeof command !== 'function') throw new TypeError('room command must be a function');
      const result = tail.then(command, command);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export function roomExitAction(roomCode, currentRoomCode, defaultRoomCode) {
  if (validRoomCode(defaultRoomCode) && roomCode === defaultRoomCode) return 'block-default';
  if (roomCode === currentRoomCode) return 'switch-to-default';
  return 'remove-shortcut';
}

export function roomExpiryHint(room) {
  if (room?.expiresAt) return `預計期限：${new Date(room.expiresAt).toLocaleString()}`;
  return room?.retentionDays ? `最後活動後 ${room.retentionDays} 天到期` : '';
}
