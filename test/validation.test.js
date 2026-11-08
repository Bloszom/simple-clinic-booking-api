const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { bookingInput, idempotencyKey, pageInput, resetInput, providerInput } = require('../src/utils/validation');
const { encodeCursor, decodeCursor } = require('../src/utils/cursor');
const { requestHash } = require('../src/services/idempotencyService');

test('booking validation accepts string slot IDs and normalizes names and emails', () => {
  assert.deepEqual(bookingInput({ slot_id: 's1', name: ' Jane Doe ', email: ' JANE@Example.com ' }), {
    slot_id: 's1', name: 'Jane Doe', email: 'jane@example.com'
  });
  assert.equal(bookingInput({ slot_id: 'S1', name: 'a'.repeat(121), email: 'jane@example.com' }).slot_id, 'S1');
});

test('booking validation rejects missing fields and malformed emails', () => {
  const valid = { slot_id: randomUUID(), name: 'Jane', email: 'jane@example.com' };
  for (const body of [null, [], {}, { ...valid, slot_id: '' }, { ...valid, slot_id: 1 }, { ...valid, name: ' ' },
    { ...valid, email: 'not-email' },
    { ...valid, email: 'a..b@example.com' }, { ...valid, name: 'Jane\u0000' }]) {
    assert.throws(() => bookingInput(body), { status: 400 });
  }
});

test('idempotency key and pagination limit validation', () => {
  assert.equal(idempotencyKey(undefined), undefined);
  assert.equal(idempotencyKey('retry-1'), 'retry-1');
  assert.equal(idempotencyKey(''), '');
  assert.equal(idempotencyKey('key with spaces'), 'key with spaces');
  assert.throws(() => idempotencyKey(['duplicate']));
  assert.throws(() => pageInput({}, () => null));
  assert.equal(pageInput({ email: 'jane@example.com' }, () => null).limit, 10);
  for (const limit of ['0', '51', '2.5', ['2'], '1e1']) {
    assert.throws(() => pageInput({ email: 'jane@example.com', limit }, () => null));
  }
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

test('idempotency hashes ignore object key order but not different payload values', () => {
  const body = { slot_id: 's1', name: 'Jane', email: 'jane@example.com' };
  assert.equal(requestHash(body), requestHash({ email: body.email, name: body.name, slot_id: body.slot_id }));
  assert.notEqual(requestHash(body), requestHash({ ...body, name: ' Jane ' }));
  assert.notEqual(requestHash(body), requestHash({ ...body, extra: true }));
});

test('reset validation accepts past slots, arbitrary IDs, and simultaneous providers', () => {
  const slots = [{ id: 's1', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }];
  assert.deepEqual(resetInput({ slots }), slots);
  assert.deepEqual(resetInput({ slots: [] }), []);
  assert.equal(resetInput({ slots: [...slots, { ...slots[0], id: 's2', provider: 'Dr Obi' }] }).length, 2);
  assert.equal(providerInput('Dr Ade'), 'Dr Ade');
  assert.throws(() => providerInput(['Dr Ade']));
  for (const body of [{}, { slots: null }, { slots: [null] }, { slots: [...slots, slots[0]] },
    { slots: [{ ...slots[0], provider: '' }] }, { slots: [{ ...slots[0], end: slots[0].start }] },
    { slots: [{ ...slots[0], start: '2026-02-30T09:00:00Z' }] },
    { slots: [{ ...slots[0], start: '2020-01-01T09:00:00' }] }]) {
    assert.throws(() => resetInput(body), { status: 400 });
  }
});