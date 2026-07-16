'use strict';

const path = require('node:path');
const { createServer } = require('../app/server');

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('DB_PATH is required for the isolated load-test server');

const port = Number.parseInt(process.env.PORT || '4399', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 3999) {
  throw new Error('PORT must be a valid non-production port');
}

const service = createServer({
  dbPath: path.resolve(dbPath),
  port,
  accessGuardOptions: { lookupLimit: 10_000 },
  maxConnectionsPerIp: 10_000,
});

service.listen().then((address) => {
  console.log(`[load-test-server] listening on ${address.address}:${address.port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  service.close().then(() => process.exit(0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
