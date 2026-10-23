'use strict';

/**
 * Postgres engine adapter.
 *
 * Each call opens a short-lived client, does its work, and closes. The server
 * is deliberately stateless: credentials arrive with the request and are never
 * persisted server-side.
 */

const { Client } = require('pg');

const CONNECT_TIMEOUT_MS = 10000;
const STATEMENT_TIMEOUT_MS = 30000;

function buildConfig(conn) {
  return {
    host: conn.host,
    port: Number(conn.port) || 5432,
    user: conn.user,
    password: conn.password,
    database: conn.database || 'postgres',
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'hivekeeper',
  };
}

async function withClient(conn, fn) {
  const client = new Client(buildConfig(conn));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.end().catch(() => {});
  }
}

async function testConnection(conn) {
  return withClient(conn, async (client) => {
    const res = await client.query('SELECT version() AS version, current_database() AS database');
    return {
      ok: true,
      version: res.rows[0].version,
      database: res.rows[0].database,
    };
  });
}

async function listDatabases(conn) {
  return withClient(conn, async (client) => {
    const res = await client.query(
      `SELECT datname FROM pg_database
       WHERE datistemplate = false
       ORDER BY datname`
    );
    return res.rows.map((r) => r.datname);
  });
}

async function listTables(conn) {
  return withClient(conn, async (client) => {
    const res = await client.query(
      `SELECT schemaname AS schema, relname AS name, n_live_tup AS approx_rows
       FROM pg_stat_user_tables
       ORDER BY schemaname, relname`
    );
    // Include views too - pg_stat_user_tables only covers tables.
    const views = await client.query(
      `SELECT schemaname AS schema, viewname AS name
       FROM pg_views
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       ORDER BY schemaname, viewname`
    );
    return [
      ...res.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        type: 'table',
        approxRows: Number(r.approx_rows),
      })),
      ...views.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        type: 'view',
        approxRows: null,
      })),
    ];
  });
}

async function getColumns(conn, schema, table) {
  return withClient(conn, async (client) => {
    const res = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    );
    return res.rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      default: r.column_default,
    }));
  });
}

/**
 * Read rows with pagination. Identifiers are quoted rather than interpolated
 * raw, and limit/offset are coerced to numbers, so a crafted table name cannot
 * break out of the query.
 */
async function getRows(conn, schema, table, { limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  return withClient(conn, async (client) => {
    const res = await client.query(`SELECT * FROM ${ident} LIMIT $1 OFFSET $2`, [lim, off]);
    const count = await client.query(`SELECT COUNT(*) AS c FROM ${ident}`);
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows,
      total: Number(count.rows[0].c),
      limit: lim,
      offset: off,
    };
  });
}

async function runQuery(conn, sql) {
  return withClient(conn, async (client) => {
    const started = Date.now();
    const res = await client.query(sql);
    const results = Array.isArray(res) ? res : [res];
    return results.map((r) => ({
      columns: (r.fields || []).map((f) => f.name),
      rows: r.rows || [],
      rowCount: r.rowCount,
      command: r.command,
      durationMs: Date.now() - started,
    }));
  });
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = {
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  supportsSql: true,
  testConnection,
  listDatabases,
  listTables,
  getColumns,
  getRows,
  runQuery,
};
