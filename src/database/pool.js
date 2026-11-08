const { Pool } = require('pg');

function createPool(config) {
  // Neon URLs must use sslmode=verify-full; never disable certificate verification.
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15000,
    application_name: 'clinic-booking-api'
  });
  pool.on('error', error => {
    console.error(JSON.stringify({ event: 'database_pool_error', code: error.code || 'UNKNOWN' }));
  });
  return pool;
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function lockBookingState(client, exclusive = false) {
  const lock = exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  await client.query(`SELECT ${lock}(hashtextextended('clinic-booking-state', 0))`);
}

module.exports = { createPool, inTransaction, lockBookingState };