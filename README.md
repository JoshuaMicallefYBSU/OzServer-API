# OzServer API

The standalone API for OzServer. It replaces the API previously embedded in the website while
preserving the plugin-facing `/api/v1` contract.

## Architecture

- Fastify and TypeScript on Node.js 22
- PostgreSQL for persistent state
- A single transactional advisory lock around sector mutations, preventing overlapping sector
  groups from being claimed concurrently
- Compact JSONB storage for flight data, avoiding a schema migration for every vatSys FDR field
- Direct, short-lived caching of the VATSIM data and AFV transceiver feeds
- ATIS published straight to this API by the vatSys ATIS plugin and served publicly at
  `GET /api/v1/vatsim/atis` - see [ATIS](#atis)
- Docker deployment behind Caddy on `api.ozserver.org`

## ATIS

The vatSys ATIS plugin publishes an airport's ATIS directly - one record per airport, created or
replaced in full:

```
PUT /api/v1/vatsim/atis/YSSY
{
  "icao": "YSSY",
  "callsign": "YSSY_ATIS",
  "atis_letter": "N",
  "type": "atis",
  "frequency": "126.250",
  "issued": "2026-11-12T09:14:00Z",
  "content": { "APCH": "EXP INST APCH", "RWY": "34L FOR ARRS, RWY 34R FOR DEPS", "WIND": "320/15-25", "QNH": "1013" },
  "changed": ["WIND", "QNH"],
  "controller": { "callsign": "SY_TWR", "cid": "1234567" },
  "client": { "name": "vatSys ATIS Plugin", "version": "4.3" }
}
```

Sending the same body twice is harmless: `201` the first time, `200` after, and the stored record
is the same either way. `type` is `atis` for a sectioned broadcast, or `zulu` for the free text a
closed tower leaves running - a `zulu` sends its broadcast text as `content` (a plain string) and
its `changed` is always empty. `changed` is the sections this letter changed, i.e. the ones vatSys
marks with a leading `+`; a name this API does not serve (`MODE`, `TIME_CHECK`) is dropped rather
than refused, in `content` and in `changed` alike. `controller` is required, `frequency` and
`client` are optional, and anything else in the body is ignored. A body whose `icao` disagrees with
the URL, or that carries no ATIS letter, is answered `422` and stores nothing.

There is no way to withdraw an ATIS: a record leaves only by being replaced, or by ageing out
`NETWORK_ATIS_RETAIN_MINUTES` (90) after the last `PUT` that carried it - the sweep in
`maintenance.ts`. A controller signing off does not unsay the broadcast they were making, and the
letter they last published stays the best answer to "what is YSSY running" for a while afterwards.
The clock runs from when the broadcast last reached this API rather than from `issued`, so a
plugin that re-publishes an unchanged ATIS keeps it alive for as long as it is on the air, while
one that publishes only on change has 90 minutes from each broadcast.

Published ATIS are drawn on the public map: `GET /api/v1/map/atis` returns them placed at their
airport (so an airport the dataset has no position for is served by `/vatsim/atis` but cannot be
mapped), alongside the vatSys ATIS an OzServer controller's own client pushed with `POST /atis`
for any airport with no published one. Both come back in the same shape - a published ATIS wins
where an airport has both.

Read it back with `GET /api/v1/vatsim/atis` (every airport, by ICAO) or
`GET /api/v1/vatsim/atis/:icao` (one airport, or `null`). The response is the broadcast as
published, with `issued` as a `DDHHMM` day-time group (`120914`, always UTC) and `content`
carrying every section in ATIS-editor order - `null` for each one not broadcast. `controller` and
`client` are stored but never served: the broadcast is public, who is running it is not. The `PUT`
response is the one exception, since it answers the plugin that just sent them. Either endpoint
changing publishes the existing `atis` server-sent event.

Publishing is open to anything that can reach the API unless `ATIS_TOKEN` is set, in which case
`PUT` requires it as `Authorization: Bearer <token>` (or `?token=`).

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` and make the local `DATABASE_URL` use the same password. Docker Compose
   overrides the API container's database hostname to `postgres` automatically.
3. Start PostgreSQL with `docker compose up -d postgres`.
4. Run `npm install`, `npm run db:migrate`, then `npm run dataset:sync`.
5. Start the API with `npm run dev`.

`GET /health` checks both the API process and its database connection.

## Tests

`npm test` runs the unit tests anywhere. The route tests in `src/api.integration.test.ts` need a
Postgres they are allowed to wipe, and are skipped without one:

    docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
    TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test

CI runs them on every push and pull request.

## Production

Use one Linux account per administrator and individual SSH public keys. Do not share private keys.
Copy `Caddyfile.example` into the VPS Caddy configuration, point `api.ozserver.org` at the VPS, and
run migrations before replacing the API container during a deployment.

Inside the production container, use `npm run db:migrate:prod` and
`npm run dataset:sync:prod`; these run the compiled commands without development dependencies.

Back up PostgreSQL off-server daily. A database backup is required before every schema migration.

## Migration order

1. Deploy this API to a staging hostname.
2. Run the schema migration and dataset sync.
3. Exercise sector claiming, transfer, reconnect, FDR, ATIS and map behavior with staging builds.
4. Point `api.ozserver.org` at the VPS.
5. Deploy the website API-base change.
6. Release a plugin build whose default base URL is `https://api.ozserver.org`.
7. Keep the old `/api/v1` routes available temporarily for older plugin builds.

## Production deployment

The API runs on an OVHcloud VPS (Ubuntu 24.04) at `/opt/ozserver-api`, behind Caddy on
`api.ozserver.org`. Postgres is on a Docker network marked `internal`, so it is reachable only
from the API container; the API itself is additionally on an `egress` network because it must
reach the VATSIM datafeed and the vatSys dataset repositories.

Deployment is pull-based. A systemd timer runs `ozserver-deploy` every two minutes, which
redeploys only when `origin/main` has moved:

    git fetch -> rebuild -> up -d -> db:migrate:prod -> health check

The container also applies pending migrations itself before it starts serving (see the Dockerfile's
`CMD`), so new code never runs against the old schema; the script's own `db:migrate:prod` then finds
nothing left to do.

The health check gates the deploy. If `/health` does not report `"database":"ok"` within about a
minute, the script resets to the previous commit and rebuilds, so a bad push leaves the previous
version serving rather than taking the API down. `flock` prevents overlapping runs.

Operational commands on the VPS:

    sudo systemctl start ozserver-deploy      # deploy now instead of waiting for the timer
    journalctl -u ozserver-deploy -n 50       # what the last deploys did
    docker compose logs api --tail 100

`.env` lives outside git at `/opt/ozserver-api/.env` (mode 0600) and is preserved across
deployments, since `git reset --hard` does not touch ignored files.

Postgres is dumped daily by the `ozserver-db-backup` timer to `/var/backups/ozserver`, keeping 14
days. These dumps are on the same host, so they cover operator error, not loss of the VPS - an
off-server copy is still required.
