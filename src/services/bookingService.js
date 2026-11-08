const { inTransaction, lockBookingState } = require('../database/pool');
const { AppError, errorBody } = require('../utils/errors');
const { recordBookingAttempt } = require('./rateLimitService');
const { reserveKey, storeResponse } = require('./idempotencyService');
const { encodeCursor } = require('../utils/cursor');
const { bookingInput, UUID_PATTERN } = require('../utils/validation');

const bookingSelect = `SELECT bookings.id, slots.external_id AS slot_id,
  bookings.name, bookings.email, bookings.status, bookings.created_at
  FROM bookings JOIN slots ON slots.id = bookings.slot_id`;

function publicBooking(booking, slotId) {
  return { id: booking.id, slot_id: slotId, name: booking.name, email: booking.email,
    status: booking.status, created_at: booking.created_at };
}

function failure(status, code, message, headers = {}) {
  return { status, body: errorBody(new AppError(status, code, message)), headers };
}

function createBookingService(pool, cursorSecret) {
  return {
    async create(body, idempotencyKey) {
      let booking;
      let validationError;
      let rateEmail;
      try { booking = bookingInput(body); }
      catch (error) {
        if (!(error instanceof AppError)) throw error;
        validationError = error;
      }
      if (typeof body?.email === 'string') {
        const normalized = body.email.trim().toLowerCase();
        if (normalized && normalized.length <= 254 && !normalized.includes('\u0000')) rateEmail = normalized;
      }
      if (validationError && !rateEmail && idempotencyKey === undefined) {
        return failure(validationError.status, validationError.code, validationError.message);
      }
      return inTransaction(pool, async client => {
        await lockBookingState(client);
        const replay = await reserveKey(client, idempotencyKey, body, booking);
        if (replay) return replay;
        const rate = rateEmail ? await recordBookingAttempt(client, rateEmail) : { allowed: true };
        let response;
        if (!rate.allowed) {
          response = failure(429, 'RATE_LIMIT_EXCEEDED', 'Maximum 5 booking attempts per email per minute.', {
            'Retry-After': String(rate.retryAfter)
          });
        } else if (validationError) {
          response = failure(validationError.status, validationError.code, validationError.message);
        } else {
          const { rows: [slot] } = await client.query(
            'SELECT id, starts_at > clock_timestamp() AS bookable FROM slots WHERE external_id = $1', [booking.slot_id]
          );
          if (!slot) {
            response = failure(404, 'SLOT_NOT_FOUND', 'Appointment slot not found.');
          } else if (!slot.bookable) {
            response = failure(400, 'SLOT_UNAVAILABLE', 'This appointment slot has already started.');
          } else {
            const { rows: [created] } = await client.query(`
              INSERT INTO bookings (slot_id, name, email) VALUES ($1, $2, $3)
              ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
              RETURNING *
            `, [slot.id, booking.name, booking.email]);
            response = created
              ? { status: 201, body: publicBooking(created, booking.slot_id), headers: { Location: `/bookings/${created.id}` } }
              : failure(409, 'SLOT_UNAVAILABLE', 'This appointment slot is no longer available.');
          }
        }
        // Business failures commit too, preserving attempts and replayable error responses.
        await storeResponse(client, idempotencyKey, response);
        return response;
      });
    },

    async get(id) {
      if (!UUID_PATTERN.test(id)) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
      const { rows: [booking] } = await pool.query(`${bookingSelect} WHERE bookings.id = $1`, [id]);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
      return booking;
    },

    async cancel(id) {
      if (!UUID_PATTERN.test(id)) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
      return inTransaction(pool, async client => {
        await lockBookingState(client);
        const changed = await client.query(`
          UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp()
          WHERE id = $1 AND status = 'confirmed' RETURNING id
        `, [id]);
        const { rows: [booking] } = await client.query(`${bookingSelect} WHERE bookings.id = $1`, [id]);
        if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
        if (!changed.rowCount) throw new AppError(409, 'ALREADY_CANCELLED', 'Booking is already cancelled.');
        return booking;
      });
    },

    async list({ email, limit, cursor }) {
      const parameters = [email];
      const clauses = ['bookings.email = $1'];
      if (cursor) {
        parameters.push(cursor.created_at, cursor.id);
        clauses.push(`(bookings.created_at, bookings.id) > ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
      }
      parameters.push(limit + 1);
      const { rows } = await pool.query(`
        ${bookingSelect} WHERE ${clauses.join(' AND ')}
        ORDER BY bookings.created_at ASC, bookings.id ASC LIMIT $${parameters.length}
      `, parameters);
      const bookings = rows.slice(0, limit);
      return {
        bookings,
        next_cursor: rows.length > limit ? encodeCursor(bookings.at(-1), email, cursorSecret) : null
      };
    }
  };
}

module.exports = { createBookingService };