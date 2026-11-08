const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function main() {
  let database;
  let directory;
  let started = false;
  let url = process.env.TEST_DATABASE_URL;
  try {
    if (!url) {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      directory = await mkdtemp(path.join(tmpdir(), 'clinic-postgres-'));
      const port = await freePort();
      const password = randomUUID();
      database = new EmbeddedPostgres({
        databaseDir: path.join(directory, 'db'), port, user: 'postgres', password,
        persistent: false, createPostgresUser: false,
        postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError(message) { console.error(message); }
      });
      await database.initialise();
      await database.start();
      started = true;
      url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
      console.log('Running integration tests against disposable local PostgreSQL.');
    }
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--test', 'test/integration/bookings.test.js'], {
        stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url }
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    if (started) await database.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});