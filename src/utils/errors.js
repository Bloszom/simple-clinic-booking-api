class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorBody(error, requestId) {
  const body = { error: { code: error.code, message: error.message } };
  if (error.details) body.error.details = error.details;
  if (requestId) body.error.request_id = requestId;
  return body;
}

module.exports = { AppError, errorBody };