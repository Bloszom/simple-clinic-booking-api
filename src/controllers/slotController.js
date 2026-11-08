function createSlotController(service) {
  return async (req, res) => res.json({ slots: await service.list() });
}

module.exports = { createSlotController };