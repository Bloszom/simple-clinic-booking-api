import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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

before(async () => {
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res, next) => { observedKey = req.get('X-API-Key'); next(); });
  upstream.get('/slots', (req, res) => res.json({ slots: [{ id: 's1', provider: 'Dr Ade', available: true }] }));
  upstream.post('/bookings', (req, res) => {
    observedIdempotency = req.get('Idempotency-Key');
    if (limited) return res.status(429).set('Retry-After', '42').json({ error: 'Too many attempts.' });
    res.status(201).json({ id, ...req.body, status: 'confirmed' });
  });
  upstream.get(`/bookings/${id}`, (req, res) => res.json({ id, slot_id: 's1', status: cancelled ? 'cancelled' : 'confirmed' }));
  upstream.delete(`/bookings/${id}`, (req, res) => { cancelled = true; res.json({ id, status: 'cancelled' }); });
  api = upstream.listen(0, '127.0.0.1');
  await new Promise(resolve => api.once('listening', resolve));
  web = createGateway({ apiBaseUrl: `http://127.0.0.1:${api.address().port}`, apiKey }).listen(0, '127.0.0.1');
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
  assert.equal((await fetch(`${baseUrl}/api/reset`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/bookings/${id}`)).status, 404);
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
  const production = createGateway({ apiBaseUrl: `http://127.0.0.1:${api.address().port}`, apiKey, production: true })
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
  } finally { await new Promise(resolve => production.close(resolve)); }
});