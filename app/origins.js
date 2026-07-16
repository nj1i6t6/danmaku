'use strict';

const TAURI_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);
const BASE_ALLOWED_ORIGINS = [
  ...TAURI_ORIGINS,
];
const DEVELOPMENT_ORIGINS = [
  'http://localhost',
  'http://localhost:80',
  'http://localhost:5173',
];
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

function parseExtensionOrigins(value = '') {
  if (typeof value !== 'string') throw new TypeError('EXTENSION_ORIGINS must be a string');
  if (value.trim() === '') return new Set();

  const origins = new Set();
  for (const entry of value.split(',')) {
    const origin = entry.trim();
    if (!EXTENSION_ORIGIN_PATTERN.test(origin)) {
      throw new TypeError(`invalid EXTENSION_ORIGINS entry: ${origin || '(empty)'}`);
    }
    origins.add(origin);
  }
  return origins;
}

function allowedOriginsForPort(
  port = 3000,
  extensionOrigins = new Set(),
  allowDevelopmentOrigins = process.env.ALLOW_DEV_ORIGINS === '1',
) {
  const origins = new Set(BASE_ALLOWED_ORIGINS);
  if (allowDevelopmentOrigins) {
    for (const origin of DEVELOPMENT_ORIGINS) origins.add(origin);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }
  for (const origin of extensionOrigins) {
    if (EXTENSION_ORIGIN_PATTERN.test(origin)) origins.add(origin);
  }
  return origins;
}

function isAllowedOrigin(origin, port = 3000, extensionOrigins = new Set(), allowDevelopmentOrigins) {
  return !origin || allowedOriginsForPort(port, extensionOrigins, allowDevelopmentOrigins).has(origin);
}

function isTauriOrigin(origin) {
  return TAURI_ORIGINS.has(origin);
}

function socketIoOriginForPort(port, extensionOrigins = new Set(), allowDevelopmentOrigins) {
  return (origin, callback) => {
    if (isAllowedOrigin(origin, port, extensionOrigins, allowDevelopmentOrigins)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed'));
  };
}

module.exports = {
  allowedOriginsForPort,
  isAllowedOrigin,
  isTauriOrigin,
  parseExtensionOrigins,
  socketIoOriginForPort,
};
