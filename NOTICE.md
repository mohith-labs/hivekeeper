# NOTICE

## Credit and inspiration

Hivekeeper was inspired by **[Beekeeper Studio](https://www.beekeeperstudio.io)**
([github.com/beekeeper-studio/beekeeper-studio](https://github.com/beekeeper-studio/beekeeper-studio)),
an excellent cross-platform desktop database client created by Beekeeper Studio, Inc.

If you want a mature, full-featured desktop database client, **go use Beekeeper Studio**.
It is a far more complete product than this one, it is actively maintained by people who
do this full time, and buying a license directly supports their work.

### What Hivekeeper took from Beekeeper Studio

**No source code.**

Hivekeeper is an independent, from-scratch implementation. It is **not a fork**, and it
contains no code copied, adapted, or machine-translated from the Beekeeper Studio
repository. What it borrows is conceptual: the general idea of a connection-list sidebar
beside a table browser and a query tab, which is a decades-old convention shared by most
database clients.

The database functionality here is built directly on the same widely-used open-source
drivers that most Node.js database tools use:

| Driver | License | Purpose |
|---|---|---|
| [`pg`](https://github.com/brianc/node-postgres) | MIT | PostgreSQL |
| [`mysql2`](https://github.com/sidorares/node-mysql2) | MIT | MySQL / MariaDB |
| [`mongodb`](https://github.com/mongodb/node-mongodb-native) | Apache-2.0 | MongoDB |
| [`redis`](https://github.com/redis/node-redis) | MIT | Redis |
| [`express`](https://github.com/expressjs/express) | MIT | HTTP server |

### Why Hivekeeper is MIT and not GPLv3

Beekeeper Studio is dual-licensed:

- Most of the repository is **GPLv3** (`LICENSE.md`)
- Everything under any `**/src-commercial/` directory is under a **proprietary commercial
  licence** (`LICENSE-COMMERCIAL.md`), which explicitly forbids using that code in your own
  projects

Because Hivekeeper contains **no GPLv3 code from Beekeeper Studio**, the copyleft
obligations of the GPL are not triggered, and this project is released under the MIT
licence. Had any of their GPLv3 source been copied in, this project would have had to be
GPLv3 as well.

For the avoidance of doubt, Hivekeeper deliberately contains nothing derived from
Beekeeper Studio's `src-commercial/` directories — that code is proprietary and was never
consulted during implementation.

### Trademarks

"Beekeeper Studio" is a trademark of Beekeeper Studio, Inc. Hivekeeper is not affiliated
with, endorsed by, or sponsored by Beekeeper Studio, Inc. The name "Hivekeeper" and the
bee motif are a nod of respect to the project that inspired it, not a claim of association.
