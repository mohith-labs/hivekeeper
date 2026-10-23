'use strict';

/**
 * Redis engine adapter.
 *
 * Redis has no tables, so the model is mapped as:
 *   database -> numbered logical DB (0-15)
 *   table    -> key type grouping (string, hash, list, set, zset, stream)
 *   rows     -> keys and their values
 */

const { createClient } = require('redis');

const CONNECT_TIMEOUT_MS = 10000;
const SCAN_COUNT = 500;
const MAX_SCAN_KEYS = 5000;

function buildUrl(conn) {
  if (conn.uri) return conn.uri;
  const user = conn.user ? encodeURIComponent(conn.user) : '';
  const pass = conn.password ? encodeURIComponent(conn.password) : '';
  const auth = pass ? `${user}:${pass}@` : '';
  const port = Number(conn.port) || 6379;
  const db = conn.database ? `/${conn.database}` : '';
  return `redis://${auth}${conn.host}:${port}${db}`;
}

async function withClient(conn, fn) {
  const client = createClient({
    url: buildUrl(conn),
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
  });
  // Without a handler, a connection failure raises an unhandled 'error' event
  // and takes the whole process down.
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.quit().catch(() => {});
  }
}

async function testConnection(conn) {
  return withClient(conn, async (client) => {
    const info = await client.info('server');
    const match = /redis_version:([^\r\n]+)/.exec(info);
    return {
      ok: true,
      version: match ? match[1].trim() : 'unknown',
      database: String(conn.database ?? 0),
    };
  });
}

async function listDatabases(conn) {
  return withClient(conn, async (client) => {
    // CONFIG GET is frequently disabled on managed Redis; fall back to the
    // standard 16 logical databases.
    try {
      const cfg = await client.configGet('databases');
      const n = Number(cfg.databases) || 16;
      return Array.from({ length: n }, (_, i) => String(i));
    } catch {
      return Array.from({ length: 16 }, (_, i) => String(i));
    }
  });
}

async function scanKeys(client, pattern = '*') {
  const keys = [];
  let cursor = '0';
  do {
    const res = await client.scan(cursor, { MATCH: pattern, COUNT: SCAN_COUNT });
    cursor = String(res.cursor);
    keys.push(...res.keys);
    if (keys.length >= MAX_SCAN_KEYS) break;
  } while (cursor !== '0');
  return keys;
}

async function listTables(conn) {
  return withClient(conn, async (client) => {
    const keys = await scanKeys(client);
    const groups = new Map();
    for (const key of keys) {
      const type = await client.type(key);
      groups.set(type, (groups.get(type) || 0) + 1);
    }
    return [...groups.entries()].map(([type, count]) => ({
      schema: String(conn.database ?? 0),
      name: type,
      type: 'table',
      approxRows: count,
    }));
  });
}

async function getColumns() {
  return [
    { name: 'key', type: 'string', nullable: false, default: null },
    { name: 'type', type: 'string', nullable: false, default: null },
    { name: 'ttl', type: 'integer', nullable: true, default: null },
    { name: 'value', type: 'any', nullable: true, default: null },
  ];
}

async function readValue(client, key, type) {
  switch (type) {
    case 'string':
      return await client.get(key);
    case 'hash':
      return JSON.stringify(await client.hGetAll(key));
    case 'list':
      return JSON.stringify(await client.lRange(key, 0, 99));
    case 'set':
      return JSON.stringify(await client.sMembers(key));
    case 'zset':
      return JSON.stringify(await client.zRangeWithScores(key, 0, 99));
    case 'stream':
      return JSON.stringify(await client.xRange(key, '-', '+', { COUNT: 50 }));
    default:
      return null;
  }
}

/**
 * `table` is the key type to filter by ('string', 'hash', ...).
 */
async function getRows(conn, _schema, table, { limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);

  return withClient(conn, async (client) => {
    const allKeys = await scanKeys(client);
    const matching = [];
    for (const key of allKeys) {
      const type = await client.type(key);
      if (!table || type === table) matching.push({ key, type });
    }

    const page = matching.slice(off, off + lim);
    const rows = [];
    for (const { key, type } of page) {
      rows.push({
        key,
        type,
        ttl: await client.ttl(key),
        value: await readValue(client, key, type),
      });
    }
    return {
      columns: ['key', 'type', 'ttl', 'value'],
      rows,
      total: matching.length,
      limit: lim,
      offset: off,
    };
  });
}

/**
 * Accepts a raw Redis command line, e.g. `GET mykey` or `HGETALL user:1`.
 * Restricted to read-only commands - this is a browsing tool, not a shell.
 */
const READ_ONLY_COMMANDS = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'KEYS', 'SCAN',
  'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HMGET', 'HSCAN',
  'LRANGE', 'LLEN', 'LINDEX',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SSCAN',
  'ZRANGE', 'ZCARD', 'ZSCORE', 'ZCOUNT', 'ZRANGEBYSCORE', 'ZSCAN',
  'XRANGE', 'XLEN', 'XINFO',
  'INFO', 'DBSIZE', 'PING', 'RANDOMKEY', 'OBJECT', 'MEMORY',
]);

async function runQuery(conn, raw) {
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Empty command');

  const cmd = parts[0].toUpperCase();
  if (!READ_ONLY_COMMANDS.has(cmd)) {
    throw new Error(
      `Command "${cmd}" is not allowed. Hivekeeper permits read-only Redis commands only.`
    );
  }

  return withClient(conn, async (client) => {
    const started = Date.now();
    const result = await client.sendCommand(parts);
    return [
      {
        columns: ['result'],
        rows: [{ result: formatResult(result) }],
        rowCount: 1,
        command: cmd,
        durationMs: Date.now() - started,
      },
    ];
  });
}

function formatResult(result) {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return JSON.stringify(result);
  if (typeof result === 'object') return JSON.stringify(result);
  return String(result);
}

module.exports = {
  id: 'redis',
  label: 'Redis',
  defaultPort: 6379,
  supportsSql: false,
  queryHint: 'GET mykey   |   HGETALL user:1   |   LRANGE mylist 0 10',
  testConnection,
  listDatabases,
  listTables,
  getColumns,
  getRows,
  runQuery,
};
