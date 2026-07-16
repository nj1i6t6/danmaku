'use strict';

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const MAX_REPORT_ROWS = 100_000;

function ensureColumn(database, name, definition) {
  const columns = database.prepare('PRAGMA table_info(reports)').all();
  if (!columns.some((column) => column.name === name)) database.exec(`ALTER TABLE reports ADD COLUMN ${definition}`);
}

function createDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_session_id TEXT NOT NULL,
      reporter_client_id TEXT NOT NULL,
      reporter_ip_hash BLOB,
      target_session_id TEXT NOT NULL,
      target_client_id TEXT,
      room_code TEXT,
      message_id TEXT,
      message_text TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_reporter_session ON reports(reporter_session_id);
  `);
  ensureColumn(database, 'reporter_ip_hash', 'reporter_ip_hash BLOB');
  ensureColumn(database, 'room_code', 'room_code TEXT');
  ensureColumn(database, 'message_id', 'message_id TEXT');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_message_reporter_ip
      ON reports(message_id, reporter_ip_hash);
    CREATE INDEX IF NOT EXISTS idx_reports_message_id ON reports(message_id);
    CREATE TABLE IF NOT EXISTS report_metadata (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  const existingCount = database.prepare('SELECT count(*) AS count FROM reports').get().count;
  database.prepare("INSERT OR IGNORE INTO report_metadata(key,value) VALUES ('report_count',?)").run(existingCount);

  const insert = database.prepare(`INSERT OR IGNORE INTO reports
    (reporter_session_id,reporter_client_id,reporter_ip_hash,target_session_id,target_client_id,room_code,message_id,message_text,reason)
    VALUES (@reporter_session_id,@reporter_client_id,@reporter_ip_hash,@target_session_id,@target_client_id,@room_code,@message_id,@message_text,@reason)`);
  const getMeta = database.prepare("SELECT value FROM report_metadata WHERE key='report_count'");
  const incrementMeta = database.prepare("UPDATE report_metadata SET value=value+1 WHERE key='report_count'");
  const hasReport = database.prepare('SELECT 1 FROM reports WHERE message_id=? AND reporter_ip_hash=? LIMIT 1');
  const countDistinctReporters = database.prepare('SELECT count(DISTINCT reporter_ip_hash) AS count FROM reports WHERE message_id=?');
  const insertReport = database.transaction((params) => {
    if (getMeta.get().value >= MAX_REPORT_ROWS) return { inserted: false, full: true };
    const result = insert.run(params);
    if (!result.changes) return { inserted: false, duplicate: true };
    incrementMeta.run();
    return { inserted: true, id: Number(result.lastInsertRowid) };
  });
  return {
    db: database,
    insertReport,
    hasReport(messageId, reporterIpHash) { return Boolean(hasReport.get(messageId, reporterIpHash)); },
    countDistinctReportersForMessage(messageId) { return countDistinctReporters.get(messageId).count; },
    close() { if (database.open) database.close(); },
  };
}

let defaultDatabase;
function getDefaultDatabase() {
  if (!defaultDatabase) defaultDatabase = createDatabase(process.env.DB_PATH || path.join(__dirname, 'data', 'reports.db'));
  return defaultDatabase;
}

module.exports = {
  MAX_REPORT_ROWS,
  createDatabase,
  getDefaultDatabase,
  insertReport(params) { return getDefaultDatabase().insertReport(params); },
  hasReport(messageId, reporterIpHash) { return getDefaultDatabase().hasReport(messageId, reporterIpHash); },
  countDistinctReportersForMessage(messageId) { return getDefaultDatabase().countDistinctReportersForMessage(messageId); },
  get db() { return getDefaultDatabase().db; },
};
