const { createHash, timingSafeEqual } = require('node:crypto');
const { AppError } = require('../utils/errors');

function apiKeyAuth(apiKey) {
  const expected = createHash('sha256').update(apiKey).digest();
  return (req, res, next) => {
    const supplied = req.get('X-API-Key');
    if (!supplied || !timingSafeEqual(expected, createHash('sha256').update(supplied).digest())) {
      return next(new AppError(401, 'UNAUTHORIZED', 'A valid X-API-Key header is required.'));
    }
    next();
  };
}

module.exports = { apiKeyAuth };