class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorBody(error) {
  return { error: error.message };
}

module.exports = { AppError, errorBody };