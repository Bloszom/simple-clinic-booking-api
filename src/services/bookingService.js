const { inTransaction } = require('../database/pool');
const { AppError, errorBody } = require('../utils/errors');
const { recordBookingAttempt } = require('./rateLimitService');
const { requestHash, reserveKey, storeResponse } = require('./idempotencyService');
const { encodeCursor } = require('../utils/cursor');

function failure(status, code, message, headers = {}) {
  return { status, body: errorBody(new AppError(status, code, message)), headers };
}

function createBookingService(pool, cursorSecret) {
  return {
    async create(booking, idempotencyKey) {
      return inTransaction(pool, async client => {
        const replay = await reserveKey(client, idempotencyKey, requestHash(booking));
        if (replay) return replay;
        const rate = await recordBookingAttempt(client, booking.email);
        let response;
        if (!rate.allowed) {
          response = failure(429, 'RATE_LIMIT_EXCEEDED', 'Maximum 5 booking attempts per email per minute.', {
            'Retry-After': String(rate.retryAfter)
          });
        } else {
          const { rows: [slot] } = await client.query(
            'SELECT id, starts_at > clock_timestamp() AS bookable FROM slots WHERE id = $1', [booking.slot_id]
          );
          if (!slot) {
            response = failure(404, 'SLOT_NOT_FOUND', 'Appointment slot not found.');
          } else if (!slot.bookable) {
            response = failure(409, 'SLOT_UNAVAILABLE', 'This appointment slot has already started.');
          } else {
            const { rows: [created] } = await client.query(`
              INSERT INTO bookings (slot_id, name, email)
              SELECT id, $2, $3 FROM slots WHERE id = $1 AND starts_at > clock_timestamp()
              ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
              RETURNING *
            `, [booking.slot_id, booking.name, booking.email]);
            response = created
              ? { status: 201, body: { booking: created }, headers: { Location: `/bookings/${created.id}` } }
              : failure(409, 'SLOT_UNAVAILABLE', 'This appointment slot is no longer available.');
          }
        }
        // Business failures commit too, preserving attempts and replayable error responses.
        await storeResponse(client, idempotencyKey, response);
        return response;
      });
    },

    async get(id) {
      const { rows: [booking] } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
      return booking;
    },

    async cancel(id) {
      const { rows: [booking] } = await pool.query(`
        UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp()
        WHERE id = $1 AND status = 'confirmed' RETURNING *
      `, [id]);
      return booking || this.get(id);
    },

    async list({ email, limit, cursor }) {
      const parameters = [];
      const clauses = [];
      if (email) {
        parameters.push(email);
        clauses.push(`email = $${parameters.length}`);
      }
      if (cursor) {
        parameters.push(cursor.created_at, cursor.id);
        clauses.push(`(created_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
      }
      parameters.push(limit + 1);
      const { rows } = await pool.query(`
        SELECT * FROM bookings ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT $${parameters.length}
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