import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingKey, clearBookingKey } from '../src/lib/api.js';
import { dayKey, duration } from '../src/lib/dates.js';

test('booking retries reuse their key without storing patient data', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const payload = { slot_id: 's1', name: 'Test Patient', email: 'test@example.com' };
  const first = await bookingKey(payload, storage);
  assert.equal(await bookingKey(payload, storage), first);
  assert.ok(!values.get('clinic_pending').includes(payload.email));
  assert.notEqual(await bookingKey({ ...payload, slot_id: 's2' }, storage), first);
  clearBookingKey(storage);
  assert.notEqual(await bookingKey(payload, storage), first);
  clearBookingKey(storage);
});

test('schedule helpers use local calendar days and appointment duration', () => {
  assert.equal(dayKey(new Date(2030, 0, 2, 9)), '2030-01-02');
  assert.equal(duration({ start: '2030-01-02T09:00:00Z', end: '2030-01-02T09:30:00Z' }), 30);
});