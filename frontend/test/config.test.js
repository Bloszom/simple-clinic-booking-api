import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayConfig } from '../server/config.js';

const apiKey = 'test-key'.padEnd(40, 'x');

test('development uses the local API, and production requires HTTPS', () => {
  assert.equal(gatewayConfig({ API_KEY: apiKey }).apiBaseUrl, 'http://localhost:3000');
  assert.equal(gatewayConfig({ API_KEY: apiKey, API_BASE_URL: 'https://clinic.example/', NODE_ENV: 'production' }).apiBaseUrl,
    'https://clinic.example');
  for (const env of [{}, { API_KEY: 'short' }, { API_KEY: apiKey, NODE_ENV: 'production' },
    { API_KEY: apiKey, API_BASE_URL: 'http://clinic.example', NODE_ENV: 'production' },
    { API_KEY: apiKey, API_BASE_URL: 'https://user:password@clinic.example' }]) {
    assert.throws(() => gatewayConfig(env));
  }
});