const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../src/app');

const apiKey = 'test-api-key-'.padEnd(40, 'x');
let server;
let baseUrl;
let databaseDown = false;
let queries = 0;

before(async () => {
  server = createApp({
    config: { apiKey, corsOrigins: ['https://clinic.example'] },
    pool: { async query() {
      queries += 1;
      if (databaseDown) throw new Error('Private connection details');
      return { rows: [] };
    } }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'X-API-Key': apiKey, ...options.headers } });
  return { response, body: await response.json() };
}

test('every endpoint, including health, rejects missing or invalid API keys', async () => {
  const initial = queries;
  for (const [path, method] of [['/health', 'GET'], ['/reset', 'POST'], ['/slots', 'GET'], ['/bookings', 'GET'],
    ['/bookings', 'POST'], [`/bookings/${randomUUID()}`, 'GET'], [`/bookings/${randomUUID()}`, 'DELETE']]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await request('/health', { headers: { 'X-API-Key': 'wrong' } })).response.status, 401);
  assert.equal(queries, initial);
});

test('health checks the database, returns JSON, and hides failures', async () => {
  const healthy = await request('/health');
  assert.equal(healthy.response.status, 200);
  assert.deepEqual(healthy.body, { status: 'ok', database: 'connected' });
  assert.equal(healthy.response.headers.get('cache-control'), 'no-store');
  assert.equal(healthy.response.headers.get('x-powered-by'), null);
  databaseDown = true;
  try {
    const unhealthy = await request('/health');
    assert.equal(unhealthy.response.status, 503);
    assert.equal(unhealthy.response.headers.get('retry-after'), '1');
    assert.ok(!JSON.stringify(unhealthy.body).includes('Private'));
  } finally { databaseDown = false; }
});

test('malformed JSON, missing fields, bad media types and oversized bodies are JSON errors', async () => {
  const initial = queries;
  for (const [body, contentType, status] of [
    ['{', 'application/json', 400],
    ['{}', 'application/json', 400],
    ['null', 'application/json', 400],
    ['{}', 'text/plain', 415],
    [JSON.stringify({ name: 'a'.repeat(17000) }), 'application/json', 413]
  ]) {
    const result = await request('/bookings', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal(result.response.status, status);
    assert.equal(typeof result.body.error, 'string');
    assert.deepEqual(Object.keys(result.body), ['error']);
    assert.ok(result.response.headers.get('x-request-id'));
  }
  assert.equal(queries, initial);
});

test('unknown IDs, bad pagination and unsupported routes or methods have correct errors', async () => {
  for (const [path, method, status] of [['/bookings/not-a-uuid', 'GET', 404],
    ['/bookings/not-a-uuid', 'DELETE', 404], ['/bookings', 'GET', 400],
    ['/bookings?email=jane@example.com&limit=51', 'GET', 400],
    ['/bookings?email=jane@example.com&cursor=invalid', 'GET', 400],
    ['/slots?provider=Dr+Ade&provider=Dr+Obi', 'GET', 400],
    ['/unknown', 'GET', 404], ['/slots', 'PUT', 405], ['/reset', 'GET', 405]]) {
    assert.equal((await request(path, { method })).response.status, status);
  }
});

test('CORS permits configured origins and standard preflight without exposing API data', async () => {
  const allowed = await request('/health', { headers: { Origin: 'https://clinic.example' } });
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'https://clinic.example');
  assert.equal((await request('/health', { headers: { Origin: 'https://evil.example' } })).response.status, 403);
  const preflight = await fetch(`${baseUrl}/bookings`, { method: 'OPTIONS', headers: {
    Origin: 'https://clinic.example', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-api-key,idempotency-key'
  } });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('X-API-Key'));
});

test('invalid reset input fails before database access', async () => {
  const initial = queries;
  const result = await request('/reset', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(result.response.status, 400);
  assert.equal(typeof result.body.error, 'string');
  assert.equal(queries, initial);
});