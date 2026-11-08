const { createHmac, timingSafeEqual } = require('node:crypto');
const { AppError } = require('./errors');
const { UUID_PATTERN } = require('./validation');

function sign(payload, secret) {
  return createHmac('sha256', secret).update(`booking-cursor:${payload}`).digest();
}

function encodeCursor(booking, email, secret) {
  const payload = Buffer.from(JSON.stringify({
    v: 2, created_at: new Date(booking.created_at).toISOString(), id: booking.id, email
  })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

function decodeCursor(value, email, secret) {
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const [payload, signature] = value.split('.');
    const actual = Buffer.from(signature, 'base64url');
    const expected = sign(payload, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.v !== 2 || decoded.email !== email || typeof decoded.id !== 'string' ||
        !UUID_PATTERN.test(decoded.id) || typeof decoded.created_at !== 'string' ||
        new Date(decoded.created_at).toISOString() !== decoded.created_at) throw new Error();
    return decoded;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Cursor is invalid or does not match the email filter.');
  }
}

module.exports = { encodeCursor, decodeCursor };