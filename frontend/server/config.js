export function gatewayConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const apiBaseUrl = env.API_BASE_URL || (production ? '' : 'http://localhost:3000');
  let url;
  try { url = new URL(apiBaseUrl); }
  catch { throw new Error('API_BASE_URL must be a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API_BASE_URL must be a plain HTTP(S) base URL.');
  }
  if (production && url.protocol !== 'https:') throw new Error('Production API_BASE_URL must use HTTPS.');
  if (!env.API_KEY || env.API_KEY.length < 32) throw new Error('A server-side API_KEY of at least 32 characters is required.');
  return { apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''), apiKey: env.API_KEY, production };
}