export class ApiError extends Error {
  constructor(message, status = 503, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function request(path, options = {}) {
  let response;
  let body;
  try {
    response = await fetch(path, {
      ...options, credentials: 'same-origin', signal: options.signal || AbortSignal.timeout(65000),
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    body = await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('The clinic is temporarily unavailable. Please try again.');
  }
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : 'This request could not be completed.',
      response.status, Math.max(0, Number(response.headers.get('Retry-After')) || 0));
  }
  return body;
}

let memoryPending;

export async function bookingKey(payload, storage = globalThis.sessionStorage) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  let pending = memoryPending;
  try { pending = JSON.parse(storage?.getItem('clinic_pending') || 'null') || pending; } catch { /* Private browsing may disable storage. */ }
  if (pending?.fingerprint !== fingerprint) pending = { fingerprint, key: crypto.randomUUID() };
  memoryPending = pending;
  try { storage?.setItem('clinic_pending', JSON.stringify(pending)); } catch { /* In-memory retries remain protected. */ }
  return pending.key;
}

export function clearBookingKey(storage = globalThis.sessionStorage) {
  memoryPending = undefined;
  try { storage?.removeItem('clinic_pending'); } catch { /* Storage is optional. */ }
}