import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';

const COOKIE = 'clinic_confirmation';
const ADMIN_COOKIE = 'clinic_admin';
const ADMIN_LIFETIME = 4 * 60 * 60;

function signature(id, key) {
  return createHmac('sha256', key).update(`clinic-web-confirmation:${id}`).digest('base64url');
}

function bookingId(req, key) {
  const token = parse(req.headers.cookie || '')[COOKIE];
  if (!token) return null;
  const [id, supplied, extra] = token.split('.');
  if (extra || !id || !supplied || !/^[a-f0-9-]{36}$/i.test(id)) return null;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(signature(id, key));
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null;
}

export function createGateway({ apiBaseUrl, apiKey, adminPassword, production = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (production) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: production ? undefined : false,
    strictTransportSecurity: production ? undefined : false }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'Origin is not allowed.' });
    }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests. Please try again shortly.' } }));
  app.use(express.json({ limit: '16kb' }));

  function adminSignature(expiry) {
    return createHmac('sha256', adminPassword).update(`clinic-admin-session:${expiry}`).digest('base64url');
  }

  function isAdmin(req) {
    if (!adminPassword) return false;
    const token = parse(req.headers.cookie || '')[ADMIN_COOKIE];
    if (!token) return false;
    const [expiry, supplied, extra] = token.split('.');
    if (extra || !/^\d+$/.test(expiry || '') || Number(expiry) <= Date.now() || !supplied) return false;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(adminSignature(expiry));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Administrator sign-in is required.' });
    next();
  }

  function adminCookie(value, maxAge) {
    return serialize(ADMIN_COOKIE, value, { httpOnly: true, sameSite: 'strict', secure: production,
      path: '/api', maxAge });
  }

  app.get('/api/admin/session', (req, res) => {
    res.json({ enabled: Boolean(adminPassword), authenticated: isAdmin(req) });
  });
  app.post('/api/admin/login', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please try again shortly.' } }), (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    if (!adminPassword) return res.status(503).json({ error: 'Administration is not configured.' });
    const password = req.body?.password;
    if (typeof password !== 'string' || !timingSafeEqual(createHash('sha256').update(password).digest(),
      createHash('sha256').update(adminPassword).digest())) return res.status(401).json({ error: 'Invalid administrator password.' });
    const expiry = String(Date.now() + ADMIN_LIFETIME * 1000);
    res.set('Set-Cookie', adminCookie(`${expiry}.${adminSignature(expiry)}`, ADMIN_LIFETIME));
    res.json({ authenticated: true });
  });
  app.delete('/api/admin/session', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    res.set('Set-Cookie', adminCookie('', 0));
    res.json({ authenticated: false });
  });

  async function upstream(path, { method = 'GET', body, key } = {}) {
    const headers = { 'X-API-Key': apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(55000), redirect: 'error'
    });
    const data = await response.json();
    return { status: response.status, data, retryAfter: response.headers.get('Retry-After') };
  }

  function send(res, response) {
    if (response.retryAfter) res.set('Retry-After', response.retryAfter);
    // Upstream authentication failures must not reveal server configuration details.
    if ([401, 403].includes(response.status)) return res.status(502).json({ error: 'The clinic is temporarily unavailable.' });
    return res.status(response.status).json(response.data);
  }

  app.get('/api/slots', async (req, res) => {
    send(res, await upstream('/slots'));
  });
  app.get('/api/bookings', requireAdmin, async (req, res) => {
    const query = new URLSearchParams();
    for (const field of ['email', 'limit', 'cursor']) {
      if (req.query[field] === undefined) continue;
      if (typeof req.query[field] !== 'string') return res.status(400).json({ error: `${field} must be a string.` });
      query.set(field, req.query[field]);
    }
    send(res, await upstream(`/bookings?${query}`));
  });
  app.post('/api/reset', requireAdmin, async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    if (req.get('X-Confirm-Reset') !== 'RESET') return res.status(400).json({ error: 'Explicit reset confirmation is required.' });
    send(res, await upstream('/reset', { method: 'POST', body: req.body }));
  });
  app.get('/api/bookings/:id', requireAdmin, async (req, res) => {
    send(res, await upstream(`/bookings/${encodeURIComponent(req.params.id)}`));
  });
  app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    send(res, await upstream(`/bookings/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' }));
  });
  app.post('/api/bookings', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many booking requests. Please try again shortly.' } }), async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    const result = await upstream('/bookings', { method: 'POST', body: req.body, key: req.get('Idempotency-Key') });
    if (result.status === 201) {
      const id = result.data.id;
      res.set('Set-Cookie', serialize(COOKIE, `${id}.${signature(id, apiKey)}`, {
        httpOnly: true, sameSite: 'strict', secure: production, path: '/api/confirmation', maxAge: 86400
      }));
    }
    send(res, result);
  });
  app.get('/api/confirmation', async (req, res) => {
    const id = bookingId(req, apiKey);
    if (!id) return res.status(404).json({ error: 'No appointment confirmation in this browser.' });
    const result = await upstream(`/bookings/${encodeURIComponent(id)}`);
    if (result.status !== 200) return send(res, result);
    const slots = await upstream('/slots');
    res.json({ booking: result.data, slot: slots.status === 200
      ? slots.data.slots.find(slot => slot.id === result.data.slot_id) || null : null });
  });
  app.delete('/api/confirmation', async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    const id = bookingId(req, apiKey);
    if (!id) return res.status(404).json({ error: 'No appointment confirmation in this browser.' });
    send(res, await upstream(`/bookings/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api')) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    console.error(JSON.stringify({ event: 'gateway_error', name: error.name,
      code: error.cause?.code || error.code || 'UNKNOWN' }));
    res.status(503).json({ error: 'The clinic is temporarily unavailable. Please try again.' });
  });
  return app;
}