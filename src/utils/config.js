function loadConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test or production');
  }
  if (nodeEnv === 'production' && databaseUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Production DATABASE_URL must use sslmode=verify-full');
  }
  if (!env.API_KEY || env.API_KEY.length < 32) {
    throw new Error('API_KEY must contain at least 32 characters');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const origins = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (origins.includes('*')) throw new Error('CORS_ORIGINS must list explicit origins, not *');
  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    apiKey: env.API_KEY,
    port,
    nodeEnv,
    corsOrigins: origins
  });
}

module.exports = { loadConfig };