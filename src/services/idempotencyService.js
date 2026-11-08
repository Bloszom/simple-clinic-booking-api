const { createHash } = require('node:crypto');
const { AppError } = require('../utils/errors');

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function requestHash(body) {
  return createHash('sha256').update(JSON.stringify({ operation: 'POST /bookings', body: canonicalJson(body ?? null) })).digest('hex');
}

function legacyRequestHash(booking) {
  if (!booking) return null;
  return createHash('sha256').update(JSON.stringify({
    operation: 'POST /bookings', slot_id: booking.slot_id, name: booking.name, email: booking.email
  })).digest('hex');
}

async function reserveKey(client, key, body, booking) {
  if (key === undefined) return null;
  const hash = requestHash(body);
  // A conflicting insert waits for the first transaction, then sees its committed response.
  const inserted = await client.query(`
    INSERT INTO idempotency_keys (key, request_hash, request_body) VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (key) DO NOTHING RETURNING id
  `, [key, hash, JSON.stringify(body ?? null)]);
  if (inserted.rowCount) return null;
  const { rows: [record] } = await client.query('SELECT *, request_body IS NULL AS legacy FROM idempotency_keys WHERE key = $1', [key]);
  if (record.request_hash !== (record.legacy ? legacyRequestHash(booking) : hash)) {
    throw new AppError(422, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with a different request.');
  }
  if (record.response_status === null) {
    throw new AppError(503, 'IDEMPOTENCY_PENDING', 'The original request is not complete. Retry later.');
  }
  return { status: record.response_status, body: record.response_body, headers: record.response_headers, replayed: true };
}

async function storeResponse(client, key, response) {
  if (key === undefined) return;
  await client.query(`
    UPDATE idempotency_keys SET response_status = $2, response_body = $3::jsonb,
      response_headers = $4::jsonb WHERE key = $1
  `, [key, response.status, JSON.stringify(response.body), JSON.stringify(response.headers)]);
}

module.exports = { requestHash, reserveKey, storeResponse };