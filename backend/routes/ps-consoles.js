import express from 'express';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';
import { nowIso } from '../utils/time.js';

const router = express.Router();
const WARNING_MINUTES = 5;

function minutesDiff(startIso, endIso = nowIso()) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / 60000);
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

async function getPsDevices(db, clubId) {
  return dbAll(
    db,
    `SELECT sort_order, device_code, display_name
     FROM club_devices
     WHERE club_id = ?
       AND device_type = 'PS'
       AND is_active = 1
       AND deleted_at IS NULL
     ORDER BY sort_order ASC`,
    [clubId]
  );
}

function mapSession(row) {
  return {
    id: row.id,
    ps_id: row.ps_id,
    booking_id: row.booking_id,
    start_time: row.start_time,
    prepaid_minutes: Number(row.prepaid_minutes || 0),
    total_paid: Number(row.total_paid || 0),
    added_time: Number(row.added_time || 0),
    selected_package: row.selected_package,
    client_name: row.client_name,
    client_phone: row.client_phone,
    is_free_time: Boolean(row.is_free_time),
    created_at: row.created_at,
    ended_at: row.ended_at
  };
}

router.use(requireAuth);
router.use(requireClubContext);

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const consoles = [];
    const psDevices = await getPsDevices(db, req.club.id);

    if (psDevices.length === 0) {
      return res.json([]);
    }

    const activeSessions = await dbAll(
      db,
      'SELECT * FROM ps_sessions WHERE club_id = ? AND ended_at IS NULL ORDER BY id DESC',
      [req.club.id]
    );

    const bookedRows = await dbAll(
      db,
      `SELECT * FROM bookings_ps
       WHERE club_id = ?
         AND deleted_at IS NULL
         AND status = 'booked'
       ORDER BY date_value ASC, time ASC, id ASC`,
      [req.club.id]
    );

    for (const device of psDevices) {
      const id = Number(device.sort_order);
      const active = activeSessions.find((item) => Number(item.ps_id) === id);
      const booking = bookedRows.find((item) => Number(item.ps_id) === id);

      if (active) {
        const session = mapSession(active);
        const elapsed = minutesDiff(session.start_time);
        let status = 'active';
        let remaining = null;

        if (session.is_free_time) {
          remaining = elapsed;
        } else {
          remaining = Math.max(0, session.prepaid_minutes - elapsed);
          if (remaining <= 0) status = 'expired';
          else if (remaining <= WARNING_MINUTES) status = 'warning';
        }

        consoles.push({
          id,
          code: device.device_code,
          display_name: device.display_name,
          status,
          remaining,
          warning_minutes: WARNING_MINUTES,
          session
        });
        continue;
      }

      if (booking) {
        consoles.push({ id, code: device.device_code, display_name: device.display_name, status: 'booked', remaining: null, booking });
        continue;
      }

      consoles.push({ id, code: device.device_code, display_name: device.display_name, status: 'idle', remaining: null });
    }

    return res.json(consoles);
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/session', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const psId = Number(req.params.id);
    const psDevices = await getPsDevices(db, req.club.id);
    const allowed = new Set(psDevices.map((item) => Number(item.sort_order)));
    if (!psId || !allowed.has(psId)) {
      return res.status(400).json({ error: 'Invalid PS id' });
    }

    const running = await dbGet(
      db,
      'SELECT * FROM ps_sessions WHERE club_id = ? AND ps_id = ? AND ended_at IS NULL LIMIT 1',
      [req.club.id, psId]
    );
    if (running) {
      return res.status(409).json({ error: 'Session already running on this console' });
    }

    const payload = req.body || {};
    const bookingId = payload.booking_id ? Number(payload.booking_id) : null;
    const prepaidMinutes = Number(payload.prepaid_minutes || 0);
    const totalPaid = Number(payload.total_paid || 0);
    const selectedPackage = payload.selected_package ? String(payload.selected_package) : null;
    const clientName = payload.client_name ? String(payload.client_name) : null;
    const clientPhone = payload.client_phone ? String(payload.client_phone) : null;
    const isFreeTime = payload.is_free_time === true ? 1 : 0;
    const createdAt = nowIso();

    if (!isFreeTime && prepaidMinutes <= 0) {
      return res.status(400).json({ error: 'prepaid_minutes must be > 0 for paid sessions' });
    }

    if (bookingId) {
      const booking = await dbGet(
        db,
        'SELECT id FROM bookings_ps WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
        [bookingId, req.club.id]
      );
      if (!booking) return res.status(404).json({ error: 'Linked booking not found' });

      await dbRun(
        db,
        'UPDATE bookings_ps SET status = ?, updated_at = ? WHERE id = ? AND club_id = ?',
        ['started', createdAt, bookingId, req.club.id]
      );
    }

    const inserted = await dbRun(
      db,
      `INSERT INTO ps_sessions (
        club_id, ps_id, booking_id, start_time, prepaid_minutes, total_paid, added_time,
        selected_package, client_name, client_phone, is_free_time, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        req.club.id,
        psId,
        bookingId,
        createdAt,
        prepaidMinutes,
        totalPaid,
        0,
        selectedPackage,
        clientName,
        clientPhone,
        isFreeTime,
        createdAt
      ]
    );

    const created = await dbGet(db, 'SELECT * FROM ps_sessions WHERE id = ?', [inserted.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'PS_SESSION_START',
      entity: 'ps_session',
      entityId: inserted.id,
      afterState: mapSession(created),
      ipAddress: req.ip
    });

    return res.status(201).json(mapSession(created));
  } catch (error) {
    return next(error);
  }
});

router.put('/:id/session', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const psId = Number(req.params.id);
    const running = await dbGet(
      db,
      'SELECT * FROM ps_sessions WHERE club_id = ? AND ps_id = ? AND ended_at IS NULL LIMIT 1',
      [req.club.id, psId]
    );
    if (!running) {
      return res.status(404).json({ error: 'No active session for this console' });
    }

    const payload = req.body || {};
    const addMinutes = Number(payload.minutes || 0);
    const addCost = Number(payload.cost || 0);
    if (addMinutes <= 0) {
      return res.status(400).json({ error: 'minutes must be > 0' });
    }

    const beforeState = mapSession(running);
    await dbRun(
      db,
      `UPDATE ps_sessions
       SET prepaid_minutes = ?, total_paid = ?, added_time = ?
       WHERE id = ?`,
      [
        Number(running.prepaid_minutes || 0) + addMinutes,
        Number(running.total_paid || 0) + addCost,
        Number(running.added_time || 0) + addMinutes,
        running.id
      ]
    );

    const updated = await dbGet(db, 'SELECT * FROM ps_sessions WHERE id = ?', [running.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'PS_ADD_TIME',
      entity: 'ps_session',
      entityId: running.id,
      beforeState,
      afterState: mapSession(updated),
      ipAddress: req.ip
    });

    return res.json(mapSession(updated));
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/session/end', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const psId = Number(req.params.id);
    const running = await dbGet(
      db,
      'SELECT * FROM ps_sessions WHERE club_id = ? AND ps_id = ? AND ended_at IS NULL LIMIT 1',
      [req.club.id, psId]
    );
    if (!running) {
      return res.status(404).json({ error: 'No active session for this console' });
    }

    const beforeState = mapSession(running);
    const endedAt = nowIso();

    let finalTotalPaid = Number(running.total_paid || 0);
    if (req.body && req.body.total_paid !== undefined) {
      finalTotalPaid = Number(req.body.total_paid || 0);
    }

    await dbRun(
      db,
      'UPDATE ps_sessions SET total_paid = ?, ended_at = ? WHERE id = ?',
      [finalTotalPaid, endedAt, running.id]
    );

    if (running.booking_id) {
      await dbRun(
        db,
        'UPDATE bookings_ps SET status = ?, updated_at = ? WHERE id = ? AND club_id = ?',
        ['completed', endedAt, running.booking_id, req.club.id]
      );
    }

    const ended = await dbGet(db, 'SELECT * FROM ps_sessions WHERE id = ?', [running.id]);

    await writeAudit(db, {
      clubId: req.club.id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'PS_SESSION_END',
      entity: 'ps_session',
      entityId: running.id,
      beforeState,
      afterState: mapSession(ended),
      ipAddress: req.ip
    });

    return res.json(mapSession(ended));
  } catch (error) {
    return next(error);
  }
});

export default router;
