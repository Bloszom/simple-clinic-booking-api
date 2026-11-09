# Clinic Booking API

Express 5 / Node.js backend for clinic appointments, using PostgreSQL through `pg`.
Implements API-key authentication, database-enforced booking exclusivity, cancellation,
persistent idempotency, cursor pagination, and a persistent rolling email rate limit.

Implementation of the [Koya assessment API contract](https://koyaacademy.com/assessment-api),
with a React/Vite booking page in [frontend](frontend/README.md). The backend deploys to
Render from the repository root; the frontend deploys independently to Vercel with
Root Directory `frontend`. The server-side gateway keeps the API key out of the browser.

For the website locally, install with `npm --prefix frontend ci`, keep `npm run dev`
running for the backend, and run `npm run web:dev` in a second terminal. Open
**http://localhost:5173**. See the frontend README for Vercel environment settings.

## Requirements

- Node.js 22 or newer and npm.
- PostgreSQL 14 or newer, or a Neon PostgreSQL database.
- A database role that can create tables and indexes for migrations. Use a separate,
	least-privilege application role in deployments where you manage role grants.

## Local Setup

```sh
npm ci
```

Create your environment file, then edit the values:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

Set `DATABASE_URL` to an existing database and generate an API key locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put that value in `API_KEY`, then run:

```sh
npm run migrate
npm run seed
npm run dev
```

The API listens at `http://localhost:3000`. `npm start` starts without watch mode.
Both the server and database scripts load `.env` using dotenv; deployment environment
variables take precedence. The dev script requires an existing `.env` file.

Seeding inserts 16 half-hour slots starting tomorrow at 09:00 UTC. Set `SEED_START`
to a future ISO timestamp, `SEED_PROVIDER` (default `Dr Ade`), and `SEED_SLOT_COUNT` to customize it. Repeating the same
seed does not duplicate slots. Seeding is manual, never part of server startup.

### Updating an Existing Installation

Stop the development server with Ctrl+C, run `npm run migrate`, then `npm run dev`.
The new `002_assessment_contract.sql` migration preserves existing slots and bookings,
uses existing slot UUIDs as their public string IDs, and assigns existing slots provider
`Clinic`. It adapts stored replay responses to the new flat JSON contract. Old pagination
cursors are invalidated. Re-import the updated Postman collection. No reseeding or reset
is needed to preserve your current schedule.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL. Production requires `sslmode=verify-full`. |
| `API_KEY` | Required shared secret, at least 32 characters. Treat it as an administrator credential. |
| `PORT` | HTTP port, default `3000`. Render supplies this automatically. |
| `NODE_ENV` | `development`, `test`, or `production`; default `development`. |
| `CORS_ORIGINS` | Comma-separated explicit origins; empty permits no cross-origin browser clients. No wildcard. |
| `SEED_START` | Optional future ISO timestamp for manual slot seeding. |
| `SEED_SLOT_COUNT` | Optional number of half-hour slots, `1-1000`; default `16`. |
| `SEED_PROVIDER` | Optional provider name for seeded slots; default `Dr Ade`. |
| `TEST_DATABASE_URL` | Optional shell variable pointing to a dedicated test database. |

For Neon, copy the connection string from the Neon dashboard and use
`sslmode=verify-full` instead of `sslmode=require`. Certificate verification is not
disabled. Neon's pooled endpoint supports these transaction-scoped advisory locks;
use a direct endpoint when operating migration tools that require session state.
The application uses at most 10 connections per process. Budget database connections
across all Render replicas and reserve capacity for migrations and administration.

## API Contract

Every endpoint, including `/health`, requires `X-API-Key: <your-key>`.
All responses and errors have JSON bodies, except standard bodyless `HEAD` requests
and `OPTIONS` CORS preflight responses. Browser preflight is permitted without an API
key because it does not expose application data. POST requires `Content-Type:
application/json`; the body limit is 16 KB. Responses use `Cache-Control: no-store`.

| Method | Endpoint | Successful Response |
| --- | --- | --- |
| GET | `/health` | `200`, `{ "status": "ok", "database": "connected" }` after a database query |
| POST | `/reset` | `200`, replaces slots and clears bookings; accepts `{ "slots": [...] }` |
| GET | `/slots?provider=...` | `200`, `{ "slots": [...] }`, earliest start first, optional exact provider filter |
| POST | `/bookings` | `201`, booking object directly, plus `Location` |
| GET | `/bookings/:id` | `200`, booking object directly |
| DELETE | `/bookings/:id` | `200`, booking object directly with `status: "cancelled"`; repeated cancellation returns `409` |
| GET | `/bookings?email=...&limit=10&cursor=...` | `200`, `{ "bookings": [...], "next_cursor": "..." }`; email required |

### Reset and Slot Listing

`POST /reset` accepts a slots array. Each item requires a public string `id`, `provider`,
and ISO date-time `start` and `end` with a timezone. IDs must be unique and end must be
after start. Past slots and simultaneous appointments are accepted. For example:

```json
{
	"slots": [
		{ "id": "s1", "provider": "Dr Ade", "start": "2030-01-01T09:00:00Z", "end": "2030-01-01T09:30:00Z" },
		{ "id": "s2", "provider": "Dr Obi", "start": "2030-01-01T09:00:00Z", "end": "2030-01-01T09:30:00Z" }
	]
}
```

Reset is destructive: it atomically deletes every booking, replaces the entire schedule,
and clears idempotency and attempt records so earlier test runs do not affect the new
schedule. An empty array clears the schedule. Invalid input leaves current data intact.
An exclusive transaction-scoped advisory lock coordinates reset with bookings,
cancellations and seeding. Never call reset against a database containing real patients.
It exists because the assessment explicitly requires it and is protected by the API key.

`GET /slots` returns all slots, including past ones. `provider` is an optional, exact,
case-sensitive filter. Slots expose `id`, `provider`, `start`, `end`, and `available`.
Availability is false only while a confirmed booking exists. A past slot can therefore
be marked available, but attempting to book it returns `400`.

### Create a Booking

Get an available slot ID from `/slots` first. `slot_id`, `name`, and a valid `email`
are required. Names are trimmed. Emails are trimmed,
validated with `validator`, limited to 254 characters, and lowercased for matching
and rate limiting. Slot IDs are strings, not restricted to UUIDs. Booking IDs are
generated UUIDs; looking up an unknown ID returns `404`. All SQL values are parameterized.

```sh
curl -X POST http://localhost:3000/bookings \
	-H "X-API-Key: YOUR_API_KEY" \
	-H "Content-Type: application/json" \
	-H "Idempotency-Key: YOUR_UNIQUE_REQUEST_KEY" \
	-d '{"slot_id":"s1","name":"Jane Doe","email":"jane@example.com"}'
```

Use a real slot ID from `/slots` in this example. In Windows PowerShell, use the
Postman collection or `Invoke-RestMethod` instead of this POSIX-shell curl example.

```json
{
	"id": "22222222-2222-4222-8222-222222222222",
	"slot_id": "s1",
	"name": "Jane Doe",
	"email": "jane@example.com",
	"status": "confirmed",
	"created_at": "2030-01-01T08:00:00.000Z"
}
```

Availability is a snapshot; POST is authoritative. Response timestamps use UTC ISO 8601.

### Concurrency and Cancellation

The partial unique index `bookings_one_active_per_slot` permits only one confirmed
booking per slot, even for concurrent requests, multiple application processes, or
direct SQL inserts. Conflict handling returns `409` rather than relying on a
read-before-write availability check. Cancelled rows retain the original booking
and leave the unique index, so another booking can claim that slot. The first DELETE
returns `200`; repeated cancellation returns `409` without changing its cancellation
timestamp. Unknown IDs return `404`.

### Idempotency

`Idempotency-Key` is optional on POST, but recommended for every booking request.
Use a new, unpredictable key for each logical operation and reuse it on retries.
Keys are string header values and are subject to the HTTP server's header-size limits.

- Keys are unique in this single-clinic API and stored in PostgreSQL.
- The entire submitted JSON body is hashed with the operation. Object key order does
	not matter, but changed values, whitespace inside strings, or extra fields do.
- Key reservation, quota checking, booking creation, and response persistence share
	one transaction. Concurrent retries wait for the original transaction and replay
	its status, JSON body, `Location`, and `Retry-After`, when present.
- Replays use `Idempotency-Replayed: true` and do not consume another attempt.
- Reusing a key with a different body returns `422`.
- Business outcomes (`201`, `400`, slot `404`/`409`, and `429`) are persisted, including
	parsed-body validation errors. Authentication and JSON-parser failures do not bind a
	key. Unexpected failures roll back so retry is safe.
- A stored response is immutable, including after cancellation. To see current booking
	state, use GET. To rebook a cancelled slot, submit a new logical request with a new key.
- A persisted `429` keeps replaying that original response. After waiting `Retry-After`,
	use a new key for a new attempt. Network retries of that attempt reuse its new key.
- Keys do not expire automatically. Do not delete records unless you explicitly adopt
	and communicate a finite retry-retention contract to clients.

### Pagination

`email` is required and matched case-insensitively after normalization. `limit` defaults
to 10 and accepts integers from 1 to 50. Results include confirmed and cancelled
bookings, oldest first, ordered by `created_at ASC, id ASC`. Use the opaque `next_cursor` unchanged for the next
request with the same email filter; `null` means the end. The cursor is signed with
the API key and validated. API-key rotation invalidates outstanding cursors.

Millisecond creation timestamps and the UUID tie-breaker make keyset pagination
stable when timestamps are equal, without lossy PostgreSQL-to-JavaScript conversion.
It is not a database snapshot across requests: later bookings can appear on subsequent
pages, while cancellation updates a row's status without reordering it.

### Rate Limits and Errors

At most five non-replayed booking attempts per normalized email are admitted in any
rolling 60-second window. Failed attempts count, including missing booking fields,
slot conflicts, past slots, and missing slots. Invalid email strings also count when a
nonempty, normalized string of at most 254 characters identifies repeated attempts.
Missing/non-string emails cannot be attributed to an email quota. Authentication
failures, JSON-parser failures, key conflicts, and idempotency replays do not count. A PostgreSQL
transaction-scoped advisory lock serializes quota decisions per email across replicas.
Admitted attempts persist even when a slot is unavailable. Denied attempts return
`429` with an integer `Retry-After` in seconds and do not extend the window.

```json
{
	"error": "Maximum 5 booking attempts per email per minute."
}
```

Every error uses `{ "error": "<message>" }`, matching the assessment. Every HTTP response
has a new `X-Request-Id` header. Internal SQL, credentials, and stack traces are not exposed.

| Status | Typical Reason |
| --- | --- |
| 400 | Invalid JSON, missing/invalid fields, past slot, reset input, limit, or cursor |
| 401 | Missing or invalid API key |
| 403 | Browser origin not allowed |
| 404 | Endpoint, booking, or slot not found |
| 405 | Unsupported method on a known endpoint; includes `Allow` |
| 409 | Slot already booked or booking already cancelled |
| 422 | Idempotency key reused with a different body |
| 413 / 415 | Oversized JSON / unsupported content type or encoding |
| 429 | Email quota exceeded; includes `Retry-After` |
| 500 / 503 | Unexpected failure / temporary database or lock unavailability |

## Database and Structure

```text
src/
	controllers/          HTTP input/output
	routes/               Express route registration
	middleware/           Authentication, request IDs/logging, JSON errors
	services/             Booking transactions, availability, idempotency, quotas
	database/
		migrations/         Versioned SQL: slots, bookings, idempotency_keys, booking_attempts
		pool.js             Bounded pg pool and transaction helper
		migrate.js          Locked, transactional, checksum-verified migration runner
		seed.js             Repeatable schedule seeding
	utils/                Configuration, validation, signed cursors, error types
	app.js                Injectable app factory
	server.js             Startup and graceful shutdown
scripts/                Syntax/JSON checks and disposable PostgreSQL test runner
test/                   Unit/HTTP tests and real PostgreSQL integration tests
postman/                Importable collection
render.yaml             Render web-service blueprint using external Neon
```

Every application table has a generated UUID primary key. Foreign keys, status checks,
the partial unique index, and paging/rate-window indexes are in the initial SQL migration.
Public slot IDs are stored separately in a unique `external_id` text column, so IDs such
as `s1` work without changing internal foreign keys. API booking `slot_id` uses this public ID.
The migration runner records UUID-keyed migration metadata and skips already applied
files. SQL uses LF line endings for portable checksums. Never edit an applied migration;
add a new numbered SQL file for subsequent schema changes.

## Testing and Postman

```sh
npm run check
npm test
npm run test:integration
npm audit --omit=dev
```

Integration tests start disposable, loopback-only PostgreSQL using the development-only
`embedded-postgres` package and remove it afterward. Alternatively, set `TEST_DATABASE_URL`
in your shell to a dedicated PostgreSQL or Neon test branch. The runner does not read
this value from `.env`. Tests create and drop only their own randomly named schema;
the role needs schema creation rights. Do not point tests at a production database.
Embedded PostgreSQL cannot run as root; root-based containers should supply an external
test database instead. CI uses a PostgreSQL 17 service and production dependencies only.

Tests cover actual concurrent slot contention, direct SQL constraint enforcement,
concurrent idempotency, replay across application instances and cancellation, exact
rolling quotas, persisted error responses, stable pagination ties, health, CORS,
authentication, and malformed input. No minute-long sleeps are necessary.
Contract tests also cover reset atomicity, arbitrary slot IDs, exact provider filtering,
data-preserving upgrades, direct booking objects, error strings, and pagination defaults.

Import `postman/clinic-booking.postman_collection.json` into Postman. Set collection
variable `api_key` to your API key and adjust `base_url`. Run the main workflow in order:
it picks an available slot, generates an idempotency key, creates a booking, replays it,
retrieves it, paginates, and cancels it. Negative examples demonstrate missing auth,
invalid email, and a payload conflict for the stored key. Use only test patient data.

The reset example is skipped unless collection variable `allow_reset` is the string
`true`. Enable it only against a dedicated test database, run that request explicitly,
then disable it again before running the booking workflow. It wipes existing bookings.

## Render and Neon Deployment

1. Create a Neon project/database and set up backups and access restrictions.
2. Push this repository and create a Render Blueprint from `render.yaml`, or configure
	 a Node web service with the same commands.
3. Set `DATABASE_URL` to your Neon URL with `sslmode=verify-full`; set `CORS_ORIGINS`
	 to trusted origins or leave it empty for server-to-server access. The blueprint
	 generates `API_KEY`; provision that secret to trusted API clients securely.
4. Build: `npm ci --omit=dev`. Pre-deploy: `npm run migrate`. Start: `npm start`.
	 The blueprint selects a paid Starter plan because pre-deploy commands require one.
	 On a free plan, run migrations manually before deployment and omit pre-deploy.
5. Seed the schedule explicitly using `npm run seed` from a trusted environment with
	 deployment credentials. Do not seed on each deploy.
6. Leave Render's HTTP health-check path unset. Render cannot supply `X-API-Key` to
	 its HTTP checks, and `/health` intentionally remains protected. Its default TCP
	 check verifies a listener; configure a separate authenticated `/health` monitor
	 for database readiness and alerting.

The server binds `0.0.0.0:$PORT`, checks database connectivity before listening, and
drains HTTP requests on SIGTERM before closing the pool. Queries and locks have
timeouts so contended requests fail instead of blocking indefinitely. Render provides
public HTTPS termination. No Render or Neon credentials are committed.

## Operations and Security

- API-key access is privileged: it can list bookings by any email, read/cancel any booking,
	and reset the entire schedule and booking history.
	This is not patient login or tenant isolation. Never embed the shared key in a
	public frontend. Add identity, ownership checks, and auditing before patient-facing use.
- Keep secrets in Render/your secret manager, rotate keys, restrict CORS, use HTTPS,
	and configure Neon backups, monitoring, and database privileges.
- Request logs are structured and omit patient data, request/query bodies, and keys.
	Monitor error codes, latency, 429s, and database capacity without logging PII.
- Schedule retention cleanup for old attempts, for example nightly:
	`DELETE FROM booking_attempts WHERE attempted_at < clock_timestamp() - interval '1 day';`
	Never remove attempts still inside the rate window. Configure autovacuum and retention
	for bookings and idempotency JSON, which contain patient data.
- The per-email quota is a booking rule, not comprehensive abuse protection. Add an
	edge/API-gateway request limit and body/time protections for high-traffic exposure.
- Healthcare privacy compliance depends on hosting agreements, jurisdiction, access
	controls, retention, auditing, and operating procedures; this code alone does not
	establish regulatory compliance.
