const { AppError, errorBody } = require('../utils/errors');

function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.'));
}

function methodNotAllowed(methods) {
  return (req, res, next) => {
    res.set('Allow', methods.join(', '));
    next(new AppError(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this endpoint.'));
  };
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let publicError = error;
  if (error.type === 'entity.parse.failed') {
    publicError = new AppError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  } else if (error.type === 'entity.too.large') {
    publicError = new AppError(413, 'PAYLOAD_TOO_LARGE', 'JSON body must not exceed 16 KB.');
  } else if (['encoding.unsupported', 'charset.unsupported'].includes(error.type)) {
    publicError = new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported JSON encoding.');
  } else if (!(error instanceof AppError)) {
    const unavailable = ['53300', '53400', '55P03', '57014', '57P01', '57P02', '57P03',
      'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(error.code) ||
      (typeof error.code === 'string' && error.code.startsWith('08'));
    publicError = unavailable
      ? new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable. Please retry.')
      : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
    console.error(JSON.stringify({ event: 'request_error', request_id: req.requestId, code: error.code || 'UNKNOWN' }));
  }
  if (publicError.status === 503) res.set('Retry-After', '1');
  res.status(publicError.status).json(errorBody(publicError, req.requestId));
}

module.exports = { notFound, methodNotAllowed, errorHandler };