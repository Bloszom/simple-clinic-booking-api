const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/utils/config');

const valid = { DATABASE_URL: 'postgresql://user:password@localhost/clinic', API_KEY: 'a'.repeat(32) };

test('loads valid configuration and explicit CORS origins', () => {
  const config = loadConfig({ ...valid, CORS_ORIGINS: 'https://clinic.example, https://admin.example' });
  assert.equal(config.port, 3000);
  assert.deepEqual(config.corsOrigins, ['https://clinic.example', 'https://admin.example']);
  assert.ok(Object.isFrozen(config));
});

test('fails fast on missing or invalid deployment configuration', () => {
  for (const env of [{}, { ...valid, DATABASE_URL: 'https://example.com' },
    { ...valid, API_KEY: 'short' }, { ...valid, PORT: 'invalid' },
    { ...valid, CORS_ORIGINS: '*' }]) {
    assert.throws(() => loadConfig(env));
  }
});

test('production requires verified database TLS', () => {
  assert.throws(() => loadConfig({ ...valid, NODE_ENV: 'production' }), /sslmode=verify-full/);
  assert.throws(() => loadConfig({ ...valid, NODE_ENV: 'prod' }), /NODE_ENV/);
  const config = loadConfig({ ...valid, NODE_ENV: 'production', DATABASE_URL: `${valid.DATABASE_URL}?sslmode=verify-full` });
  assert.equal(config.nodeEnv, 'production');
});