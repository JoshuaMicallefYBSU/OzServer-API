<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ozserver-logo-on-dark.png">
    <img src=".github/assets/ozserver-logo-on-light.png" alt="OzServer" width="420">
  </picture>
</p>

# OzServer API

[![CI](https://github.com/JoshuaMicallefYBSU/OzServer-API/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshuaMicallefYBSU/OzServer-API/actions/workflows/ci.yml)

The backend for **OzServer** — shared sector ownership, flight data and ATIS for
[vatSys](https://virtualairtrafficsystem.com/) controllers on VATSIM's Australia Pacific airspace.

Controllers run the [OzServer plugin](https://github.com/JoshuaMicallefYBSU/OzServer-Plugin) inside
vatSys. This API is the single record of who holds which sector, which controller has authority over
each flight, and what every airport's ATIS is broadcasting. It also serves the public live map on
[ozserver.org](https://ozserver.org).

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Error reporting](#error-reporting)
- [Tests](#tests)
- [Deployment](#deployment)
- [Security model](#security-model)
- [Related repositories](#related-repositories)

## Features

- **Sector ownership** — claim, release, request and hand over sectors, with grouped positions,
  top-down cover, and a single transactional lock so overlapping groups can never be claimed twice.
- **Disconnect handling** — a controller who drops out keeps their sectors for a grace period and
  can resume them; after that the sectors pass to whoever is covering the parent position.
- **Flight data** — one record per aircraft with a single controlling authority, kept consistent
  through handoffs, sector transfers and disconnects.
- **ATIS** — the broadcast for every airport, published section by section the moment it changes.
- **Real-time signals** — a Server-Sent Events stream tells clients *that* something changed; they
  re-read through the ordinary endpoints.
- **Server isolation** — the live network and each SweatBox training server are kept fully apart.
- **Public map feed** — read-only endpoints for the website's live map.
- **Plugin updates** — the release every plugin should be running, served from one cached lookup.
- **Error reporting** — plugin and server errors relayed to a Discord channel as they happen.

## Architecture

```mermaid
flowchart LR
    plugin["vatSys + OzServer plugin"] -- "HTTPS /api/v1" --> caddy["Caddy<br/>api.ozserver.org"]
    web["ozserver.org live map"] -- "HTTPS /api/v1 (read-only)" --> caddy
    caddy --> api["OzServer API<br/>Fastify · Node.js 22"]
    api --> db[("PostgreSQL 17")]
    api -. "datafeed, AFV transceivers" .-> vatsim["VATSIM"]
    api -. "releases, sector dataset" .-> github["GitHub"]
```

| | |
| --- | --- |
| Runtime | Node.js 22, TypeScript, [Fastify](https://fastify.dev/) 5 |
| Storage | PostgreSQL 17 — plain SQL migrations in [`migrations/`](migrations), flight data as JSONB |
| Validation | [Zod](https://zod.dev/) schemas on every request body |
| Events | Postgres `LISTEN`/`NOTIFY` fanned out to Server-Sent Events subscribers |
| Deployment | Docker Compose behind Caddy; pull-based deploys from `main` |

Design points worth knowing before changing anything:

- **The database is the source of truth.** Every sector mutation runs in one transaction under a
  per-server advisory lock, so two controllers can never both end up owning the same sector.
- **Presence comes from the plugin's own requests.** Every authenticated call refreshes the caller's
  `last_seen_online_at`. VATSIM's public datafeed lags a new connection by tens of seconds, so it is
  used only for the public map, never to decide ownership.
- **Events carry no data.** A signal names an area (`sectors`, `fdr`, `atis`) and a server; clients
  re-read. A missed signal costs latency, not correctness, because clients also poll.
- **Sectors are static reference data**, synchronised from the vatSys Australia and Pacific datasets and the
  [VATMEX MMFR sector](https://github.com/vatmex/vatmex-mmfr-sector) with `npm run dataset:sync`. Ownership, requests, flights and ATIS are scoped per server.
- **Airspace is grouped into regions** ([`src/regions.ts`](src/regions.ts)): `australia` (the
  Australia and Pacific datasets) and `mexico`. Every sector and position records its region, and the
  map's region toggles are built from `GET /regions`.

## Getting started

Requirements: Node.js 22 and PostgreSQL 17 (or Docker for the database).

```bash
cp .env.example .env            # then set POSTGRES_PASSWORD and the matching DATABASE_URL
docker compose up -d postgres   # or point DATABASE_URL at an existing PostgreSQL
npm install
npm run db:migrate
npm run dataset:sync            # loads sectors and positions from the vatSys datasets
npm run dev
```

The API listens on `http://localhost:3000`. `GET /health` reports the process and its database
connection.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run from source with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run db:migrate` | Apply pending migrations |
| `npm run dataset:sync` | Refresh sectors and positions from the vatSys datasets |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite |

The `:prod` variants (`db:migrate:prod`, `dataset:sync:prod`) run the compiled commands inside the
production image, which has no development dependencies.

## Configuration

Configuration is read from the environment and validated at start-up ([`src/config.ts`](src/config.ts));
an invalid value stops the process rather than being guessed at.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | — (required by Compose) | Password for the Compose-managed database |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address |
| `WEBSITE_ORIGIN` | `https://ozserver.org` | Origin allowed by CORS for the public endpoints |
| `PRESENCE_TIMEOUT_SECONDS` | `6` | Silence from a controller before they count as dropped: their sectors are then kept for them until `DISCONNECT_GRACE_MINUTES`, but another controller may take them with `take_dropped`. Keep at about twice the plugin's 3 s poll |
| `DISCONNECT_GRACE_MINUTES` | `2` | How long a crashed (dropped) controller's sectors are held for them before they are released and reassigned |
| `RESUME_WINDOW_MINUTES` | `5` | How long a dropped controller can resume their sectors and tags |
| `FDR_RETAIN_MINUTES` | `15` | Lifetime of a flight record after its last update |
| `ATIS_RETAIN_MINUTES` | `60` | Lifetime of an ATIS handover record after its last update |
| `NETWORK_ATIS_RETAIN_MINUTES` | `90` | Lifetime of a published ATIS after its last publish |
| `RATE_LIMIT_PER_10S` | `300` | Requests one address may make per ten seconds before `429` |
| `MAX_EVENT_SUBSCRIBERS` | `500` | Event streams held open at once |
| `CLIENT_LOGS_TOKEN` | unset | When set (16+ characters), required to read `GET /client-logs` |
| `ATIS_TOKEN` | unset | When set (16+ characters), required to publish with `PUT /vatsim/atis/:icao` |
| `CONSOLE_TOKEN` | unset | Required (24+ characters, as a bearer token) by `/admin/messages`, which the website's /console sends developer messages through. Unset turns those routes off |
| `MESSAGE_RETAIN_DAYS` | `14` | Days a console message, with its receipts and replies, is kept after it expires |
| `PLUGIN_RELEASE_REPO` | `JoshuaMicallefYBSU/OzServer-Plugin` | Repository whose releases are offered to the plugin's updater |
| `PLUGIN_RELEASE_MAX_VERSION` | unset | When set, no plugin release newer than this is offered |
| `DISCORD_WEBHOOK_URL` | unset | When set, errors are relayed to this Discord webhook - see [Error reporting](#error-reporting) |
| `DISCORD_LOG_CATEGORIES` | `Error` | Comma-separated plugin log categories relayed to Discord |
| `DISCORD_LIVE_WEBHOOK_URL` | unset | When set, live network stats (online controllers, tags by FIR) are kept up to date in this webhook's channel - see `src/live-stats.ts` |
| `DISCORD_LIVE_MESSAGE_IDS` | unset | Messages already in that channel to edit instead of posting new ones, as `controllers=<id>,fir_tags=<id>`. Only read until the ids are recorded in the database |
| `LIVE_STATS_INTERVAL_SECONDS` | `60` | How often the live stats are refreshed (30 at least) |

## API reference

All routes are under `/api/v1`. Responses are JSON; validation failures answer `422` with the
offending fields, and an address over the rate limit answers `429` with `Retry-After`.

`server` is one of `live`, `sb1` or `sb2` (`GET /servers` lists them with labels).

### Plugin endpoints

Every request identifies the calling controller with `controller_cid`, `controller_callsign` and
`server` — in the query string for `GET`, in the JSON body otherwise. A request without them
answers `401`.

| Endpoint | Purpose |
| --- | --- |
| `GET /sectors/sync` | Everything a client needs in one read: sectors owned, sectors held by others, and pending requests |
| `GET /sectors/mine` · `GET /sectors/controlled` · `GET /sector-requests` | The three parts of `/sectors/sync` on their own |
| `POST /sectors/:name/claim` | Claim a sector and its group; `409` with the conflicts when another controller holds part of it. A dropped controller's sectors are conflicts too (`owner.dropped`, with `released_at`) unless the body has `take_dropped: true`. So are sectors worked by a controller without the plugin (`owner.external`) unless it has `take_external: true` |
| `POST /sectors/:name/release` | Release a sector |
| `POST /sectors/:name/request` | Ask the current owner for a sector |
| `POST /sectors/commit` | Apply a set of claims, releases and requests in one transaction; `take_dropped` and `take_external` as for a claim |
| `POST /sectors/release-all` | Release everything, on a deliberate disconnect |
| `POST /sectors/resume` | Recover sectors, and the tags to restore, after a dropped connection |
| `POST /sector-requests/:id/accept` · `/reject` · `/cancel` | Answer or withdraw one request |
| `POST /sector-requests/accept-batch` · `/reject-batch` | Answer several requests at once |
| `POST /sector-requests/:id/acknowledge-rejection` | Confirm a rejection was shown to the requester |
| `POST /fdr` · `POST /fdr/batch` | Upsert flight records (up to 500 per batch); each result reports whether the push was accepted |
| `GET /fdr/sync` | Every current flight record, without routes |
| `GET /fdr/:callsign` | One flight record in full |
| `GET /arrivals/:ades` | An airport's Arrival List: every departed flight record inbound to it with its landing time, type and global ops, in sequence order; how many controllers have it open and who; whether its FMP is online, and whether the caller may reorder |
| `POST /arrivals/:ades/sequence` | Move a flight in the sequence (`seq_index`, -1 to unsequence); anyone may unless the airport's FMP (`CB_FMP` for YSCB) is online, then only the FMP (403 otherwise) |
| `POST /arrivals/viewing` | The Arrival Lists this controller has open; answers the viewer count for each |
| `POST /network/controllers` | Every controller this client's vatSys can see (position, frequencies, information lines), so the airspace of those without the plugin counts as held - see `src/external-control.ts` |
| `POST /atis` | Record the ATIS an OzServer controller's own vatSys is running |
| `POST /client-logs` | Forward plugin log lines (up to 200 per batch) |
| `GET /messages` | Console messages waiting for this controller (marks them delivered) |
| `POST /messages/:id/read` · `POST /messages/:id/reply` | Mark a console message read, or answer it (when it takes replies) |

### Public endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /events?server=` | Server-Sent Events stream — see [Events](#events) |
| `GET /events/status` | Number of open event streams |
| `GET /servers` | The servers this API distinguishes, with display labels |
| `GET /regions` | The airspace regions (Australia, Mexico), with display labels |
| `GET /vatsim/atis` · `GET /vatsim/atis/:icao` | Published ATIS for every airport, or one (or `null`) |
| `PUT /vatsim/atis/:icao` | Publish an airport's ATIS — see [ATIS](#atis) |
| `GET /atis/:icao?server=` | The ATIS handover record for one airport |
| `GET /plugin/release` | The plugin release to install — see [Plugin updates](#plugin-updates) |
| `GET /map/sectors?server=` | Staffed sectors with their boundaries and owners |
| `GET /map/sector-shapes` | Every sector's static geometry |
| `GET /map/ops?server=` | Ownership, controllers and pending requests in one read |
| `GET /map/controllers?server=` | Controllers online and the position each is working |
| `GET /map/aircraft?server=` · `GET /map/routes?server=` | Current flight records, and their routes |
| `GET /map/atis?server=` | Every ATIS that can be placed on the map, with whether its station is still connected |
| `GET /map/traffic` · `GET /map/pilots` | Network traffic inside OzServer's airspace, from the VATSIM datafeed |
| `GET /afv/transceivers` | VATSIM's AFV transceiver feed, cached |
| `GET /client-logs` | Forwarded plugin logs for diagnostics; token-protected when `CLIENT_LOGS_TOKEN` is set |
| `GET /admin/messages` · `POST /admin/messages` · `POST /admin/messages/:id/withdraw` | Console messages: list with receipts and replies, send, withdraw. `CONSOLE_TOKEN` required; called by the website's server, never a browser |
| `GET /health` (not under `/api/v1`) | Liveness and database connectivity |

### Events

`GET /api/v1/events?server=live` opens a Server-Sent Events stream. Each event is named `sectors`,
`fdr`, `atis`, `messages` or `arrivals` and means "something in that area changed on this server — read it again":

```
event: sectors
data: {"type":"sectors","server":"live"}
```

The stream carries no state and needs no identity, so the plugin and a browser share it. A comment
frame every 20 seconds keeps idle connections open. Streams are capped per address and in total; a
client that is turned away (`503`) keeps working from its own polling.

### ATIS

The plugin publishes each airport's ATIS from a live-network session, one record per airport,
created or replaced in full:

```http
PUT /api/v1/vatsim/atis/YSSY
Content-Type: application/json

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

- **Idempotent.** `201` the first time, `200` after; the stored record is the same either way.
- **`type`** is `atis` for a sectioned broadcast or `zulu` for the free text a closed tower leaves
  running. A `zulu` sends its text as a plain string in `content`, and its `changed` is always empty.
- **`changed`** lists the sections this letter changed. Section names the API does not serve
  (`MODE`, `TIME_CHECK`) are dropped from `content` and `changed` rather than refused.
- **`controller`** is required; `frequency` and `client` are optional. A body whose `icao` differs
  from the URL, or with no ATIS letter, answers `422` and stores nothing.
- **Reading it back** returns the broadcast with `issued` as a `DDHHMM` UTC day-time group and
  every section in ATIS-editor order (`null` for one not broadcast). `controller` and `client` are
  stored for traceability but only ever returned to the publisher, in the `PUT` response.
- **No withdrawal.** A record leaves by being replaced, or `NETWORK_ATIS_RETAIN_MINUTES` after the
  last `PUT` that carried it — so re-publishing an unchanged ATIS keeps it alive while it is on air.

`GET /map/atis` returns published ATIS placed at their airport, plus the handover record
(`POST /atis`) for any airport with no published one, in the same shape. Each carries `connected`:
`true` while the ATIS station is on the network, `false` for a record still held after it left.

### Plugin updates

The plugin updates itself. Rather than every client calling GitHub, it asks this API:

```http
GET /api/v1/plugin/release
```

```json
{
  "version": "0.1.8",
  "tag": "v0.1.8",
  "url": "https://github.com/JoshuaMicallefYBSU/OzServer-Plugin/releases/download/v0.1.8/OzServerPlugin.dll",
  "sha256": "bb641fa7ef8352de469f04938e05f75dd437980a93e9b64b128a0ea9b5135f57",
  "size": 308224,
  "published_at": "2026-11-11T10:28:16Z",
  "notes_url": "https://github.com/JoshuaMicallefYBSU/OzServer-Plugin/releases/tag/v0.1.8"
}
```

The answer is the newest published release of `PLUGIN_RELEASE_REPO` that has `OzServerPlugin.dll`
attached, or `null` when there is none. The release list is read from GitHub at most once every
five minutes, with a conditional request, and cached in memory — so publishing a GitHub release is
still the whole release process, and it reaches clients within minutes.

- **Holding a release back.** Set `PLUGIN_RELEASE_MAX_VERSION` and restart; nothing newer is
  offered. The plugin only ever installs a higher version than it is running, so this pauses a
  rollout but cannot downgrade anyone.
- **The binary stays on GitHub.** This endpoint only names the download. The plugin accepts a URL
  under its own repository's releases and verifies the SHA-256 before installing, so this server
  cannot point a client at any other file.
- **If GitHub has never been reachable** since start-up the endpoint answers `503`, and the plugin
  falls back to asking GitHub directly.

### Error reporting

With `DISCORD_WEBHOOK_URL` set, the API posts to that Discord webhook:

- **Plugin errors** — every error the plugin shows a controller is forwarded with its log
  (`POST /client-logs`, category `Error`) and relayed with the controller's callsign, CID, server
  and plugin version. `DISCORD_LOG_CATEGORIES` widens this to other log categories.
- **Server errors** — any request answered `500`, and a failed maintenance sweep.

Messages are batched every five seconds, identical errors inside a minute are counted rather
than repeated, and the relay backs off when Discord rate-limits it — so a fault every client
reports at once arrives as a handful of messages. Reporting never delays or fails a request.

> [!IMPORTANT]
> A webhook URL is a credential: anyone who has it can post to the channel. Keep it in `.env` on
> the host, never in the repository, and regenerate it in Discord if it is ever exposed.

## Tests

```bash
npm test
```

Unit tests run anywhere. The route tests in [`src/api.integration.test.ts`](src/api.integration.test.ts)
exercise the real SQL and need a PostgreSQL database they are allowed to wipe; they are skipped
unless `TEST_DATABASE_URL` is set:

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test
```

> [!WARNING]
> The integration tests drop and recreate the `public` schema. Never point `TEST_DATABASE_URL` at a
> database you want to keep.

CI runs the type check, the full suite against PostgreSQL, and a build of the production image on
every push to `main` and every pull request.

## Deployment

Production runs on a single Linux host with Docker Compose, behind [Caddy](https://caddyserver.com/)
on `api.ozserver.org`.

- [`compose.yaml`](compose.yaml) runs the API and PostgreSQL. The database is on an internal
  network reachable only from the API container; the API is published on `127.0.0.1:3000` only.
- [`Caddyfile.example`](Caddyfile.example) terminates TLS and proxies to the API. The events
  stream is routed without compression, which would otherwise buffer it.
- The container applies pending migrations before it starts serving, so new code never runs
  against an old schema.

### Continuous deployment

Deployment is pull-based: a systemd timer on the host runs every two minutes and redeploys when
`origin/main` has moved.

```
git fetch  →  build image  →  up -d  →  migrate  →  health check
```

The health check gates the deploy. If `/health` does not report a working database within about a
minute, the host resets to the previous commit and rebuilds, so a bad push leaves the previous
version serving. **A push to `main` is a production deploy** — CI on the pull request is the gate.

### Operations

```bash
sudo systemctl start ozserver-deploy      # deploy now rather than waiting for the timer
journalctl -u ozserver-deploy -n 50       # what recent deploys did
docker compose logs api --tail 100
docker compose exec api npm run dataset:sync:prod   # after a vatSys dataset release
```

- `.env` lives beside `compose.yaml` on the host, outside git, and survives deploys.
- PostgreSQL is dumped daily to the host and kept for 14 days. Those dumps cover operator error,
  not loss of the host — keep an off-server copy, and take a backup before any schema migration.
- Use one account per administrator with individual SSH keys.

[`MIGRATION.md`](MIGRATION.md) records the cutover from the API that was originally embedded in
the website.

## Security model

- **Identity is asserted, not proven.** The plugin sends the CID and callsign of the vatSys session
  it is running in, and the API trusts it. Checking each request against VATSIM's datafeed was
  rejected because the feed lags a new connection long enough to refuse legitimate controllers.
  Treat this API as a coordination service between cooperating controllers, not an authority.
- **Rate limiting** is per address, in memory, and deliberately generous: a controller wrongly
  turned away stops heart-beating and loses sectors.
- **Optional shared tokens** protect the two endpoints that warrant it: `CLIENT_LOGS_TOKEN` for
  reading forwarded logs (which name controllers) and `ATIS_TOKEN` for publishing ATIS. Both are
  unset by default; set `CLIENT_LOGS_TOKEN` on any public deployment.
- **CORS** allows `GET` from `WEBSITE_ORIGIN` only.
- **No secrets in the repository.** Configuration comes from the environment; `.env` is ignored.

To report a security problem, please contact the maintainers privately rather than opening a
public issue.

## Related repositories

- [OzServer-Plugin](https://github.com/JoshuaMicallefYBSU/OzServer-Plugin) — the vatSys plugin
  controllers run.
- [OzServer-Website](https://github.com/JoshuaMicallefYBSU/OzServer-Website) — ozserver.org and its
  live map.

## Licence

No licence has been chosen yet. Until a `LICENSE` file is added, all rights are reserved.
