const { providerInput, resetInput } = require('../utils/validation');
const { AppError } = require('../utils/errors');

function createSlotController(service) {
  return async (req, res) => res.json({ slots: await service.list(providerInput(req.query.provider)) });
}

function createResetController(service) {
  return async (req, res) => {
    if (!req.is('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    res.json(await service.reset(resetInput(req.body)));
  };
}

module.exports = { createSlotController, createResetController };