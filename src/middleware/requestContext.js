const { randomUUID } = require('node:crypto');

function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  res.set('Cache-Control', 'no-store');
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    // Never log patient names, emails, credentials, bodies or query strings.
    console.log(JSON.stringify({
      event: 'request', request_id: req.requestId, method: req.method,
      route: req.route?.path || 'unmatched', status: res.statusCode,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6
    }));
  });
  next();
}

module.exports = { requestContext };