require('dotenv').config({ quiet: true });
const { loadConfig } = require('./utils/config');
const { createPool } = require('./database/pool');
const { createApp } = require('./app');

async function start() {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw error;
  }
  const server = createApp({ pool, config }).listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'listening', port: config.port }));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  let shuttingDown = false;

  function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    server.close(async () => {
      try {
        await pool.end();
        clearTimeout(deadline);
        process.exitCode = exitCode;
      } catch {
        process.exitCode = 1;
      }
    });
  }

  process.once('SIGTERM', () => shutdown());
  process.once('SIGINT', () => shutdown());
  server.on('error', error => {
    console.error(JSON.stringify({ event: 'server_error', code: error.code || 'UNKNOWN' }));
    shutdown(1);
  });
  for (const event of ['unhandledRejection', 'uncaughtException']) {
    process.once(event, () => {
      console.error(JSON.stringify({ event: 'fatal_error', type: event }));
      shutdown(1);
    });
  }
}

start().catch(error => {
  console.error(JSON.stringify({ event: 'startup_error', message: error.code ? 'Database connection failed.' : error.message }));
  process.exitCode = 1;
});