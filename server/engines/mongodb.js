'use strict';

/**
 * MongoDB engine adapter.
 *
 * Collections are mapped onto the same "table" vocabulary the SQL engines use
 * so the frontend can stay generic. Schema is absent in Mongo, so the schema
 * field carries the database name instead.
 */

const { MongoClient } = require('mongodb');

const CONNECT_TIMEOUT_MS = 10000;

function buildUri(conn) {
  if (conn.uri) return conn.uri;
  const user = conn.user ? encodeURIComponent(conn.user) : null;
  const pass = conn.password ? encodeURIComponent(conn.password) : '';
  const auth = user ? `${user}:${pass}@` : '';
  const port = Number(conn.port) || 27017;
  return `mongodb://${auth}${conn.host}:${port}`;
}

async function withClient(conn, fn) {
  const client = new MongoClient(buildUri(conn), {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close().catch(() => {});
  }
}

async function testConnection(conn) {
  return withClient(conn, async (client) => {
    const info = await client.db('admin').command({ buildInfo: 1 });
    return { ok: true, version: info.version, database: conn.database || null };
  });
}

async function listDatabases(conn) {
  return withClient(conn, async (client) => {
    const res = await client.db('admin').admin().listDatabases();
    return res.databases.map((d) => d.name);
  });
}

async function listTables(conn) {
  return withClient(conn, async (client) => {
    const dbNames = conn.database
      ? [conn.database]
      : (await client.db('admin').admin().listDatabases()).databases
          .map((d) => d.name)
          .filter((n) => !['admin', 'local', 'config'].includes(n));

    const out = [];
    for (const dbName of dbNames) {
      const db = client.db(dbName);
      const cols = await db.listCollections().toArray();
      for (const c of cols) {
        let approxRows = null;
        try {
          approxRows = await db.collection(c.name).estimatedDocumentCount();
        } catch {
          // A view has no document count; leave it null.
        }
        out.push({
          schema: dbName,
          name: c.name,
          type: c.type === 'view' ? 'view' : 'table',
          approxRows,
        });
      }
    }
    return out;
  });
}

/**
 * Mongo is schemaless, so columns are inferred by sampling documents and
 * unioning their top-level keys.
 */
async function getColumns(conn, dbName, collection) {
  return withClient(conn, async (client) => {
    const docs = await client
      .db(dbName)
      .collection(collection)
      .find({})
      .limit(100)
      .toArray();

    const keys = new Map();
    for (const doc of docs) {
      for (const [k, v] of Object.entries(doc)) {
        if (!keys.has(k)) keys.set(k, new Set());
        keys.get(k).add(v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
      }
    }
    return [...keys.entries()].map(([name, types]) => ({
      name,
      type: [...types].join(' | '),
      nullable: true,
      default: null,
    }));
  });
}

async function getRows(conn, dbName, collection, { limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);

  return withClient(conn, async (client) => {
    const col = client.db(dbName).collection(collection);
    const docs = await col.find({}).skip(off).limit(lim).toArray();
    const total = await col.estimatedDocumentCount();

    const columns = [];
    for (const d of docs) {
      for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
    }
    return {
      columns,
      rows: docs.map(serializeDoc),
      total,
      limit: lim,
      offset: off,
    };
  });
}

/**
 * Mongo values (ObjectId, Date, Binary) are not JSON-safe. Convert them to
 * display strings so the frontend never receives `{}` for an ObjectId.
 */
function serializeDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    out[k] = serializeValue(v);
  }
  return out;
}

function serializeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v._bsontype === 'ObjectId' || v.constructor?.name === 'ObjectId') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(serializeValue);
    if (v._bsontype) return v.toString();
    return JSON.stringify(v);
  }
  return v;
}

/**
 * Run a read-only Mongo command expressed as JSON, e.g.
 *   {"find": "users", "filter": {"age": {"$gt": 30}}, "limit": 10}
 */
async function runQuery(conn, raw) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      'MongoDB queries must be JSON, e.g. {"find":"users","filter":{},"limit":10}'
    );
  }
  const dbName = spec.db || conn.database;
  if (!dbName) throw new Error('No database selected for this MongoDB query');
  if (!spec.find && !spec.aggregate) {
    throw new Error('Query must include "find" or "aggregate"');
  }

  return withClient(conn, async (client) => {
    const started = Date.now();
    const db = client.db(dbName);
    let docs;

    if (spec.aggregate) {
      docs = await db
        .collection(spec.aggregate)
        .aggregate(spec.pipeline || [])
        .limit(Math.min(spec.limit || 100, 1000))
        .toArray();
    } else {
      docs = await db
        .collection(spec.find)
        .find(spec.filter || {})
        .sort(spec.sort || {})
        .skip(spec.skip || 0)
        .limit(Math.min(spec.limit || 100, 1000))
        .toArray();
    }

    const columns = [];
    for (const d of docs) {
      for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
    }
    return [
      {
        columns,
        rows: docs.map(serializeDoc),
        rowCount: docs.length,
        command: spec.aggregate ? 'AGGREGATE' : 'FIND',
        durationMs: Date.now() - started,
      },
    ];
  });
}

module.exports = {
  id: 'mongodb',
  label: 'MongoDB',
  defaultPort: 27017,
  supportsSql: false,
  queryHint: '{"find": "collection_name", "filter": {}, "limit": 20}',
  testConnection,
  listDatabases,
  listTables,
  getColumns,
  getRows,
  runQuery,
};
