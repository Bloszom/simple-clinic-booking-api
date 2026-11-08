function createSlotService(pool) {
  return {
    async list() {
      const { rows } = await pool.query(`
        SELECT slots.id, slots.starts_at, slots.ends_at, slots.created_at,
          (slots.starts_at > clock_timestamp() AND NOT EXISTS (
            SELECT 1 FROM bookings WHERE bookings.slot_id = slots.id AND bookings.status = 'confirmed'
          )) AS available
        FROM slots ORDER BY starts_at, id
      `);
      return rows;
    }
  };
}

module.exports = { createSlotService };