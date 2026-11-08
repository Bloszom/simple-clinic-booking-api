const isEmail = require('validator/lib/isEmail');
const isISO8601 = require('validator/lib/isISO8601');
const { AppError } = require('./errors');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(field, message) {
  throw new AppError(400, 'VALIDATION_ERROR', `${field}: ${message}`);
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
  if (typeof body.slot_id !== 'string' || !body.slot_id.trim() || body.slot_id.includes('\u0000')) {
    invalid('slot_id', 'Slot ID is required and must be a nonempty string.');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) invalid('name', 'Name is required.');
  const name = body.name.trim();
  if (/[\x00-\x1f\x7f]/.test(name)) invalid('name', 'Must not contain control characters.');
  return { slot_id: body.slot_id, name, email: email(body.email) };
}

function idempotencyKey(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid('Idempotency-Key', 'Must be a string.');
  return value;
}

function pageInput(query, decode) {
  const normalizedEmail = email(query.email);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if ((query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit))) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50) {
    invalid('limit', 'Must be an integer between 1 and 50.');
  }
  return { email: normalizedEmail, limit, cursor: query.cursor === undefined ? null : decode(query.cursor, normalizedEmail) };
}

function providerInput(value) {
  if (value !== undefined && typeof value !== 'string') invalid('provider', 'Must be a string.');
  return value;
}

function resetInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.slots)) {
    invalid('slots', 'A slots array is required.');
  }
  const ids = new Set();
  return body.slots.map((slot, index) => {
    const field = `slots[${index}]`;
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) invalid(field, 'Must be an object.');
    if (typeof slot.id !== 'string' || !slot.id.trim() || slot.id.includes('\u0000')) invalid(field, 'A nonempty string ID is required.');
    if (ids.has(slot.id)) invalid(field, 'Slot IDs must be unique.');
    ids.add(slot.id);
    if (typeof slot.provider !== 'string' || !slot.provider.trim() || slot.provider.includes('\u0000')) {
      invalid(field, 'A nonempty provider is required.');
    }
    for (const key of ['start', 'end']) {
      if (typeof slot[key] !== 'string' || !isISO8601(slot[key], { strict: true, strictSeparator: true }) ||
          !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(slot[key]) || !Number.isFinite(new Date(slot[key]).getTime())) {
        invalid(`${field}.${key}`, 'Must be an ISO date-time with a timezone.');
      }
    }
    if (new Date(slot.end) <= new Date(slot.start)) invalid(field, 'End must be after start.');
    return { id: slot.id, provider: slot.provider, start: slot.start, end: slot.end };
  });
}

module.exports = { uuid, email, bookingInput, idempotencyKey, pageInput, providerInput, resetInput, UUID_PATTERN };