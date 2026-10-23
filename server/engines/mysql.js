'use strict';

/**
 * MySQL / MariaDB engine adapter.
 */

const mysql = require('mysql2/promise');

const CONNECT_TIMEOUT_MS = 10000;

function buildConfig(conn) {
  return {
    host: conn.host,
    port: Number(conn.port) || 3306,
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Keep big numbers and dates readable in JSON rather than silently lossy.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  };
}

async function withConn(conn, fn) {
  const client = await mysql.createConnection(buildConfig(conn));
  try {
    return await fn(client);
  } finally {
    client.end().catch(() => {});
  }
}

async function testConnection(conn) {
  return withConn(conn, async (client) => {
    const [rows] = await client.query('SELECT VERSION() AS version, DATABASE() AS db');
    return { ok: true, version: rows[0].version, database: rows[0].db };
  });
}

async function listDatabases(conn) {
  return withConn(conn, async (client) => {
    const [rows] = await client.query('SHOW DATABASES');
    return rows
      .map((r) => Object.values(r)[0])
      .filter((d) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
  });
}

async function listTables(conn) {
  return withConn(conn, async (client) => {
    const [rows] = await client.query(
      `SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type, table_rows AS approx_rows
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys')
       ORDER BY table_schema, table_name`
    );
    return rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      type: r.type === 'VIEW' ? 'view' : 'table',
      approxRows: r.approx_rows === null ? null : Number(r.approx_rows),
    }));
  });
}

async function getColumns(conn, schema, table) {
  return withConn(conn, async (client) => {
    const [rows] = await client.query(
      `SELECT column_name, column_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [schema, table]
    );
    return rows.map((r) => ({
      name: r.column_name ?? r.COLUMN_NAME,
      type: r.column_type ?? r.COLUMN_TYPE,
      nullable: (r.is_nullable ?? r.IS_NULLABLE) === 'YES',
      default: r.column_default ?? r.COLUMN_DEFAULT,
    }));
  });
}

async function getRows(conn, schema, table, { limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  return withConn(conn, async (client) => {
    // LIMIT/OFFSET cannot be bound as placeholders in MySQL prepared
    // statements, so they are numerically coerced above instead.
    const [rows, fields] = await client.query(`SELECT * FROM ${ident} LIMIT ${lim} OFFSET ${off}`);
    const [countRows] = await client.query(`SELECT COUNT(*) AS c FROM ${ident}`);
    return {
      columns: fields.map((f) => f.name),
      rows,
      total: Number(countRows[0].c),
      limit: lim,
      offset: off,
    };
  });
}

async function runQuery(conn, sql) {
  return withConn(conn, async (client) => {
    const started = Date.now();
    const [result, fields] = await client.query(sql);
    const duration = Date.now() - started;

    // DML returns an OkPacket rather than an array of rows.
    if (!Array.isArray(result)) {
      return [
        {
          columns: [],
          rows: [],
          rowCount: result.affectedRows ?? 0,
          command: 'OK',
          durationMs: duration,
        },
      ];
    }
    return [
      {
        columns: (fields || []).map((f) => f.name),
        rows: result,
        rowCount: result.length,
        command: 'SELECT',
        durationMs: duration,
      },
    ];
  });
}

function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

module.exports = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
  supportsSql: true,
  testConnection,
  listDatabases,
  listTables,
  getColumns,
  getRows,
  runQuery,
};
