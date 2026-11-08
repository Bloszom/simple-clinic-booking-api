const { createHash } = require('node:crypto');
const { AppError } = require('../utils/errors');

function requestHash(booking) {
  return createHash('sha256').update(JSON.stringify({
    operation: 'POST /bookings', slot_id: booking.slot_id, name: booking.name, email: booking.email
  })).digest('hex');
}

async function reserveKey(client, key, hash) {
  if (!key) return null;
  // A conflicting insert waits for the first transaction, then sees its committed response.
  const inserted = await client.query(`
    INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
    ON CONFLICT (key) DO NOTHING RETURNING id
  `, [key, hash]);
  if (inserted.rowCount) return null;
  const { rows: [record] } = await client.query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
  if (record.request_hash !== hash) {
    throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with a different request.');
  }
  if (record.response_status === null) {
    throw new AppError(503, 'IDEMPOTENCY_PENDING', 'The original request is not complete. Retry later.');
  }
  return { status: record.response_status, body: record.response_body, headers: record.response_headers, replayed: true };
}

async function storeResponse(client, key, response) {
  if (!key) return;
  await client.query(`
    UPDATE idempotency_keys SET response_status = $2, response_body = $3::jsonb,
      response_headers = $4::jsonb WHERE key = $1
  `, [key, response.status, JSON.stringify(response.body), JSON.stringify(response.headers)]);
}

module.exports = { requestHash, reserveKey, storeResponse };