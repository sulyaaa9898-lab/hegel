import express from 'express';
import { randomBytes } from 'crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth, requireRoot } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';
import { nowIso } from '../utils/time.js';

const router = express.Router();

const STATUS_PENDING = 'pending';
const VALID_STATUS = new Set(['pending', 'arrived', 'late', 'cancelled', 'no-show']);
const RATING_PENALTY = {
  late: 5,
  cancelled: 10,
  'no-show': 15,
  arrived: 0
};

function parsePcString(pc) {
  return String(pc || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('8') && digits.length === 11) return `7${digits.slice(1)}`;
  return digits;
}

function safeParseObject(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function mapBooking(row) {
  const bookingUid = row.booking_uid && String(row.booking_uid).trim()
    ? String(row.booking_uid).trim()
    : null;
  return {
    id: row.id,
    booking_uid: bookingUid,
    admin_id: row.admin_id,
    admin_login: row.admin_login || null,
    admin_name: row.admin_name || null,
    name: row.name,
    pc: row.pc,
    time: row.time,
    date_value: row.date_value,
    date_display: row.date_display,
    phone: row.phone,
    prepay: row.prepay,
    status: row.status,
    pc_statuses: safeParseObject(row.pc_statuses) || {},
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
    const uid = createBookingUid('PC');
    const found = await dbGet(
      db,
      'SELECT id FROM bookings_pc WHERE club_id = ? AND booking_uid = ? LIMIT 1',
      [clubId, uid]
    );
    if (!found) return uid;
  }
  return `PC-${Date.now().toString(36)}@${randomBytes(2).toString('hex')}`.toUpperCase();
}

async function writeAudit(db, payload) {
  await dbRun(
    db,
    `INSERT INTO audit_logs (
      club_id, admin_id, admin_login, action, entity, entity_id,
      before_state, after_state, timestamp, source, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      payload.clubId || null,
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

async function ensureNoPcConflict(db, clubId, dateValue, pcString, excludeId = null) {
  const pcs = parsePcString(pcString);
  if (pcs.length === 0) return false;

  const params = [clubId, dateValue, STATUS_PENDING];
  let query = `
    SELECT id, pc
    FROM bookings_pc
    WHERE club_id = ?
      AND date_value = ?
      AND status = ?
      AND deleted_at IS NULL
  `;

  if (excludeId !== null) {
    query += ' AND id <> ?';
    params.push(excludeId);
  }

  const rows = await dbAll(db, query, params);
  const occupied = new Set();
  rows.forEach((row) => {
    parsePcString(row.pc).forEach((pc) => occupied.add(pc));
  });

  return pcs.some((pc) => occupied.has(pc));
}

async function getAllowedPcIdentifiers(db, clubId) {
  const rows = await dbAll(
    db,
    `SELECT sort_order, device_code, display_name
     FROM club_devices
     WHERE club_id = ?
       AND device_type = 'PC'
       AND is_active = 1
       AND deleted_at IS NULL`,
    [clubId]
  );

  const allowed = new Set();
  rows.forEach((row) => {
    const order = Number(row.sort_order);
    if (Number.isInteger(order) && order > 0) {
      allowed.add(String(order));
    }
    if (row.device_code) allowed.add(String(row.device_code).trim());
    if (row.display_name) allowed.add(String(row.display_name).trim());
  });

  return allowed;
}

async function applyGuestRatingOnStatus(db, clubId, booking, nextStatus) {
  if (!booking || !booking.phone) return;

  const phone = normalizePhone(booking.phone);
  if (!phone) return;

  const current = await dbGet(
    db,
    `SELECT id, phone, rating, total_bookings, arrived, late, cancelled, no_show
     FROM guest_ratings
     WHERE club_id = ? AND phone = ?
     LIMIT 1`,
    [clubId, phone]
  );

  const createdAt = nowIso();
  if (!current) {
    await dbRun(
      db,
      `INSERT INTO guest_ratings (
        club_id, phone, rating, total_bookings, arrived, late, cancelled, no_show, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)` ,
      [clubId, phone, 100, createdAt, createdAt]
    );
  }

  const fresh = await dbGet(
    db,
    `SELECT id, rating, total_bookings, arrived, late, cancelled, no_show
     FROM guest_ratings
     WHERE club_id = ? AND phone = ?
     LIMIT 1`,
    [clubId, phone]
  );

  let total = fresh.total_bookings + 1;
  let arrived = fresh.arrived;
  let late = fresh.late;
  let cancelled = fresh.cancelled;
  let noShow = fresh.no_show;
  let rating = Number(fresh.rating);

  if (nextStatus === 'arrived') arrived += 1;
  if (nextStatus === 'late') late += 1;
  if (nextStatus === 'cancelled') cancelled += 1;
  if (nextStatus === 'no-show') noShow += 1;

  const penalty = RATING_PENALTY[nextStatus] || 0;
  if (penalty > 0) rating = Math.max(0, rating - penalty);

  await dbRun(
    db,
    `UPDATE guest_ratings
     SET rating = ?, total_bookings = ?, arrived = ?, late = ?, cancelled = ?, no_show = ?, updated_at = ?
     WHERE id = ?`,
    [rating, total, arrived, late, cancelled, noShow, nowIso(), fresh.id]
  );
}

router.use(requireAuth);
router.use(requireClubContext);

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const includeDeleted = req.query.include_deleted === '1';
    const status = req.query.status;
    const dateValue = req.query.date_value;
    const clubId = req.club.id;

    const params = [clubId];
    let query = `
      SELECT b.*, a.login AS admin_login, a.name AS admin_name
      FROM bookings_pc b
      LEFT JOIN admins a ON a.id = b.admin_id
      WHERE b.club_id = ?
    `;

    if (!includeDeleted) {
      query += ' AND b.deleted_at IS NULL';
    }

    if (status) {
      query += ' AND b.status = ?';
      params.push(status);
    }

    if (dateValue) {
      query += ' AND b.date_value = ?';
      params.push(dateValue);
    }

    query += ' ORDER BY b.date_value ASC, b.time ASC, b.id ASC';

    const rows = await dbAll(db, query, params);
    return res.json(rows.map(mapBooking));
  } catch (error) {
    return next(error);
  }
});

router.get('/done', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const rows = await dbAll(
      db,
      `SELECT b.*, a.login AS admin_login, a.name AS admin_name
       FROM bookings_pc b
       LEFT JOIN admins a ON a.id = b.admin_id
       WHERE b.club_id = ?
         AND b.deleted_at IS NULL
         AND b.status <> ?
       ORDER BY b.updated_at DESC, b.id DESC`,
      [req.club.id, STATUS_PENDING]
    );

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
      'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ? LIMIT 1',
      [Number(req.params.id), req.club.id]
    );

    if (!row) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json(mapBooking(row));
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const payload = req.body || {};

    const name = String(payload.name || '').trim();
    const pc = String(payload.pc || '').trim();
    const time = String(payload.time || '').trim();
    const dateValue = String(payload.date_value || '').trim();
    const dateDisplay = String(payload.date_display || '').trim() || null;
    const phone = String(payload.phone || '').trim() || null;
    const prepay = payload.prepay === undefined || payload.prepay === null ? 'Нет' : String(payload.prepay);
    const pcStatuses = payload.pc_statuses && typeof payload.pc_statuses === 'object' ? payload.pc_statuses : {};

    if (!name || !pc || !time || !dateValue) {
      return res.status(400).json({ error: 'name, pc, time and date_value are required' });
    }

    const allowedPc = await getAllowedPcIdentifiers(db, req.club.id);
    const requestedPc = parsePcString(pc);
    if (allowedPc.size > 0 && requestedPc.some((item) => !allowedPc.has(String(item)))) {
      return res.status(400).json({ error: 'Requested PC is not available in club configuration' });
    }

    const hasConflict = await ensureNoPcConflict(db, req.club.id, dateValue, pc);
    if (hasConflict && payload.force !== true) {
      return res.status(409).json({ error: 'PC conflict detected', code: 'PC_CONFLICT' });
    }

    const createdAt = nowIso();
    const insert = await dbRun(
      db,
      `INSERT INTO bookings_pc (
        club_id, admin_id, name, pc, time, date_value, date_display,
        phone, prepay, status, pc_statuses, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.club.id,
        req.auth.adminId,
        name,
        pc,
        time,
        dateValue,
        dateDisplay,
        phone,
        prepay,
        STATUS_PENDING,
        JSON.stringify(pcStatuses),
        createdAt,
        createdAt
      ]
    );

    const bookingUid = await generateUniqueBookingUid(db, req.club.id);
    await dbRun(
      db,
      `UPDATE bookings_pc
       SET booking_uid = COALESCE(NULLIF(booking_uid, ''), ?)
       WHERE id = ? AND club_id = ?`,
      [bookingUid, insert.id, req.club.id]
    );

    const created = await dbGet(db, 'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ?', [insert.id, req.club.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'CREATE_BOOKING_PC',
      entity: 'booking_pc',
      entityId: insert.id,
      beforeState: null,
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
      'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, req.club.id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const payload = req.body || {};
    const nextName = payload.name !== undefined ? String(payload.name).trim() : existing.name;
    const nextPc = payload.pc !== undefined ? String(payload.pc).trim() : existing.pc;
    const nextTime = payload.time !== undefined ? String(payload.time).trim() : existing.time;
    const nextDateValue = payload.date_value !== undefined ? String(payload.date_value).trim() : existing.date_value;
    const nextDateDisplay = payload.date_display !== undefined ? String(payload.date_display).trim() : existing.date_display;
    const nextPhone = payload.phone !== undefined ? String(payload.phone).trim() : existing.phone;
    const nextPrepay = payload.prepay !== undefined ? String(payload.prepay) : existing.prepay;
    const nextPcStatuses = payload.pc_statuses && typeof payload.pc_statuses === 'object'
      ? payload.pc_statuses
      : safeParseObject(existing.pc_statuses) || {};

    if (!nextName || !nextPc || !nextTime || !nextDateValue) {
      return res.status(400).json({ error: 'name, pc, time and date_value cannot be empty' });
    }

    const allowedPc = await getAllowedPcIdentifiers(db, req.club.id);
    const requestedPc = parsePcString(nextPc);
    if (allowedPc.size > 0 && requestedPc.some((item) => !allowedPc.has(String(item)))) {
      return res.status(400).json({ error: 'Requested PC is not available in club configuration' });
    }

    const hasConflict = await ensureNoPcConflict(db, req.club.id, nextDateValue, nextPc, id);
    if (hasConflict && payload.force !== true) {
      return res.status(409).json({ error: 'PC conflict detected', code: 'PC_CONFLICT' });
    }

    const beforeState = mapBooking(existing);

    await dbRun(
      db,
      `UPDATE bookings_pc
       SET name = ?, pc = ?, time = ?, date_value = ?, date_display = ?, phone = ?, prepay = ?, pc_statuses = ?, updated_at = ?
       WHERE id = ? AND club_id = ?`,
      [
        nextName,
        nextPc,
        nextTime,
        nextDateValue,
        nextDateDisplay || null,
        nextPhone || null,
        nextPrepay,
        JSON.stringify(nextPcStatuses),
        nowIso(),
        id,
        req.club.id
      ]
    );

    const updated = await dbGet(db, 'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ?', [id, req.club.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'UPDATE_BOOKING_PC',
      entity: 'booking_pc',
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
      'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, req.club.id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const beforeState = mapBooking(existing);
    const deletedAt = nowIso();

    await dbRun(
      db,
      'UPDATE bookings_pc SET deleted_at = ?, updated_at = ? WHERE id = ? AND club_id = ?',
      [deletedAt, deletedAt, id, req.club.id]
    );

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'DELETE_BOOKING_PC',
      entity: 'booking_pc',
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

router.post('/:id/status', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').trim();

    if (!VALID_STATUS.has(status) || status === STATUS_PENDING) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const existing = await dbGet(
      db,
      'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, req.club.id]
    );
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const beforeState = mapBooking(existing);

    await dbRun(
      db,
      'UPDATE bookings_pc SET status = ?, updated_at = ? WHERE id = ? AND club_id = ?',
      [status, nowIso(), id, req.club.id]
    );

    const updated = await dbGet(db, 'SELECT * FROM bookings_pc WHERE id = ? AND club_id = ?', [id, req.club.id]);
    await applyGuestRatingOnStatus(db, req.club.id, mapBooking(updated), status);

    const actionMap = {
      arrived: 'MARK_ARRIVED',
      late: 'MARK_LATE',
      cancelled: 'MARK_CANCELLED',
      'no-show': 'MARK_NO_SHOW'
    };

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: actionMap[status],
      entity: 'booking_pc',
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

router.post('/migrate/import-localstorage', requireRoot, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const bookings = Array.isArray(req.body?.bookings) ? req.body.bookings : [];
    const done = Array.isArray(req.body?.done) ? req.body.done : [];
    const guestRatings = req.body?.guestRatings && typeof req.body.guestRatings === 'object'
      ? req.body.guestRatings
      : {};

    let createdCount = 0;
    for (const item of [...bookings, ...done]) {
      const name = String(item.name || '').trim();
      const pc = String(item.pc || '').trim();
      const time = String(item.time || '').trim();
      const dateValue = String(item.dateValue || item.date_value || '').trim();
      if (!name || !pc || !time || !dateValue) continue;

      const status = VALID_STATUS.has(item.status) ? item.status : STATUS_PENDING;
      const createdAt = String(item.addedAt || item.created_at || nowIso());
      const updatedAt = nowIso();

      await dbRun(
        db,
        `INSERT INTO bookings_pc (
          club_id, admin_id, name, pc, time, date_value, date_display, phone, prepay,
          status, pc_statuses, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          req.club.id,
          req.auth.adminId,
          name,
          pc,
          time,
          dateValue,
          item.dateDisplay || item.date_display || null,
          item.phone || null,
          item.prepay || 'Нет',
          status,
          JSON.stringify(item.pcStatuses || item.pc_statuses || {}),
          createdAt,
          updatedAt
        ]
      );

      createdCount += 1;
    }

    let ratingCount = 0;
    for (const key of Object.keys(guestRatings)) {
      const row = guestRatings[key];
      const phone = normalizePhone(row?.phone || key);
      if (!phone) continue;

      const existing = await dbGet(
        db,
        'SELECT id FROM guest_ratings WHERE club_id = ? AND phone = ? LIMIT 1',
        [req.club.id, phone]
      );
      if (existing) continue;

      await dbRun(
        db,
        `INSERT INTO guest_ratings (
          club_id, phone, rating, total_bookings, arrived, late, cancelled, no_show, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          req.club.id,
          phone,
          Number(row.rating ?? 100),
          Number(row.total ?? row.total_bookings ?? 0),
          Number(row.arrived ?? 0),
          Number(row.late ?? 0),
          Number(row.cancelled ?? 0),
          Number(row.noShow ?? row.no_show ?? 0),
          nowIso(),
          nowIso()
        ]
      );

      ratingCount += 1;
    }

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'UPDATE_BOOKING_PC',
      entity: 'booking_pc',
      entityId: null,
      beforeState: null,
      afterState: {
        imported_bookings: createdCount,
        imported_guest_ratings: ratingCount
      },
      ipAddress: req.ip
    });

    return res.json({
      success: true,
      imported_bookings: createdCount,
      imported_guest_ratings: ratingCount
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
