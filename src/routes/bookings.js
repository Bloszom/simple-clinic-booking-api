const { Router } = require('express');
const { createBookingController } = require('../controllers/bookingController');
const { methodNotAllowed } = require('../middleware/errors');

function bookingRoutes(service, cursorSecret) {
  const router = Router();
  const controller = createBookingController(service, cursorSecret);
  router.route('/').get(controller.list).post(controller.create).all(methodNotAllowed(['GET', 'HEAD', 'POST']));
  router.route('/:id').get(controller.get).delete(controller.cancel).all(methodNotAllowed(['GET', 'HEAD', 'DELETE']));
  return router;
}

module.exports = { bookingRoutes };