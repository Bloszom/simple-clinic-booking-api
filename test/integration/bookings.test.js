const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:net');
const { Pool } = require('pg');
const { createApp } = require('../../src/app');
const { migrate } = require('../../src/database/migrate');

const apiKey = 'integration-api-key-'.padEnd(40, 'x');
const schema = `clinic_test_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let server;
let baseUrl;
let schemaCreated = false;
let slotSequence = 0;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Use npm run test:integration or supply TEST_DATABASE_URL.');
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 10000 });
  // All fixtures and migrations stay in a unique schema, never existing application tables.
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL, max: 20,
    options: `-c search_path=${schema},public`,
    connectionTimeoutMillis: 10000, statement_timeout: 15000, lock_timeout: 10000
  });
  assert.deepEqual(await migrate(pool), ['001_initial.sql']);
  assert.deepEqual(await migrate(pool), []);
  server = createApp({ pool, config: { apiKey, corsOrigins: [] } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  if (admin) {
    try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options, headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', ...options.headers }
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function slot(past = false) {
  slotSequence += 1;
  const start = new Date(Date.now() + (past ? -86400000 : 86400000) + slotSequence * 60000);
  const { rows: [created] } = await pool.query(
    'INSERT INTO slots (starts_at, ends_at) VALUES ($1, $2) RETURNING *',
    [start, new Date(start.getTime() + 1800000)]
  );
  return created;
}

function create(slotId, email, key) {
  return request('/bookings', {
    method: 'POST', headers: key ? { 'Idempotency-Key': key } : {},
    body: JSON.stringify({ slot_id: slotId, name: 'Jane Doe', email })
  });
}

async function attempts(email) {
  const { rows: [row] } = await pool.query('SELECT count(*)::int AS count FROM booking_attempts WHERE email = $1', [email]);
  return row.count;
}

test('book, retrieve, cancel twice, and rebook a freed slot', async () => {
  const available = await slot();
  const initial = await request('/slots');
  assert.equal(initial.body.slots.find(item => item.id === available.id).available, true);
  const created = await create(available.id, 'patient@example.com');
  assert.equal(created.status, 201);
  const id = created.body.booking.id;
  assert.equal(created.headers.get('location'), `/bookings/${id}`);
  assert.equal((await request(`/bookings/${id}`)).body.booking.status, 'confirmed');
  assert.equal((await request('/slots')).body.slots.find(item => item.id === available.id).available, false);
  const cancelled = await request(`/bookings/${id}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.booking.status, 'cancelled');
  assert.ok(cancelled.body.booking.cancelled_at);
  assert.deepEqual((await request(`/bookings/${id}`, { method: 'DELETE' })).body, cancelled.body);
  assert.equal((await request('/slots')).body.slots.find(item => item.id === available.id).available, true);
  const replacement = await create(available.id, 'replacement@example.com');
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.booking.id, id);
});

test('simultaneous requests cannot double book, even with different emails', async () => {
  const available = await slot();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    create(available.id, `race-${index}@example.com`)));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 11);
  const { rows: [row] } = await pool.query("SELECT count(*)::int AS count FROM bookings WHERE slot_id = $1 AND status = 'confirmed'", [available.id]);
  assert.equal(row.count, 1);
});

test('the database itself rejects a second active booking', async () => {
  const available = await slot();
  assert.equal((await create(available.id, 'constraint@example.com')).status, 201);
  await assert.rejects(pool.query(
    "INSERT INTO bookings (slot_id, name, email) VALUES ($1, 'Direct SQL', 'direct@example.com')", [available.id]
  ), { code: '23505', constraint: 'bookings_one_active_per_slot' });
});

test('concurrent identical idempotency keys return one original response and consume one attempt', async () => {
  const available = await slot();
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 10 }, () => create(available.id, 'idempotent@example.com', key)));
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, responses[0].body);
    assert.equal(response.headers.get('location'), responses[0].headers.get('location'));
  }
  assert.equal(responses.filter(response => response.headers.get('idempotency-replayed') === 'false').length, 1);
  assert.equal(await attempts('idempotent@example.com'), 1);
  const { rows: [record] } = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
  assert.equal(record.response_status, 201);
  assert.equal(record.response_body.booking.id, responses[0].body.booking.id);
  const changed = await create((await slot()).id, 'idempotent@example.com', key);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('idempotency persists across app instances and replays the original response after cancellation', async () => {
  const available = await slot();
  const key = randomUUID();
  const original = await create(available.id, 'restart@example.com', key);
  await request(`/bookings/${original.body.booking.id}`, { method: 'DELETE' });
  const secondServer = createApp({ pool, config: { apiKey, corsOrigins: [] } }).listen(0, '127.0.0.1');
  await new Promise(resolve => secondServer.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${secondServer.address().port}/bookings`, {
      method: 'POST', headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ slot_id: available.id, name: 'Jane Doe', email: 'restart@example.com' })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), original.body);
    assert.equal(await attempts('restart@example.com'), 1);
  } finally { await new Promise(resolve => secondServer.close(resolve)); }
});

test('concurrent requests enforce exactly five attempts per normalized email', async () => {
  const available = await Promise.all(Array.from({ length: 10 }, () => slot()));
  const responses = await Promise.all(available.map((item, index) =>
    create(item.id, index % 2 ? ' RATE@Example.com ' : 'rate@example.com')));
  assert.equal(responses.filter(response => response.status === 201).length, 5);
  const limited = responses.filter(response => response.status === 429);
  assert.equal(limited.length, 5);
  for (const response of limited) {
    assert.equal(response.body.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.ok(Number(response.headers.get('retry-after')) <= 60);
  }
  assert.equal(await attempts('rate@example.com'), 5);
  // Advance fixture timestamps rather than sleeping a minute.
  await pool.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '61 seconds' WHERE email = $1", ['rate@example.com']);
  assert.equal((await create((await slot()).id, 'rate@example.com')).status, 201);
});

test('slot conflicts and nonexistent slots count as attempts; validation errors do not', async () => {
  const available = await slot();
  assert.equal((await create(available.id, 'owner@example.com')).status, 201);
  const invalid = await request('/bookings', { method: 'POST', body: JSON.stringify({ email: 'failed@example.com' }) });
  assert.equal(invalid.status, 400);
  assert.equal(await attempts('failed@example.com'), 0);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await create(index % 2 ? randomUUID() : available.id, 'failed@example.com')).status, index % 2 ? 404 : 409);
  }
  assert.equal((await create(available.id, 'failed@example.com')).status, 429);
  assert.equal(await attempts('failed@example.com'), 5);
});

test('idempotency replays business errors, including 429 and Retry-After', async () => {
  const key = randomUUID();
  const missingId = randomUUID();
  const missing = await create(missingId, 'missing-key@example.com', key);
  assert.equal(missing.status, 404);
  assert.deepEqual((await create(missingId, 'missing-key@example.com', key)).body, missing.body);
  assert.equal(await attempts('missing-key@example.com'), 1);
  const available = await slot();
  for (let index = 0; index < 5; index += 1) await create(randomUUID(), 'limited-key@example.com');
  const rateKey = randomUUID();
  const original = await create(available.id, 'limited-key@example.com', rateKey);
  assert.equal(original.status, 429);
  await pool.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '61 seconds' WHERE email = $1", ['limited-key@example.com']);
  const replay = await create(available.id, 'limited-key@example.com', rateKey);
  assert.equal(replay.status, 429);
  assert.deepEqual(replay.body, original.body);
  assert.equal(replay.headers.get('retry-after'), original.headers.get('retry-after'));
  assert.equal((await create(available.id, 'limited-key@example.com', randomUUID())).status, 201);
});

test('pagination preserves stable ordering even when timestamps are identical', async () => {
  const email = 'pages@example.com';
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await create((await slot()).id, email);
    assert.equal(response.status, 201);
    ids.push(response.body.booking.id);
  }
  await pool.query('UPDATE bookings SET created_at = $1 WHERE email = $2', ['2030-01-01T00:00:00.123Z', email]);
  const seen = [];
  let cursor = null;
  do {
    const response = await request(`/bookings?email=${email}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(response.status, 200);
    seen.push(...response.body.bookings.map(booking => booking.id));
    cursor = response.body.next_cursor;
    assert.ok(seen.length <= 3);
  } while (cursor);
  assert.deepEqual(seen, ids.sort().reverse());
  const unfiltered = await request('/bookings?limit=2');
  assert.equal(unfiltered.body.bookings.length, 2);
  assert.ok(unfiltered.body.next_cursor);
  assert.equal((await request(`/bookings?limit=2&cursor=${encodeURIComponent(unfiltered.body.next_cursor)}`)).status, 200);
});

test('missing bookings return 404, and past slots cannot be booked', async () => {
  const id = randomUUID();
  assert.equal((await request(`/bookings/${id}`)).status, 404);
  assert.equal((await request(`/bookings/${id}`, { method: 'DELETE' })).status, 404);
  const past = await slot(true);
  assert.equal((await create(past.id, 'past@example.com')).status, 409);
  assert.equal((await request('/slots')).body.slots.find(item => item.id === past.id).available, false);
});

test('documented migration, seed and server entry points work with an isolated database', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = {
    ...process.env, DATABASE_URL: url.toString(), API_KEY: apiKey, NODE_ENV: 'test', PORT: String(port),
    SEED_START: new Date(Date.now() + 3 * 86400000).toISOString(), SEED_SLOT_COUNT: '3'
  };
  const execute = promisify(execFile);
  const migration = await execute(process.execPath, ['src/database/migrate.js'], { env });
  assert.equal(JSON.parse(migration.stdout.trim()).event, 'migrations_complete');
  const seeded = await execute(process.execPath, ['src/database/seed.js'], { env });
  assert.equal(JSON.parse(seeded.stdout.trim()).inserted, 3);
  const repeated = await execute(process.execPath, ['src/database/seed.js'], { env });
  assert.equal(JSON.parse(repeated.stdout.trim()).inserted, 0);
  const child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        let output = '';
        child.once('error', reject);
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('"event":"listening"')) resolve();
        });
      }),
      exited.then(() => { throw new Error('Server exited before listening.'); })
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-API-Key': apiKey } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
});