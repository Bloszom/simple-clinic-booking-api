# Clinic Booking API

Express 5 / Node.js backend for clinic appointments, using PostgreSQL through `pg`.
Implements API-key authentication, database-enforced booking exclusivity, cancellation,
persistent idempotency, cursor pagination, and a persistent rolling email rate limit.

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
to a future ISO timestamp and `SEED_SLOT_COUNT` to customize it. Repeating the same
seed does not duplicate slots. Seeding is manual, never part of server startup.
There is no public slot administration endpoint; maintain schedules through SQL or
trusted administration tooling.

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
| GET | `/slots` | `200`, `{ "slots": [...] }`, chronological, with `available` on each slot |
| POST | `/bookings` | `201`, `{ "booking": {...} }`, plus `Location` |
| GET | `/bookings/:id` | `200`, `{ "booking": {...} }` |
| DELETE | `/bookings/:id` | `200`, `{ "booking": {...} }` with `status: "cancelled"` |
| GET | `/bookings?email=...&limit=20&cursor=...` | `200`, `{ "bookings": [...], "next_cursor": "..." }` |

### Create a Booking

Get an available slot ID from `/slots` first. `slot_id`, `name`, and a valid `email`
are required. Names are trimmed and limited to 120 characters. Emails are trimmed,
validated with `validator`, limited to 254 characters, and lowercased for matching
and rate limiting. UUIDs are validated before SQL. All SQL values are parameterized.

```sh
curl -X POST http://localhost:3000/bookings \
	-H "X-API-Key: YOUR_API_KEY" \
	-H "Content-Type: application/json" \
	-H "Idempotency-Key: YOUR_UNIQUE_REQUEST_KEY" \
	-d '{"slot_id":"11111111-1111-4111-8111-111111111111","name":"Jane Doe","email":"jane@example.com"}'
```

The slot UUID in the example is a placeholder. In Windows PowerShell, use the
Postman collection or `Invoke-RestMethod` instead of this POSIX-shell curl example.

```json
{
	"booking": {
		"id": "22222222-2222-4222-8222-222222222222",
		"slot_id": "11111111-1111-4111-8111-111111111111",
		"name": "Jane Doe",
		"email": "jane@example.com",
		"status": "confirmed",
		"created_at": "2030-01-01T08:00:00.000Z",
		"cancelled_at": null
	}
}
```

Slots expose UUID, `starts_at`, `ends_at`, `created_at`, and `available`. Past slots
remain listed but are unavailable and cannot be booked. Availability is a snapshot;
POST is authoritative. Timestamps use UTC ISO 8601.

### Concurrency and Cancellation

The partial unique index `bookings_one_active_per_slot` permits only one confirmed
booking per slot, even for concurrent requests, multiple application processes, or
direct SQL inserts. Conflict handling returns `409` rather than relying on a
read-before-write availability check. Cancelled rows retain the original booking
and leave the unique index, so another booking can claim that slot. DELETE is
idempotent: repeated cancellation returns the existing cancelled booking without
changing its cancellation timestamp. Unknown IDs return `404`.

### Idempotency

`Idempotency-Key` is optional on POST, but recommended for every booking request.
Use a new, unpredictable key for each logical operation and reuse it on retries.
Keys allow 1-128 letters, digits, dots, underscores, colons, and hyphens.

- Keys are unique in this single-clinic API and stored in PostgreSQL.
- The canonical validated slot/name/email payload is hashed with the operation.
	Different JSON field order, surrounding whitespace, and email case are normalized.
- Key reservation, quota checking, booking creation, and response persistence share
	one transaction. Concurrent retries wait for the original transaction and replay
	its status, JSON body, `Location`, and `Retry-After`, when present.
- Replays use `Idempotency-Replayed: true` and do not consume another attempt.
- Reusing a key with a different validated payload returns `409 IDEMPOTENCY_CONFLICT`.
- Business outcomes (`201`, slot `404`/`409`, and `429`) are persisted. Authentication
	and validation errors do not bind a key. Unexpected failures roll back so retry is safe.
- A stored response is immutable, including after cancellation. To see current booking
	state, use GET. To rebook a cancelled slot, submit a new logical request with a new key.
- A persisted `429` keeps replaying that original response. After waiting `Retry-After`,
	use a new key for a new attempt. Network retries of that attempt reuse its new key.
- Keys do not expire automatically. Do not delete records unless you explicitly adopt
	and communicate a finite retry-retention contract to clients.

### Pagination

`email` is an optional exact normalized filter. `limit` defaults to 20 and accepts
integers from 1 to 100. Results include confirmed and cancelled bookings, ordered by
`created_at DESC, id DESC`. Use the opaque `next_cursor` unchanged for the next
request with the same email filter; `null` means the end. The cursor is signed with
the API key and validated. API-key rotation invalidates outstanding cursors.

Millisecond creation timestamps and the UUID tie-breaker make keyset pagination
stable when timestamps are equal, without lossy PostgreSQL-to-JavaScript conversion.
It is not a database snapshot across requests: new bookings appear when restarting
from the first page, while cancellation updates a row's status without reordering it.

### Rate Limits and Errors

At most five validated, non-replayed booking attempts per normalized email are
admitted in any rolling 60-second window. Slot conflicts, past slots, and missing
slots count; invalid input, key conflicts, and idempotency replays do not. A PostgreSQL
transaction-scoped advisory lock serializes quota decisions per email across replicas.
Admitted attempts persist even when a slot is unavailable. Denied attempts return
`429` with an integer `Retry-After` in seconds and do not extend the window.

```json
{
	"error": {
		"code": "RATE_LIMIT_EXCEEDED",
		"message": "Maximum 5 booking attempts per email per minute."
	}
}
```

Centralized errors also include `error.request_id`; validation errors include a
`details` array with field messages. Transaction-stored business errors omit the
request ID in the body to keep replay bodies identical; every HTTP response still
has a new `X-Request-Id` header. Internal SQL, credentials, and stack traces are not exposed.

| Status | Typical Reason |
| --- | --- |
| 400 | Invalid JSON, missing/invalid fields, UUID, limit, cursor, or idempotency key |
| 401 | Missing or invalid API key |
| 403 | Browser origin not allowed |
| 404 | Endpoint, booking, or slot not found |
| 405 | Unsupported method on a known endpoint; includes `Allow` |
| 409 | Slot unavailable or idempotency key reused for a different payload |
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

Import `postman/clinic-booking.postman_collection.json` into Postman. Set collection
variable `api_key` to your API key and adjust `base_url`. Run the main workflow in order:
it picks an available slot, generates an idempotency key, creates a booking, replays it,
retrieves it, paginates, and cancels it. Negative examples demonstrate missing auth,
invalid email, and a payload conflict for the stored key. Use only test patient data.

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

- API-key access is privileged: it can list all bookings and read/cancel any booking.
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
