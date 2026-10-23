# 🐝 Hivekeeper

A web-based database client for **PostgreSQL**, **MySQL/MariaDB**, **MongoDB** and **Redis**.

Built to browse databases that live on a private Docker network — like those hosted by
[Dokploy](https://dokploy.com) — without publishing a database port to the internet.

> Inspired by the excellent [Beekeeper Studio](https://www.beekeeperstudio.io).
> Hivekeeper is an independent project, **not a fork**, and shares no source code with it.
> See [NOTICE.md](./NOTICE.md) for full credit.

---

## Why this exists

Most database GUIs are desktop apps, so reaching a containerised database means exposing it
on a public port. Hivekeeper runs **as a container on the same private network as your
databases**, so it reaches them over internal DNS on their unexposed ports. The only thing
publicly reachable is the Hivekeeper UI itself.

## Design: no accounts, no server-side state

Hivekeeper has **no user accounts and no database of its own**.

- Connections are stored in your **browser's `localStorage`** — they never touch the server disk
- Each request carries the credentials it needs, uses them, and discards them
- Different people using the same deployment naturally see **different connection lists**,
  because the list lives in their own browser
- Clearing site data deletes every saved connection

This makes the server completely stateless: no migrations, no volume to back up, no
credential store to leak.

> **Security note:** `localStorage` is readable by JavaScript on the same origin. Serve
> Hivekeeper over HTTPS on a host you control, and set `HIVEKEEPER_PASSWORD` if it is
> reachable by anyone you don't trust. Treat it like a phpMyAdmin deployment: convenient,
> and worth putting behind a gate.

## Features

- Browse tables/collections with pagination and live row counts
- Inspect columns and types (MongoDB types are inferred by sampling documents)
- Run SQL, MongoDB JSON queries, or read-only Redis commands
- Dark UI, keyboard-friendly (`Ctrl`/`Cmd` + `Enter` runs a query)
- Single container, ~100MB, no build step for the frontend

### Engine support

| Engine | Browse | Query syntax |
|---|---|---|
| PostgreSQL | tables + views | SQL |
| MySQL / MariaDB | tables + views | SQL |
| MongoDB | collections | JSON — `{"find":"users","filter":{},"limit":20}` |
| Redis | keys grouped by type | Read-only commands — `GET foo`, `HGETALL user:1` |

Redis is intentionally restricted to read-only commands — `FLUSHALL`, `SET`, `DEL` and
`CONFIG SET` are rejected. This is a browsing tool, not a shell.

## Quick start

```bash
git clone https://github.com/mohith-labs/hivekeeper.git
cd hivekeeper
npm install
npm start
```

Open <http://localhost:3000>.

### Docker

```bash
docker build -t hivekeeper .
docker run -p 3000:3000 -e HIVEKEEPER_PASSWORD=choose-a-password hivekeeper
```

### Docker Compose (Dokploy / Traefik)

```yaml
services:
  hivekeeper:
    image: ghcr.io/mohith-labs/hivekeeper:latest
    restart: always
    environment:
      HIVEKEEPER_PASSWORD: ${HIVEKEEPER_PASSWORD}
    networks: [dokploy-network]   # same network as your databases

networks:
  dokploy-network:
    external: true
```

Note there is no `ports:` mapping — the reverse proxy reaches the container directly, so
nothing is published on the host's public IP.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `HIVEKEEPER_PASSWORD` | _unset_ | If set, all `/api/*` routes require this password. **Leave unset only on a trusted network.** |

## Connecting to a Dokploy database

1. In Dokploy, open the database service and find **Internal Credentials**
2. Use the **internal host** and the **container port** (5432 / 3306 / 27017 / 6379) —
   not any external port mapping
3. For databases bundled inside a compose stack, the hostname is
   `<appName>-<service>-1`, e.g. `paperclip-bto1lj-db-1`

## API

All routes are `POST` and take `{ "connection": {...} }` unless noted.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe, lists supported engines |
| `GET /api/engines` | Engine metadata (labels, default ports, query hints) |
| `GET /api/auth/required` | Whether this deployment requires a password |
| `POST /api/auth/check` | Validate a password |
| `POST /api/test` | Test a connection, returns server version |
| `POST /api/databases` | List databases |
| `POST /api/tables` | List tables/collections |
| `POST /api/columns` | Columns for `{schema, table}` |
| `POST /api/rows` | Paginated rows for `{schema, table, limit, offset}` |
| `POST /api/query` | Run `{sql}` |

## Tests

The smoke tests run the full read path against real databases. Any engine whose `*_HOST`
is unset is skipped rather than failed.

```bash
PG_HOST=localhost PG_PASSWORD=secret \
REDIS_HOST=localhost REDIS_PASSWORD=secret \
npm test
```

They also assert the negative cases: wrong passwords must be rejected, the row limit must
cap at 1000, and Redis write commands must be blocked.

## Contributing

Issues and pull requests are welcome at
<https://github.com/mohith-labs/hivekeeper>.

## Licence

[MIT](./LICENSE) — see [NOTICE.md](./NOTICE.md) for attribution and the licensing rationale.
