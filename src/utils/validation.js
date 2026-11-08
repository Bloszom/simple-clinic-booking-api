const isEmail = require('validator/lib/isEmail');
const { AppError } = require('./errors');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(field, message) {
  throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', [{ field, message }]);
}

function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(field, 'Must be a valid UUID.');
  return value.toLowerCase();
}

function email(value) {
  if (typeof value !== 'string') invalid('email', 'Email is required.');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !isEmail(normalized)) invalid('email', 'Must be a valid email address.');
  return normalized;
}

function bookingInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('body', 'Must be a JSON object.');
  const slotId = uuid(body.slot_id, 'slot_id');
  if (typeof body.name !== 'string' || !body.name.trim()) invalid('name', 'Name is required.');
  const name = body.name.trim();
  if (name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) invalid('name', 'Must be at most 120 characters without control characters.');
  return { slot_id: slotId, name, email: email(body.email) };
}

function idempotencyKey(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    invalid('Idempotency-Key', 'Must contain 1-128 letters, digits, dots, underscores, colons or hyphens.');
  }
  return value;
}

function pageInput(query, decode) {
  const normalizedEmail = query.email === undefined ? null : email(query.email);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if ((query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit))) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) {
    invalid('limit', 'Must be an integer between 1 and 100.');
  }
  return { email: normalizedEmail, limit, cursor: query.cursor === undefined ? null : decode(query.cursor, normalizedEmail) };
}

module.exports = { uuid, email, bookingInput, idempotencyKey, pageInput, UUID_PATTERN };