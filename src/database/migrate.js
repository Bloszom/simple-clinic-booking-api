const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inTransaction, createPool } = require('./pool');
const { loadConfig } = require('../utils/config');

async function migrate(pool) {
  const directory = path.join(__dirname, 'migrations');
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return inTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('clinic-schema-migrations', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = [];
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const { rows: [existing] } = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    return applied;
  });
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  (async () => {
    const pool = createPool(loadConfig());
    try {
      console.log(JSON.stringify({ event: 'migrations_complete', applied: await migrate(pool) }));
    } finally {
      await pool.end();
    }
  })().catch(error => {
    console.error(error.code ? `Migration failed (${error.code}).` : error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };