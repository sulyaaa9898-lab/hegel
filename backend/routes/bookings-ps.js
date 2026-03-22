import express from 'express';
import { randomBytes } from 'crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';
import { nowIso } from '../utils/time.js';

const router = express.Router();
const VALID_STATUS = new Set(['booked', 'started', 'completed']);

function mapBooking(row) {
  const bookingUid = row.booking_uid && String(row.booking_uid).trim()
    ? String(row.booking_uid).trim()
    : null;
  return {
    id: row.id,
    booking_uid: bookingUid,
    admin_id: row.admin_id,
    ps_id: row.ps_id,
    name: row.name,
    phone: row.phone,
    time: row.time,
    date_value: row.date_value,
    date_display: row.date_display,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at
  };
}

function createBookingUid(prefix) {
  return `${prefix}-${randomBytes(2).toString('hex')}@${randomBytes(2).toString('hex')}`.toUpperCase();
}

async function generateUniqueBookingUid(db, clubId) {
  for (let i = 0; i < 10; i += 1) {
    const uid = createBookingUid('PS');
    const found = await dbGet(
      db,
      'SELECT id FROM bookings_ps WHERE club_id = ? AND booking_uid = ? LIMIT 1',
      [clubId, uid]
    );
    if (!found) return uid;
  }
  return `PS-${Date.now().toString(36)}@${randomBytes(2).toString('hex')}`.toUpperCase();
}

async function writeAudit(db, payload) {
  await dbRun(
    db,
    `INSERT INTO audit_logs (
      club_id, admin_id, admin_login, action, entity, entity_id,
      before_state, after_state, timestamp, source, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      payload.clubId,
      payload.adminId,
      payload.adminLogin,
      payload.action,
      payload.entity,
      payload.entityId,
      payload.beforeState ? JSON.stringify(payload.beforeState) : null,
      payload.afterState ? JSON.stringify(payload.afterState) : null,
      nowIso(),
      'web',
      payload.ipAddress || null
    ]
  );
}

async function getAllowedPsSlots(db, clubId) {
  const rows = await dbAll(
    db,
    `SELECT sort_order
     FROM club_devices
     WHERE club_id = ?
       AND device_type = 'PS'
       AND is_active = 1
       AND deleted_at IS NULL
     ORDER BY sort_order ASC`,
    [clubId]
  );

  return rows.map((row) => Number(row.sort_order)).filter((n) => Number.isInteger(n) && n > 0);
}

router.use(requireAuth);
router.use(requireClubContext);

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const includeDeleted = req.query.include_deleted === '1';
    const psId = req.query.ps_id ? Number(req.query.ps_id) : null;
    const clubId = req.club.id;

    const params = [];
    let query = 'SELECT * FROM bookings_ps WHERE club_id = ?';
    params.push(clubId);

    if (!includeDeleted) {
      query += ' AND deleted_at IS NULL';
    }

    if (psId) {
      query += ' AND ps_id = ?';
      params.push(psId);
    }

    query += ' ORDER BY date_value ASC, time ASC, id ASC';
    const rows = await dbAll(db, query, params);
    return res.json(rows.map(mapBooking));
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const row = await dbGet(
      db,
      'SELECT * FROM bookings_ps WHERE id = ? AND club_id = ? LIMIT 1',
      [Number(req.params.id), req.club.id]
    );
    if (!row) return res.status(404).json({ error: 'PS booking not found' });
    return res.json(mapBooking(row));
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const payload = req.body || {};

    const psId = Number(payload.ps_id);
    const name = String(payload.name || '').trim();
    const phone = payload.phone ? String(payload.phone).trim() : null;
    const time = String(payload.time || '').trim();
    const dateValue = String(payload.date_value || '').trim();
    const dateDisplay = payload.date_display ? String(payload.date_display).trim() : null;

    const allowedSlots = await getAllowedPsSlots(db, req.club.id);
    if (!allowedSlots.includes(psId) || !name || !time || !dateValue) {
      return res.status(400).json({ error: 'ps_id must exist in club configuration; name, time and date_value are required' });
    }

    const conflict = await dbGet(
      db,
      `SELECT id FROM bookings_ps
       WHERE club_id = ? AND ps_id = ? AND date_value = ? AND time = ? AND deleted_at IS NULL
       LIMIT 1`,
      [req.club.id, psId, dateValue, time]
    );

    if (conflict && payload.force !== true) {
      return res.status(409).json({ error: 'PS booking conflict', code: 'PS_CONFLICT' });
    }

    const createdAt = nowIso();
    const inserted = await dbRun(
      db,
      `INSERT INTO bookings_ps (
        club_id, admin_id, ps_id, name, phone, time, date_value, date_display,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)` ,
      [req.club.id, req.auth.adminId, psId, name, phone, time, dateValue, dateDisplay, createdAt, createdAt]
    );

    const bookingUid = await generateUniqueBookingUid(db, req.club.id);
    await dbRun(
      db,
      `UPDATE bookings_ps
       SET booking_uid = COALESCE(NULLIF(booking_uid, ''), ?)
       WHERE id = ? AND club_id = ?`,
      [bookingUid, inserted.id, req.club.id]
    );

    const created = await dbGet(db, 'SELECT * FROM bookings_ps WHERE id = ? AND club_id = ?', [inserted.id, req.club.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'CREATE_BOOKING_PS',
      entity: 'booking_ps',
      entityId: inserted.id,
      afterState: mapBooking(created),
      ipAddress: req.ip
    });

    return res.status(201).json(mapBooking(created));
  } catch (error) {
    return next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const existing = await dbGet(
      db,
      'SELECT * FROM bookings_ps WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, req.club.id]
    );
    if (!existing) return res.status(404).json({ error: 'PS booking not found' });

    const payload = req.body || {};
    const nextPsId = payload.ps_id !== undefined ? Number(payload.ps_id) : existing.ps_id;
    const nextName = payload.name !== undefined ? String(payload.name).trim() : existing.name;
    const nextPhone = payload.phone !== undefined ? String(payload.phone).trim() : existing.phone;
    const nextTime = payload.time !== undefined ? String(payload.time).trim() : existing.time;
    const nextDateValue = payload.date_value !== undefined ? String(payload.date_value).trim() : existing.date_value;
    const nextDateDisplay = payload.date_display !== undefined ? String(payload.date_display).trim() : existing.date_display;
    const nextStatus = payload.status !== undefined ? String(payload.status).trim() : existing.status;

    const allowedSlots = await getAllowedPsSlots(db, req.club.id);
    if (!allowedSlots.includes(nextPsId) || !nextName || !nextTime || !nextDateValue) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    if (!VALID_STATUS.has(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const beforeState = mapBooking(existing);

    await dbRun(
      db,
      `UPDATE bookings_ps
       SET ps_id = ?, name = ?, phone = ?, time = ?, date_value = ?, date_display = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [nextPsId, nextName, nextPhone || null, nextTime, nextDateValue, nextDateDisplay || null, nextStatus, nowIso(), id]
    );

    const updated = await dbGet(db, 'SELECT * FROM bookings_ps WHERE id = ?', [id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'UPDATE_BOOKING_PS',
      entity: 'booking_ps',
      entityId: id,
      beforeState,
      afterState: mapBooking(updated),
      ipAddress: req.ip
    });

    return res.json(mapBooking(updated));
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const existing = await dbGet(
      db,
      'SELECT * FROM bookings_ps WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, req.club.id]
    );
    if (!existing) return res.status(404).json({ error: 'PS booking not found' });

    const deletedAt = nowIso();
    const beforeState = mapBooking(existing);

    await dbRun(db, 'UPDATE bookings_ps SET deleted_at = ?, updated_at = ? WHERE id = ?', [deletedAt, deletedAt, id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'DELETE_BOOKING_PS',
      entity: 'booking_ps',
      entityId: id,
      beforeState,
      afterState: null,
      ipAddress: req.ip
    });

    return res.json({ success: true, deleted_at: deletedAt });
  } catch (error) {
    return next(error);
  }
});

export default router;
