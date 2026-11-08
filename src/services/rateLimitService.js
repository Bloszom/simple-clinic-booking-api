async function recordBookingAttempt(client, email) {
  // A transaction-scoped email lock works across processes and Render replicas.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`booking-rate:${email}`]);
  const { rows: [window] } = await client.query(`
    SELECT count(*)::int AS attempts,
           GREATEST(1, ceil(extract(epoch FROM
             (min(attempted_at) + interval '1 minute' - clock_timestamp()))))::int AS retry_after
    FROM booking_attempts
    WHERE email = $1 AND attempted_at > clock_timestamp() - interval '1 minute'
  `, [email]);
  if (window.attempts >= 5) return { allowed: false, retryAfter: window.retry_after };
  await client.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
  return { allowed: true };
}

module.exports = { recordBookingAttempt };