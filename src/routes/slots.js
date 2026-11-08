const { Router } = require('express');
const { createSlotController } = require('../controllers/slotController');
const { methodNotAllowed } = require('../middleware/errors');

function slotRoutes(service) {
  const router = Router();
  router.route('/').get(createSlotController(service)).all(methodNotAllowed(['GET', 'HEAD']));
  return router;
}

module.exports = { slotRoutes };