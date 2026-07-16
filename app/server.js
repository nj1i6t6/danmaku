'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { createDatabase } = require('./db');
const protection = require('./protection');
const { StableRateLimiter } = require('./protection/rateLimiter');
const { createBarrageMessage, resolveReportedMessageId } = require('./message');
const { isAllowedOrigin, isTauriOrigin, parseExtensionOrigins } = require('./origins');
const { RoomStore } = require('./rooms/store');
const { RoomRuntime } = require('./rooms/runtime');
const { AccessGuard, BoundedWindow } = require('./rooms/access-guard');
const { RoomError, fail } = require('./rooms/errors');
const { hashSecret } = require('./rooms/credentials');
const { normalizeAddress, isLoopback, resolveClientIp } = require('./network-identity');
const { NicknameChangeGuard } = require('./nickname-change-guard');

const GLOBAL_MAX_CONNECTIONS = 2000;
const OWNER_FAILURE_LIMIT = 20;
const OWNER_OPERATION_LIMIT = 20;
const BARRAGE_MAX_LENGTH = 100;
const BARRAGE_MAX_BYTES = BARRAGE_MAX_LENGTH * 4;

function success(data = {}) { return { ok: true, ...data }; }
function errorScope(code) {
  if (['NOT_CONNECTED', 'ACK_TIMEOUT'].includes(code)) return 'connection';
  if (['ROOM_BUSY', 'QUEUE_FULL', 'QUEUE_EXPIRED', 'NOT_IN_ROOM', 'ROOM_FULL', 'ROOM_NOT_FOUND'].includes(code)) return 'room';
  if (['RATE_LIMITED', 'MUTED', 'PASSWORD_REQUIRED', 'INVALID_PASSWORD', 'CONTENT_REJECTED', 'VALIDATION_ERROR', 'FORBIDDEN', 'CREATE_LIMITED', 'REPORT_DUPLICATE'].includes(code)) return 'user';
  return 'global';
}
function failure(error) {
  const code = error instanceof RoomError ? error.code : 'ROOM_BUSY';
  const message = error instanceof RoomError ? error.message.replace(/^\w+:\s*/, '') : 'server operation failed';
  return { ok: false, error: { code, scope: errorScope(code), message, ...(error.details || {}) } };
}
function externalRoom(room) {
  if (!room) return room;
  const { roomId, isSystem, ...safe } = room;
  return safe;
}
function clientIp(socket, trustCloudflareProxy) {
  return resolveClientIp({
    remoteAddress: socket.handshake.address,
    headers: socket.handshake.headers,
    trustCloudflareProxy,
  });
}
function assertPayload(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('VALIDATION_ERROR', 'payload must be an object');
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) fail('VALIDATION_ERROR', `unsupported field: ${key}`);
}
function requireCode(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) fail('VALIDATION_ERROR', 'roomCode must be eight digits');
  return value;
}
function listKnownHttpEntryPoints(publicRoot) {
  const entryPoints = new Set(['/', '/healthz']);
  const walk = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = `${prefix}/${item.name}`;
      if (item.isDirectory()) walk(path.join(dir, item.name), relativePath);
      else if (item.isFile()) entryPoints.add(relativePath);
    }
  };
  walk(publicRoot, '');
  return entryPoints;
}
function createServer({
  dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'reports.db'),
  port = Number(process.env.PORT || 3000),
  logger = console,
  now = Date.now,
  accessGuardOptions = {},
  trustCloudflareProxy = process.env.TRUST_CLOUDFLARE_PROXY === '1',
  enforceHttps = process.env.ENFORCE_HTTPS === '1',
  publicOrigin = process.env.PUBLIC_ORIGIN || '',
  extensionOrigins = parseExtensionOrigins(process.env.EXTENSION_ORIGINS || ''),
  allowDevelopmentOrigins = process.env.ALLOW_DEV_ORIGINS === '1',
  maxConnectionsPerIp = Number(process.env.MAX_CONNECTIONS_PER_IP || 100),
} = {}) {
  if (!Number.isInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1 || maxConnectionsPerIp > 10_000) {
    throw new TypeError('MAX_CONNECTIONS_PER_IP must be an integer between 1 and 10000');
  }
  let canonicalPublicOrigin = null;
  if (enforceHttps) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new TypeError('PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment');
    }
    canonicalPublicOrigin = parsed.origin;
  }
  const database = createDatabase(dbPath);
  const store = new RoomStore({ database: database.db, now });
  const app = express();
  const httpServer = http.createServer(app);
  const knownHttpEntryPoints = listKnownHttpEntryPoints(path.join(__dirname, 'public'));
  const configuredExtensionOrigins = extensionOrigins instanceof Set
    ? extensionOrigins
    : new Set(extensionOrigins);
  const accessGuard = new AccessGuard({ now, maxEntries: 10_000, ...accessGuardOptions });
  const personalLimiter = new StableRateLimiter({ now, maxEntries: 10_000 });
  const nicknameGuard = new NicknameChangeGuard({ now, maxEntries: 10_000 });
  const ownerFailureLimiter = new BoundedWindow({
    limit: OWNER_FAILURE_LIMIT, windowMs: 60_000, now, maxEntries: 10_000,
  });
  const ownerOperationLimiter = new BoundedWindow({
    limit: OWNER_OPERATION_LIMIT, windowMs: 60_000, now, maxEntries: 10_000,
  });
  const reportLimiter = new BoundedWindow({ limit: 3, windowMs: 60_000, now, maxEntries: 10_000 });
  const globalReportLimiter = new BoundedWindow({ limit: 300, windowMs: 60_000, now, maxEntries: 1 });
  let totalConnections = 0;
  const activeConnectionsByIp = new Map();
  let listening = false;
  let shuttingDown = false;
  let activeCommands = 0;
  let closePromise = null;
  const commandDrainWaiters = new Set();

  function finishCommand() {
    activeCommands = Math.max(0, activeCommands - 1);
    if (activeCommands !== 0) return;
    for (const resolve of commandDrainWaiters) resolve();
    commandDrainWaiters.clear();
  }

  function waitForCommandDrain() {
    if (activeCommands === 0) return Promise.resolve();
    return new Promise((resolve) => commandDrainWaiters.add(resolve));
  }

  function requireNickname(value) {
    const checked = protection.checkNickname(typeof value === 'string' ? value : '');
    if (!checked.valid) fail('CONTENT_REJECTED', checked.reason || 'nickname is not allowed', { scope: 'nickname' });
    return checked.cleaned || '匿名';
  }

  function trustedForwardedProto(req) {
    if (!trustCloudflareProxy) return null;
    const peer = normalizeAddress(req.socket?.remoteAddress);
    if (!peer || !isLoopback(peer)) return null;
    const raw = req.headers['x-forwarded-proto'];
    if (typeof raw !== 'string' || raw.includes(',')) return null;
    const protocol = raw.trim().toLowerCase();
    return protocol === 'http' || protocol === 'https' ? protocol : null;
  }

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const forwardedProto = trustedForwardedProto(req);
    if (enforceHttps && forwardedProto === 'http') {
      return res.redirect(308, new URL(req.originalUrl, canonicalPublicOrigin).toString());
    }
    if (enforceHttps && forwardedProto === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    const origin = req.headers.origin;
    const effectivePort = httpServer.address()?.port || port;
    if (origin && isAllowedOrigin(origin, effectivePort, configuredExtensionOrigins, allowDevelopmentOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!knownHttpEntryPoints.has(req.path)) return next();
      return res.status(204).end();
    }
    next();
  });
  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((req, res) => res.status(404).json({ error: { code: 'ROOM_NOT_FOUND', message: 'not found' } }));
  app.use((error, req, res, next) => {
    logger.error('[http-error]', error.message);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: { code: 'ROOM_BUSY', message: 'server operation failed' } });
  });

  const io = new Server(httpServer, {
    maxHttpBufferSize: 64 * 1024,
    allowRequest(req, callback) {
      if (enforceHttps && trustedForwardedProto(req) === 'http') {
        callback('HTTPS required', false);
        return;
      }
      const sourceIp = resolveClientIp({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        trustCloudflareProxy,
      });
      if ((activeConnectionsByIp.get(sourceIp) || 0) >= maxConnectionsPerIp) {
        callback('connection source capacity reached', false);
        return;
      }
      const effectivePort = httpServer.address()?.port || port;
      callback(null, isAllowedOrigin(req.headers.origin, effectivePort, configuredExtensionOrigins, allowDevelopmentOrigins));
    },
    cors: {
      origin(origin, callback) {
        const effectivePort = httpServer.address()?.port || port;
        callback(null, !origin || isAllowedOrigin(origin, effectivePort, configuredExtensionOrigins, allowDevelopmentOrigins));
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });
  const runtime = new RoomRuntime({ io, store, now });
  runtime.start();

  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin || '';
    const usesExtensionOrigin = configuredExtensionOrigins.has(origin);
    const claimsExtensionPlatform = socket.handshake.auth?.platform === 'extension';
    if (usesExtensionOrigin !== claimsExtensionPlatform) {
      next(new Error('extension platform and Origin must match'));
      return;
    }
    next();
  });

  io.on('connection', (socket) => {
    if (shuttingDown) {
      socket.emit('connection-refused', { error: { code: 'ROOM_BUSY', message: 'server is shutting down' } });
      socket.disconnect(true);
      return;
    }
    totalConnections += 1;
    if (totalConnections > GLOBAL_MAX_CONNECTIONS) {
      totalConnections -= 1;
      socket.emit('connection-refused', { error: { code: 'ROOM_BUSY', message: 'connection capacity reached' } });
      socket.disconnect(true);
      return;
    }
    const connectionIp = clientIp(socket, trustCloudflareProxy);
    activeConnectionsByIp.set(connectionIp, (activeConnectionsByIp.get(connectionIp) || 0) + 1);
    socket.data.connectionIp = connectionIp;
    const auth = socket.handshake.auth || {};
    const rawClientId = auth.clientId ?? socket.handshake.query.clientId ?? socket.handshake.query.client_id;
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
    const origin = socket.handshake.headers.origin || '';
    const platform = isTauriOrigin(origin)
      ? 'windows'
      : (['android', 'windows', 'extension'].includes(auth.platform) ? auth.platform : 'windows');
    const validClient = clientId.length > 0 && clientId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(clientId);
    socket.data.clientId = clientId;
    socket.data.platform = platform;
    socket.data.connectedAt = now();

    function command(event, handler) {
      socket.on(event, async (payload, callback) => {
        if (typeof callback !== 'function') return;
        if (shuttingDown) {
          callback(failure(new RoomError('ROOM_BUSY', 'server is shutting down')));
          return;
        }
        activeCommands += 1;
        try {
          if (!validClient) fail('NOT_CONNECTED', 'valid stable clientId is required');
          callback(success(await handler(payload || {})));
        } catch (error) {
          if (!(error instanceof RoomError)) logger.error(`[socket-error:${event}]`, error.message);
          callback(failure(error));
        } finally {
          finishCommand();
        }
      });
    }

    command('room-create', async (payload) => {
      assertPayload(payload, ['name', 'visibility', 'password', 'retentionDays']);
      const created = await store.createRoom(payload, {
        clientId,
        ip: clientIp(socket, trustCloudflareProxy),
      });
      const joined = runtime.join(socket, created.room.roomCode, clientId);
      return {
        room: { ...roomForSocket(created.room), onlineCount: joined.count, count: joined.count },
        recentMessages: joined.recentMessages,
        ownerCredential: created.ownerCredential,
      };
    });

    function accessCheck() {
      const result = accessGuard.allowLookup(clientId, clientIp(socket, trustCloudflareProxy));
      if (!result.allowed) fail('RATE_LIMITED', 'lookup/join limit exceeded', { retryAfterMs: result.retryAfterMs });
    }

    function roomForSocket(room) {
      return externalRoom(room);
    }

    command('room-default', (payload) => {
      assertPayload(payload, []);
      return { room: roomForSocket(store.getDefaultRoom()) };
    });

    command('room-lookup', (payload) => {
      assertPayload(payload, ['roomCode']);
      accessCheck();
      const roomCode = requireCode(payload.roomCode);
      runtime.lazyExpire(roomCode);
      const room = store.lookup(roomCode, runtime.count(roomCode));
      if (!room) fail('ROOM_NOT_FOUND', 'room not found');
      return { room: roomForSocket(room) };
    });

    command('room-list-public', (payload) => {
      assertPayload(payload, ['query', 'page', 'pageSize']);
      runtime.expireRooms();
      const page = store.listPublic({ ...payload, onlineCounts: runtime.onlineCounts() });
      return {
        data: page.items.map(roomForSocket),
        rooms: page.items.map(roomForSocket),
        pagination: {
          page: page.page,
          pageSize: page.pageSize,
          total: page.total,
          totalPages: Math.max(1, Math.ceil(page.total / page.pageSize)),
        },
      };
    });

    command('join-room', async (payload) => {
      assertPayload(payload, ['roomCode', 'password']);
      accessCheck();
      const roomCode = requireCode(payload.roomCode);
      runtime.lazyExpire(roomCode);
      const room = store.lookup(roomCode, runtime.count(roomCode));
      if (!room) fail('ROOM_NOT_FOUND', 'room not found');
      if (room.onlineCount >= room.capacity) fail('ROOM_FULL', 'room is full');
      if (room.passwordRequired) {
        const allowed = accessGuard.passwordAllowed(clientId, clientIp(socket, trustCloudflareProxy), roomCode);
        if (!allowed.allowed) fail('RATE_LIMITED', 'password attempts locked', { retryAfterMs: allowed.retryAfterMs });
        if (typeof payload.password !== 'string' || payload.password.length === 0) fail('PASSWORD_REQUIRED', 'password required');
        if (Array.from(payload.password).length > 64) fail('INVALID_PASSWORD', 'invalid password');
        const passwordValid = await store.verifyPassword(roomCode, payload.password);
        if (!store.lookup(roomCode, runtime.count(roomCode))) fail('ROOM_NOT_FOUND', 'room not found');
        if (!passwordValid) {
          const attempt = accessGuard.recordPasswordFailure(clientId, clientIp(socket, trustCloudflareProxy), roomCode);
          if (!attempt.allowed) fail('RATE_LIMITED', 'password attempts locked', { retryAfterMs: attempt.retryAfterMs });
          fail('INVALID_PASSWORD', 'invalid password');
        }
        accessGuard.recordPasswordSuccess(clientId, clientIp(socket, trustCloudflareProxy), roomCode);
      }
      const joined = runtime.join(socket, roomCode, clientId);
      return { room: { ...roomForSocket(room), onlineCount: joined.count, count: joined.count }, recentMessages: joined.recentMessages };
    });

    command('leave-room', (payload) => {
      assertPayload(payload, []);
      if (!runtime.leave(socket)) fail('NOT_IN_ROOM', 'not in a room');
      return {};
    });

    function authorizeOwner(roomCode, supplied) {
      const credential = typeof supplied === 'string' ? supplied : null;
      if (!credential || !store.isOwner(roomCode, credential)) {
        const failureRate = ownerFailureLimiter.hit(connectionIp);
        if (!failureRate.allowed) {
          fail('RATE_LIMITED', 'owner credential attempts exceeded', { retryAfterMs: failureRate.retryAfterMs });
        }
        fail('FORBIDDEN', credential ? 'invalid owner credential' : 'owner credential required');
      }
      const ownerHash = hashSecret(credential);
      const operationRate = ownerOperationLimiter.hit(`${ownerHash.toString('base64url')}\0${roomCode}`);
      if (!operationRate.allowed) {
        fail('RATE_LIMITED', 'owner operation limit exceeded', { retryAfterMs: operationRate.retryAfterMs });
      }
      return ownerHash;
    }

    command('room-update', async (payload) => {
      assertPayload(payload, ['roomCode', 'changes', 'ownerCredential', 'name', 'visibility', 'password', 'passwordAction']);
      const roomCode = requireCode(payload.roomCode);
      if (payload.changes !== undefined && ['name', 'visibility', 'password', 'passwordAction'].some((key) => payload[key] !== undefined)) {
        fail('VALIDATION_ERROR', 'use either changes or direct update fields');
      }
      if (payload.password !== undefined && payload.passwordAction !== undefined) {
        fail('VALIDATION_ERROR', 'use either password or passwordAction');
      }
      const changes = payload.changes === undefined
        ? Object.fromEntries(['name', 'visibility', 'password'].filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]))
        : payload.changes;
      if (payload.passwordAction !== undefined) {
        const action = payload.passwordAction;
        if (!action || typeof action !== 'object' || Array.isArray(action) || !['set', 'remove'].includes(action.type)) {
          fail('VALIDATION_ERROR', 'invalid passwordAction');
        }
        const actionKeys = Object.keys(action);
        if (action.type === 'remove') {
          if (actionKeys.length !== 1) fail('VALIDATION_ERROR', 'invalid passwordAction');
          changes.password = null;
        } else {
          if (actionKeys.length !== 2 || !Object.hasOwn(action, 'password') || typeof action.password !== 'string' || action.password.length === 0) {
            fail('VALIDATION_ERROR', 'invalid passwordAction');
          }
          changes.password = action.password;
        }
      }
      const ownerHash = authorizeOwner(roomCode, payload.ownerCredential);
      const room = await store.updateRoomByOwnerHash(roomCode, changes, ownerHash);
      return { room: roomForSocket(room) };
    });

    command('room-delete', (payload) => {
      assertPayload(payload, ['roomCode', 'ownerCredential']);
      const roomCode = requireCode(payload.roomCode);
      const ownerHash = authorizeOwner(roomCode, payload.ownerCredential);
      store.deleteRoomByOwnerHash(roomCode, ownerHash);
      runtime.delete(roomCode);
      return {};
    });

    command('nickname-change', (payload) => {
      assertPayload(payload, ['nickname']);
      const nickname = requireNickname(payload.nickname);
      const changed = nicknameGuard.change(clientId, nickname);
      if (!changed.allowed) {
        fail('RATE_LIMITED', 'nickname can only be changed once per Taipei day', {
          scope: 'nickname', retryAfterMs: changed.retryAfterMs,
        });
      }
      return { nickname: changed.nickname, changeDate: changed.changeDate };
    });

    command('barrage', (payload) => {
      assertPayload(payload, ['text', 'nickname', 'color']);
      if (!runtime.socketRooms.has(socket.id)) fail('NOT_IN_ROOM', 'not in a room');
      if (typeof payload.text !== 'string') fail('VALIDATION_ERROR', 'message must be 1-100 characters');
      const normalizedText = protection.normalize(payload.text);
      if (!normalizedText || Array.from(normalizedText).length > BARRAGE_MAX_LENGTH || Buffer.byteLength(normalizedText, 'utf8') > BARRAGE_MAX_BYTES) {
        fail('VALIDATION_ERROR', 'message must be 1-100 characters');
      }
      const nickname = requireNickname(payload.nickname);
      if (!nicknameGuard.observe(clientId, nickname).allowed) {
        fail('VALIDATION_ERROR', 'change nickname in settings before sending', { scope: 'nickname' });
      }
      const rate = personalLimiter.check(clientId);
      if (!rate.allowed) fail(rate.code, 'personal message limit exceeded', { retryAfterMs: rate.retryAfterMs });
      const roomCode = runtime.socketRooms.get(socket.id);
      const checked = protection.checkBarrage({
        socket, text: payload.text, nickname, color: payload.color || '#e6edf3',
        room: roomCode, sessionState: { sessionId: socket.id, clientId, connectedAt: socket.data.connectedAt }, skipRateLimit: true,
      });
      if (checked.action === 'reject') fail('CONTENT_REJECTED', checked.reason || 'content rejected');
      if (checked.action === 'cooldown') fail('RATE_LIMITED', checked.reason || 'rate limited', { retryAfterMs: checked.cooldownMs });
      const message = createBarrageMessage({ text: checked.cleanedText, nickname: checked.cleanedNickname, color: checked.cleanedColor, sessionId: socket.id });
      if (checked.action === 'shadow_drop') return { status: 'sent', messageId: message.messageId };
      const queued = runtime.submit(socket, clientId, { messageId: message.messageId, message });
      if (!queued) fail('NOT_IN_ROOM', 'not in a room');
      return {
        status: queued.state,
        messageId: message.messageId,
        ...(queued.position ? { position: queued.position } : {}),
        ...(queued.estimatedWaitMs !== undefined ? { estimatedWaitMs: queued.estimatedWaitMs } : {}),
      };
    });

    command('report', (payload) => {
      assertPayload(payload, ['messageId', 'targetSessionId', 'targetClientId', 'messageText', 'reason']);
      const roomCode = runtime.socketRooms.get(socket.id);
      if (!roomCode) fail('NOT_IN_ROOM', 'not in a room');
      const history = runtime.history(roomCode);
      const messageId = resolveReportedMessageId(history, payload);
      const message = history.find((entry) => entry.messageId === messageId);
      if (!message) fail('VALIDATION_ERROR', 'reported message is not in recent history');
      const reporterIp = clientIp(socket, trustCloudflareProxy);
      const reporterIpHash = hashSecret(reporterIp);
      if (database.hasReport(messageId, reporterIpHash)) fail('REPORT_DUPLICATE', 'this message was already reported from this network');
      const rate = reportLimiter.hit(reporterIp);
      if (!rate.allowed) fail('RATE_LIMITED', 'report limit exceeded', { retryAfterMs: rate.retryAfterMs });
      const globalRate = globalReportLimiter.hit('global');
      if (!globalRate.allowed) fail('RATE_LIMITED', 'global report limit exceeded', { retryAfterMs: globalRate.retryAfterMs });
      const reason = typeof payload.reason === 'string'
        ? payload.reason.normalize('NFKC').replace(/[<>\u0000-\u001F\u007F]/gu, '').trim().slice(0, 200)
        : '';
      const inserted = database.insertReport({
        reporter_session_id: hashSecret(socket.id).toString('base64url'),
        reporter_client_id: hashSecret(clientId).toString('base64url'),
        reporter_ip_hash: reporterIpHash,
        target_session_id: hashSecret(message.sessionId || '').toString('base64url'),
        target_client_id: '',
        room_code: roomCode,
        message_id: messageId,
        message_text: message.text,
        reason,
      });
      if (inserted.full) fail('ROOM_BUSY', 'report store is full');
      if (inserted.duplicate) fail('REPORT_DUPLICATE', 'this message was already reported from this network');
      if (database.countDistinctReportersForMessage(messageId) >= 3) {
        io.to(roomCode).emit('hide-message', { roomCode, messageId, reason: 'multiple reports' });
      }
      return { reportId: inserted.id };
    });

    socket.on('disconnect', () => {
      totalConnections = Math.max(0, totalConnections - 1);
      const currentIpConnections = activeConnectionsByIp.get(connectionIp) || 0;
      if (currentIpConnections <= 1) activeConnectionsByIp.delete(connectionIp);
      else activeConnectionsByIp.set(connectionIp, currentIpConnections - 1);
      runtime.leave(socket);
      personalLimiter.disconnect(clientId);
    });
  });

  const maintenance = setInterval(() => {
    accessGuard.cleanup(); personalLimiter.cleanup(); ownerFailureLimiter.cleanup(); ownerOperationLimiter.cleanup(); reportLimiter.cleanup(); globalReportLimiter.cleanup();
  }, 60_000);
  maintenance.unref?.();

  return {
    app, io, httpServer, store, runtime, nicknameGuard,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => {
          listening = true;
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      if (closePromise) return closePromise;
      shuttingDown = true;
      clearInterval(maintenance);
      closePromise = waitForCommandDrain().then(() => {
        runtime.stop();
        return new Promise((resolve) => {
          io.close(() => {
            const finish = () => { database.close(); listening = false; resolve(); };
            if (listening) httpServer.close(finish); else finish();
          });
        });
      });
      return closePromise;
    },
  };
}

if (require.main === module) {
  const service = createServer();
  service.listen().then((address) => console.log(`[server] listening on ${address.address}:${address.port}, socket cap ${GLOBAL_MAX_CONNECTIONS}`));
  const shutdown = () => service.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createServer, GLOBAL_MAX_CONNECTIONS, success, failure };
