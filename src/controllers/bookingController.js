const { bookingInput, idempotencyKey, pageInput, uuid } = require('../utils/validation');
const { decodeCursor } = require('../utils/cursor');
const { AppError } = require('../utils/errors');

function createBookingController(service, cursorSecret) {
  return {
    async create(req, res) {
      if (!req.is('application/json')) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
      }
      const response = await service.create(bookingInput(req.body), idempotencyKey(req.get('Idempotency-Key')));
      res.set(response.headers);
      res.set('Idempotency-Replayed', response.replayed ? 'true' : 'false');
      res.status(response.status).json(response.body);
    },
    async get(req, res) {
      res.json({ booking: await service.get(uuid(req.params.id)) });
    },
    async cancel(req, res) {
      res.json({ booking: await service.cancel(uuid(req.params.id)) });
    },
    async list(req, res) {
      const input = pageInput(req.query, (value, email) => decodeCursor(value, email, cursorSecret));
      res.json(await service.list(input));
    }
  };
}

module.exports = { createBookingController };