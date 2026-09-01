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
- Docker deployment behind Caddy on `api.ozserver.org`

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` and make the local `DATABASE_URL` use the same password. Docker Compose
   overrides the API container's database hostname to `postgres` automatically.
3. Start PostgreSQL with `docker compose up -d postgres`.
4. Run `npm install`, `npm run db:migrate`, then `npm run dataset:sync`.
5. Start the API with `npm run dev`.

`GET /health` checks both the API process and its database connection.

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
