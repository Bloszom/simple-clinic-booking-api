import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './app.js';
import { gatewayConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
dotenv.config({ path: path.join(root, '../.env'), quiet: true });
const production = process.argv.includes('--production');
const config = gatewayConfig({ ...process.env, NODE_ENV: production ? 'production' : 'development' });
const app = createGateway(config);
const port = Number(process.env.WEB_PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT must be a valid port.');
let vite;

if (production) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(port, '0.0.0.0', () => console.log(`Clinic frontend: http://localhost:${port}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Choose another WEB_PORT.` : 'Frontend server could not start.');
  process.exitCode = 1;
  vite?.close();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => { await vite?.close(); }));
}