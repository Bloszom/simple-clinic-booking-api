const { inTransaction, lockBookingState } = require('../database/pool');

function createSlotService(pool) {
  return {
    async list(provider) {
      const { rows } = await pool.query(`
        SELECT slots.external_id AS id, slots.provider, slots.starts_at AS start, slots.ends_at AS "end",
          NOT EXISTS (
            SELECT 1 FROM bookings WHERE bookings.slot_id = slots.id AND bookings.status = 'confirmed'
          ) AS available
        FROM slots ${provider === undefined ? '' : 'WHERE provider = $1'} ORDER BY starts_at, external_id
      `, provider === undefined ? [] : [provider]);
      return rows;
    },
    async reset(slots) {
      return inTransaction(pool, async client => {
        await lockBookingState(client, true);
        await client.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
        await client.query(`
          INSERT INTO slots (external_id, provider, starts_at, ends_at)
          SELECT id, provider, "start", "end" FROM jsonb_to_recordset($1::jsonb)
            AS replacement(id TEXT, provider TEXT, "start" TIMESTAMPTZ, "end" TIMESTAMPTZ)
        `, [JSON.stringify(slots)]);
        return { status: 'ok' };
      });
    }
  };
}

module.exports = { createSlotService };