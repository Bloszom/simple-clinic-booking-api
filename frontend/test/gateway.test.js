import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createGateway } from '../server/app.js';

const apiKey = 'gateway-test-secret'.padEnd(40, 'x');
const id = '11111111-1111-4111-8111-111111111111';
let api;
let web;
let baseUrl;
let observedKey;
let observedIdempotency;
let cancelled = false;
let limited = false;
let resetCalls = 0;
const adminPassword = 'test-admin-password-only';

before(async () => {
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res, next) => { observedKey = req.get('X-API-Key'); next(); });
  upstream.get('/slots', (req, res) => res.json({ slots: [{ id: 's1', provider: 'Dr Ade', available: true }] }));
  upstream.get('/bookings', (req, res) => res.json({ bookings: [{ id, email: req.query.email, status: 'confirmed' }],
    next_cursor: req.query.cursor ? null : 'page-2' }));
  upstream.post('/reset', (req, res) => { resetCalls += 1; res.json({ status: 'ok', slots: req.body.slots }); });
  upstream.post('/bookings', (req, res) => {
    observedIdempotency = req.get('Idempotency-Key');
    if (limited) return res.status(429).set('Retry-After', '42').json({ error: 'Too many attempts.' });
    res.status(201).json({ id, ...req.body, status: 'confirmed' });
  });
  upstream.get(`/bookings/${id}`, (req, res) => res.json({ id, slot_id: 's1', status: cancelled ? 'cancelled' : 'confirmed' }));
  upstream.delete(`/bookings/${id}`, (req, res) => { cancelled = true; res.json({ id, status: 'cancelled' }); });
  api = upstream.listen(0, '127.0.0.1');
  await new Promise(resolve => api.once('listening', resolve));
  web = createGateway({ apiBaseUrl: `http://127.0.0.1:${api.address().port}`, apiKey, adminPassword }).listen(0, '127.0.0.1');
  await new Promise(resolve => web.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${web.address().port}`;
});
after(async () => {
  await new Promise(resolve => web.close(resolve));
  await new Promise(resolve => api.close(resolve));
});

test('gateway injects the server key without exposing it in browser responses', async () => {
  const response = await fetch(`${baseUrl}/api/slots`);
  assert.equal(response.status, 200);
  assert.equal(observedKey, apiKey);
  assert.ok(!(await response.text()).includes(apiKey));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${baseUrl}/api/reset`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/bookings/${id}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/bookings?email=test@example.com`)).status, 401);
});

test('confirmation requires a signed cookie issued by a successful booking', async () => {
  assert.equal((await fetch(`${baseUrl}/api/confirmation`)).status, 404);
  const created = await fetch(`${baseUrl}/api/bookings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-test' },
    body: JSON.stringify({ slot_id: 's1', name: 'Test Patient', email: 'test@example.com' }) });
  assert.equal(created.status, 201);
  assert.equal(observedIdempotency, 'retry-test');
  const cookie = created.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  const header = cookie.split(';')[0];
  const confirmation = await fetch(`${baseUrl}/api/confirmation`, { headers: { Cookie: header } });
  assert.equal(confirmation.status, 200);
  assert.equal((await confirmation.json()).booking.id, id);
  assert.equal((await fetch(`${baseUrl}/api/confirmation`, { headers: { Cookie: `${header}tampered` } })).status, 404);
  const cancellation = await fetch(`${baseUrl}/api/confirmation`, { method: 'DELETE',
    headers: { Cookie: header, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(cancellation.status, 200);
  assert.equal(cancelled, true);
});

test('rate-limit responses preserve Retry-After and cross-origin mutations are rejected', async () => {
  limited = true;
  const response = await fetch(`${baseUrl}/api/bookings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '42');
  assert.equal((await fetch(`${baseUrl}/api/bookings`, { method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('production gateway issues secure cookies and respects the forwarded HTTPS origin', async () => {
  limited = false;
  const production = createGateway({ apiBaseUrl: `http://127.0.0.1:${api.address().port}`, apiKey, adminPassword, production: true })
    .listen(0, '127.0.0.1');
  await new Promise(resolve => production.once('listening', resolve));
  try {
    const port = production.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/bookings`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${port}` },
      body: JSON.stringify({ slot_id: 's1', name: 'Test Patient', email: 'test@example.com' }) });
    assert.equal(response.status, 201);
    assert.ok(response.headers.get('set-cookie').includes('Secure'));
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: `https://127.0.0.1:${port}` },
      body: JSON.stringify({ password: adminPassword }) });
    assert.equal(login.status, 200);
    assert.ok(login.headers.get('set-cookie').includes('Secure'));
    assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  } finally { await new Promise(resolve => production.close(resolve)); }
});

test('admin sign-in protects email lookup, pagination and explicit schedule reset', async () => {
  const initial = await (await fetch(`${baseUrl}/api/admin/session`)).json();
  assert.deepEqual(initial, { enabled: true, authenticated: false });
  const bad = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }) });
  assert.equal(bad.status, 401);
  const login = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(!cookie.includes(adminPassword));
  const headers = { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json' };
  const first = await fetch(`${baseUrl}/api/bookings?email=test%2Bpatient@example.com&limit=1`, { headers });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).bookings[0].email, 'test+patient@example.com');
  const second = await fetch(`${baseUrl}/api/bookings?email=test@example.com&limit=1&cursor=page-2`, { headers });
  assert.equal((await second.json()).next_cursor, null);
  assert.equal((await fetch(`${baseUrl}/api/bookings/${id}`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/reset`, { method: 'POST', headers, body: '{"slots":[]}' })).status, 400);
  assert.equal(resetCalls, 0);
  const reset = await fetch(`${baseUrl}/api/reset`, { method: 'POST', headers: { ...headers, 'X-Confirm-Reset': 'RESET' }, body: '{"slots":[]}' });
  assert.equal(reset.status, 200);
  assert.equal(resetCalls, 1);
  assert.equal((await fetch(`${baseUrl}/api/reset`, { method: 'POST', headers: { ...headers, 'X-Confirm-Reset': 'RESET', Origin: 'https://evil.example' }, body: '{"slots":[]}' })).status, 403);
  assert.equal(resetCalls, 1);
  const tampered = { ...headers, Cookie: `${headers.Cookie}tampered` };
  assert.equal((await fetch(`${baseUrl}/api/bookings?email=test@example.com`, { headers: tampered })).status, 401);
  const expiry = String(Date.now() - 1000);
  const signature = createHmac('sha256', adminPassword).update(`clinic-admin-session:${expiry}`).digest('base64url');
  assert.equal((await fetch(`${baseUrl}/api/bookings?email=test@example.com`, {
    headers: { Cookie: `clinic_admin=${expiry}.${signature}` } })).status, 401);
  const logout = await fetch(`${baseUrl}/api/admin/session`, { method: 'DELETE', headers, body: '{}' });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
});

test('administration remains disabled when its separate password is not configured', async () => {
  const disabled = createGateway({ apiBaseUrl: `http://127.0.0.1:${api.address().port}`, apiKey }).listen(0, '127.0.0.1');
  await new Promise(resolve => disabled.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${disabled.address().port}`;
    assert.deepEqual(await (await fetch(`${url}/api/admin/session`)).json(), { enabled: false, authenticated: false });
    assert.equal((await fetch(`${url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: apiKey }) })).status, 503);
    assert.equal((await fetch(`${url}/api/bookings?email=test@example.com`)).status, 401);
  } finally { await new Promise(resolve => disabled.close(resolve)); }
});