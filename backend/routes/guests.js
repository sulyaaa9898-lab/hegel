import express from 'express';
import { dbAll, dbGet } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';

const router = express.Router();

function mapGuest(row) {
  return {
    id: row.id,
    phone: row.phone,
    rating: Number(row.rating || 0),
    total_bookings: Number(row.total_bookings || 0),
    arrived: Number(row.arrived || 0),
    late: Number(row.late || 0),
    cancelled: Number(row.cancelled || 0),
    no_show: Number(row.no_show || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

router.use(requireAuth);
router.use(requireClubContext);

router.get('/ratings', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const rows = await dbAll(
      db,
      `SELECT * FROM guest_ratings
       WHERE club_id = ?
       ORDER BY rating DESC, total_bookings DESC, id ASC`,
      [req.club.id]
    );
    return res.json(rows.map(mapGuest));
  } catch (error) {
    return next(error);
  }
});

router.get('/:phone/rating', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const row = await dbGet(
      db,
      'SELECT * FROM guest_ratings WHERE club_id = ? AND phone = ? LIMIT 1',
      [req.club.id, phone]
    );
    if (!row) return res.status(404).json({ error: 'Guest rating not found' });
    return res.json(mapGuest(row));
  } catch (error) {
    return next(error);
  }
});

export default router;
