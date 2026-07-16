export function serverUrlForBuild(rawValue) {
  const value = rawValue || 'http://127.0.0.1:3999';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('DANMAKU_SERVER_URL must be an HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('DANMAKU_SERVER_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment');
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']).has(parsed.hostname);
  if (!loopback && parsed.protocol !== 'https:') {
    throw new TypeError('remote DANMAKU_SERVER_URL must use HTTPS; HTTP is allowed only for loopback');
  }
  return parsed.origin;
}
