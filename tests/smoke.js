'use strict';

/**
 * Hivekeeper smoke tests.
 *
 * Runs the full read path (test -> databases -> tables -> columns -> rows ->
 * query) against every configured engine, plus negative tests proving errors
 * surface correctly.
 *
 * Configure via env:
 *   PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE
 *   MY_HOST MY_PORT MY_USER MY_PASSWORD MY_DATABASE
 *   MONGO_HOST MONGO_PORT MONGO_USER MONGO_PASSWORD
 *   REDIS_HOST REDIS_PORT REDIS_PASSWORD
 *
 * Any engine with no *_HOST set is skipped rather than failed.
 */

const engines = {
  postgres: require('../server/engines/postgres'),
  mysql: require('../server/engines/mysql'),
  mongodb: require('../server/engines/mongodb'),
  redis: require('../server/engines/redis'),
};

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const result = await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}${result ? ` \x1b[90m${result}\x1b[0m` : ''}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
    failed++;
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testEngine(label, engine, conn, queryText) {
  console.log(`\n\x1b[1m${label}\x1b[0m`);

  await check('testConnection returns version', async () => {
    const res = await engine.testConnection(conn);
    assert(res.ok, 'ok was not true');
    assert(res.version, 'no version returned');
    return `v${String(res.version).split(' ')[0]}`;
  });

  await check('listDatabases returns array', async () => {
    const dbs = await engine.listDatabases(conn);
    assert(Array.isArray(dbs), 'not an array');
    return `${dbs.length} db(s)`;
  });

  let tables = [];
  await check('listTables returns array', async () => {
    tables = await engine.listTables(conn);
    assert(Array.isArray(tables), 'not an array');
    return `${tables.length} table(s)`;
  });

  if (tables.length > 0) {
    const t = tables[0];
    await check(`getColumns(${t.schema}.${t.name})`, async () => {
      const cols = await engine.getColumns(conn, t.schema, t.name);
      assert(Array.isArray(cols), 'not an array');
      return `${cols.length} column(s)`;
    });

    await check(`getRows(${t.schema}.${t.name})`, async () => {
      const r = await engine.getRows(conn, t.schema, t.name, { limit: 5 });
      assert(Array.isArray(r.rows), 'rows not an array');
      assert(typeof r.total === 'number', 'total not a number');
      return `${r.rows.length} row(s) of ${r.total}`;
    });

    await check('getRows respects limit cap', async () => {
      const r = await engine.getRows(conn, t.schema, t.name, { limit: 99999 });
      assert(r.limit <= 1000, `limit was ${r.limit}, expected <= 1000`);
      return `capped to ${r.limit}`;
    });
  }

  await check('runQuery returns results', async () => {
    const res = await engine.runQuery(conn, queryText);
    assert(Array.isArray(res), 'not an array');
    assert(res[0].rows !== undefined, 'no rows key');
    return `${res[0].rowCount} row(s) in ${res[0].durationMs}ms`;
  });

  await check('bad credentials are rejected', async () => {
    const bad = { ...conn, password: 'definitely-the-wrong-password-xyz' };
    try {
      await engine.testConnection(bad);
      throw new Error('SHOULD HAVE FAILED but connected');
    } catch (err) {
      if (err.message.includes('SHOULD HAVE FAILED')) throw err;
      return 'rejected as expected';
    }
  });
}

async function main() {
  console.log('\x1b[1m═══ Hivekeeper smoke tests ═══\x1b[0m');

  if (process.env.PG_HOST) {
    await testEngine('PostgreSQL', engines.postgres, {
      engine: 'postgres',
      host: process.env.PG_HOST,
      port: process.env.PG_PORT || 5432,
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE || 'postgres',
    }, 'SELECT 1 AS one, now() AS ts');
  } else {
    console.log('\n\x1b[90mPostgreSQL — skipped (PG_HOST unset)\x1b[0m');
  }

  if (process.env.MY_HOST) {
    await testEngine('MySQL', engines.mysql, {
      engine: 'mysql',
      host: process.env.MY_HOST,
      port: process.env.MY_PORT || 3306,
      user: process.env.MY_USER || 'root',
      password: process.env.MY_PASSWORD,
      database: process.env.MY_DATABASE || undefined,
    }, 'SELECT 1 AS one, NOW() AS ts');
  } else {
    console.log('\n\x1b[90mMySQL — skipped (MY_HOST unset)\x1b[0m');
  }

  if (process.env.MONGO_HOST) {
    await testEngine('MongoDB', engines.mongodb, {
      engine: 'mongodb',
      host: process.env.MONGO_HOST,
      port: process.env.MONGO_PORT || 27017,
      user: process.env.MONGO_USER,
      password: process.env.MONGO_PASSWORD,
      database: process.env.MONGO_DATABASE || undefined,
    }, '{"find":"smoke_test","limit":5,"db":"testdb"}');
  } else {
    console.log('\n\x1b[90mMongoDB — skipped (MONGO_HOST unset)\x1b[0m');
  }

  if (process.env.REDIS_HOST) {
    await testEngine('Redis', engines.redis, {
      engine: 'redis',
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      database: process.env.REDIS_DATABASE || 0,
    }, 'PING');

    // Redis-specific: the read-only command guard must hold.
    console.log('\n\x1b[1mRedis command guard\x1b[0m');
    const rconn = {
      engine: 'redis',
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
    };
    for (const cmd of ['FLUSHALL', 'SET foo bar', 'DEL mykey', 'CONFIG SET x y']) {
      await check(`blocks "${cmd.split(' ')[0]}"`, async () => {
        try {
          await engines.redis.runQuery(rconn, cmd);
          throw new Error('SHOULD HAVE BEEN BLOCKED');
        } catch (err) {
          if (err.message.includes('SHOULD HAVE BEEN BLOCKED')) throw err;
          assert(err.message.includes('not allowed'), `wrong error: ${err.message}`);
          return 'blocked';
        }
      });
    }
  } else {
    console.log('\n\x1b[90mRedis — skipped (REDIS_HOST unset)\x1b[0m');
  }

  console.log(`\n\x1b[1m═══ ${passed} passed, ${failed} failed ═══\x1b[0m`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
