const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { bookingInput, idempotencyKey, pageInput } = require('../src/utils/validation');
const { encodeCursor, decodeCursor } = require('../src/utils/cursor');

test('booking validation normalizes names, emails and UUIDs', () => {
  const id = randomUUID();
  assert.deepEqual(bookingInput({ slot_id: id.toUpperCase(), name: ' Jane Doe ', email: ' JANE@Example.com ' }), {
    slot_id: id, name: 'Jane Doe', email: 'jane@example.com'
  });
});

test('booking validation rejects missing fields, malformed emails and oversized names', () => {
  const valid = { slot_id: randomUUID(), name: 'Jane', email: 'jane@example.com' };
  for (const body of [null, [], {}, { ...valid, slot_id: 'bad' }, { ...valid, name: ' ' },
    { ...valid, name: 'a'.repeat(121) }, { ...valid, email: 'not-email' },
    { ...valid, email: 'a..b@example.com' }, { ...valid, name: 'Jane\u0000' }]) {
    assert.throws(() => bookingInput(body), { status: 400 });
  }
});

test('idempotency key and pagination limit validation', () => {
  assert.equal(idempotencyKey(undefined), undefined);
  assert.equal(idempotencyKey('retry-1'), 'retry-1');
  for (const key of ['', 'x'.repeat(129), 'bad key', ['duplicate']]) assert.throws(() => idempotencyKey(key));
  assert.equal(pageInput({}, () => null).limit, 20);
  for (const limit of ['0', '101', '2.5', ['2'], '1e1']) assert.throws(() => pageInput({ limit }, () => null));
});

test('cursor round trips and rejects tampering or a different filter', () => {
  const secret = 'test-secret';
  const booking = { id: randomUUID(), created_at: new Date() };
  const cursor = encodeCursor(booking, 'jane@example.com', secret);
  assert.equal(decodeCursor(cursor, 'jane@example.com', secret).id, booking.id);
  assert.throws(() => decodeCursor(`${cursor}x`, 'jane@example.com', secret), { status: 400 });
  assert.throws(() => decodeCursor(cursor, null, secret), { status: 400 });
  assert.throws(() => decodeCursor(cursor, 'jane@example.com', 'different-secret'), { status: 400 });
});