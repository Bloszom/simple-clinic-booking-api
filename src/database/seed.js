require('dotenv').config({ quiet: true });
const { loadConfig } = require('../utils/config');
const { createPool, inTransaction, lockBookingState } = require('./pool');

async function seed() {
  const count = Number(process.env.SEED_SLOT_COUNT || 16);
  const provider = process.env.SEED_PROVIDER || 'Dr Ade';
  const defaultStart = new Date();
  defaultStart.setUTCDate(defaultStart.getUTCDate() + 1);
  defaultStart.setUTCHours(9, 0, 0, 0);
  const start = process.env.SEED_START ? new Date(process.env.SEED_START) : defaultStart;
  if (!Number.isInteger(count) || count < 1 || count > 1000 || !Number.isFinite(start.getTime()) || start <= new Date()) {
    throw new Error('SEED_SLOT_COUNT must be 1-1000 and SEED_START must be a future ISO timestamp.');
  }
  const pool = createPool(loadConfig());
  try {
    const inserted = await inTransaction(pool, async client => {
      await lockBookingState(client);
      const result = await client.query(`
        INSERT INTO slots (external_id, provider, starts_at, ends_at)
        SELECT 'seed:' || $3::text || ':' || extract(epoch FROM
                 ($1::timestamptz + index * interval '30 minutes'))::text,
               $3, $1::timestamptz + index * interval '30 minutes',
               $1::timestamptz + (index + 1) * interval '30 minutes'
        FROM generate_series(0, $2::int - 1) AS series(index)
        ON CONFLICT (external_id) DO NOTHING
      `, [start.toISOString(), count, provider]);
      return result.rowCount;
    });
    console.log(JSON.stringify({ event: 'seed_complete', inserted }));
  } finally {
    await pool.end();
  }
}

seed().catch(error => {
  console.error(error.code ? `Seed failed (${error.code}).` : error.message);
  process.exitCode = 1;
});