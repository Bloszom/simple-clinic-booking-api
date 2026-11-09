import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gatewayConfig } from '../server/config.js';

const apiKey = 'test-key'.padEnd(40, 'x');

test('development uses the local API, and production requires HTTPS', () => {
  assert.equal(gatewayConfig({ API_KEY: apiKey }).apiBaseUrl, 'http://localhost:3000');
  assert.equal(gatewayConfig({ API_KEY: apiKey, API_BASE_URL: 'https://clinic.example/', NODE_ENV: 'production' }).apiBaseUrl,
    'https://clinic.example');
  for (const env of [{}, { API_KEY: 'short' }, { API_KEY: apiKey, NODE_ENV: 'production' },
    { API_KEY: apiKey, API_BASE_URL: 'http://clinic.example', NODE_ENV: 'production' },
    { API_KEY: apiKey, ADMIN_PASSWORD: 'short' },
    { API_KEY: apiKey, API_BASE_URL: 'https://user:password@clinic.example' }]) {
    assert.throws(() => gatewayConfig(env));
  }
});

test('Vercel explicitly routes API requests to the function before the SPA fallback', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const path of ['/api', '/api/slots', '/api/bookings', '/api/bookings/test-id', '/api/admin/session', '/api/reset']) {
    const route = config.routes.find(entry => entry.src ? new RegExp(`^${entry.src}$`).test(path) : false);
    assert.equal(route.dest, '/api/[...path].js');
    assert.ok(existsSync(new URL(`..${route.dest}`, import.meta.url)));
  }
  assert.ok(config.functions['api/[...path].js']);
  assert.equal(config.routes.at(-1).dest, '/index.html');
});