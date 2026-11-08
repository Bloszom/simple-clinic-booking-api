const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { apiKeyAuth } = require('./middleware/auth');
const { requestContext } = require('./middleware/requestContext');
const { notFound, errorHandler, methodNotAllowed } = require('./middleware/errors');
const { AppError } = require('./utils/errors');
const { createBookingService } = require('./services/bookingService');
const { createSlotService } = require('./services/slotService');
const { bookingRoutes } = require('./routes/bookings');
const { slotRoutes } = require('./routes/slots');
const { createResetController } = require('./controllers/slotController');

function createApp({ pool, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');
  app.use(requestContext);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      callback(new AppError(403, 'CORS_FORBIDDEN', 'Origin is not allowed.'));
    },
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Idempotency-Key'],
    exposedHeaders: ['Location', 'Retry-After', 'X-Request-Id', 'Idempotency-Replayed'],
    maxAge: 600
  }));
  app.use(apiKeyAuth(config.apiKey));
  app.use(express.json({ limit: '16kb' }));
  app.route('/health').get(async (req, res) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is unavailable.');
    }
    res.json({ status: 'ok', database: 'connected' });
  }).all(methodNotAllowed(['GET', 'HEAD']));
  const slots = createSlotService(pool);
  app.route('/reset').post(createResetController(slots)).all(methodNotAllowed(['POST']));
  app.use('/slots', slotRoutes(slots));
  app.use('/bookings', bookingRoutes(createBookingService(pool, config.apiKey), config.apiKey));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };