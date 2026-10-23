'use strict';

/**
 * Hivekeeper server.
 *
 * Deliberately stateless: there are no user accounts and no server-side
 * connection store. The browser holds the connection list in localStorage and
 * sends the credentials it needs with each request. Nothing is written to disk.
 */

const express = require('express');
const path = require('path');

const engines = {
  postgres: require('./engines/postgres'),
  mysql: require('./engines/mysql'),
  mongodb: require('./engines/mongodb'),
  redis: require('./engines/redis'),
};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Optional gate. When HIVEKEEPER_PASSWORD is set, every /api route requires
 * `Authorization: Bearer <password>`. Left unset, the app is open - which is
 * only appropriate on a trusted network.
 */
const GATE_PASSWORD = process.env.HIVEKEEPER_PASSWORD || null;

function requireGate(req, res, next) {
  if (!GATE_PASSWORD) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== GATE_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function getEngine(conn) {
  const engine = engines[conn?.engine];
  if (!engine) {
    throw new Error(`Unknown engine: ${conn?.engine}. Supported: ${Object.keys(engines).join(', ')}`);
  }
  return engine;
}

/** Normalise driver errors into a clean JSON message. */
function handleError(res, err) {
  const message = err?.message || String(err);
  res.status(400).json({ error: message });
}

// ---------------------------------------------------------------- routes

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hivekeeper', engines: Object.keys(engines) });
});

app.get('/api/engines', requireGate, (_req, res) => {
  res.json(
    Object.values(engines).map((e) => ({
      id: e.id,
      label: e.label,
      defaultPort: e.defaultPort,
      supportsSql: e.supportsSql,
      queryHint: e.queryHint || null,
    }))
  );
});

/** Does this deployment require a password? Used by the UI before login. */
app.get('/api/auth/required', (_req, res) => {
  res.json({ required: Boolean(GATE_PASSWORD) });
});

app.post('/api/auth/check', (req, res) => {
  if (!GATE_PASSWORD) return res.json({ ok: true });
  if (req.body?.password === GATE_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/test', requireGate, async (req, res) => {
  try {
    const conn = req.body.connection;
    const result = await getEngine(conn).testConnection(conn);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/databases', requireGate, async (req, res) => {
  try {
    const conn = req.body.connection;
    res.json(await getEngine(conn).listDatabases(conn));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/tables', requireGate, async (req, res) => {
  try {
    const conn = req.body.connection;
    res.json(await getEngine(conn).listTables(conn));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/columns', requireGate, async (req, res) => {
  try {
    const { connection, schema, table } = req.body;
    res.json(await getEngine(connection).getColumns(connection, schema, table));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/rows', requireGate, async (req, res) => {
  try {
    const { connection, schema, table, limit, offset } = req.body;
    res.json(await getEngine(connection).getRows(connection, schema, table, { limit, offset }));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/query', requireGate, async (req, res) => {
  try {
    const { connection, sql } = req.body;
    if (!sql || !String(sql).trim()) throw new Error('Query is empty');
    res.json(await getEngine(connection).runQuery(connection, sql));
  } catch (err) {
    handleError(res, err);
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[hivekeeper] listening on http://${HOST}:${PORT}`);
    console.log(`[hivekeeper] auth: ${GATE_PASSWORD ? 'password required' : 'OPEN (no password set)'}`);
  });
}

module.exports = app;
