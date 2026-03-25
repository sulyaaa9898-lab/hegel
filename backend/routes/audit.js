import express from 'express';
import { dbAll } from '../db.js';
import { requireAuth, requireClubOwnerOrRoot } from '../middleware/auth.js';
import XLSX from 'xlsx';

const router = express.Router();
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

const ACTION_LABELS = {
  LOGIN: 'Вход в систему',
  LOGOUT: 'Выход',
  CREATE_BOOKING_PC: 'Создание брони ПК',
  UPDATE_BOOKING_PC: 'Изменение брони ПК',
  DELETE_BOOKING_PC: 'Удаление брони ПК',
  MARK_ARRIVED: 'Клиент пришёл',
  MARK_LATE: 'Клиент опаздывает',
  MARK_CANCELLED: 'Бронь отменена',
  MARK_NO_SHOW: 'Клиент не пришёл',
  CREATE_BOOKING_PS: 'Создание брони PS',
  UPDATE_BOOKING_PS: 'Изменение брони PS',
  DELETE_BOOKING_PS: 'Удаление брони PS',
  PS_SESSION_START: 'Старт PS-сессии',
  PS_SESSION_END: 'Завершение PS-сессии',
  PS_ADD_TIME: 'Добавление времени PS',
  CREATE_ADMIN: 'Добавление админа',
  DELETE_ADMIN: 'Удаление админа',
  PASSWORD_CHANGE: 'Смена пароля'
};

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatAuditDetails(action, before, after, forcedBookingUid) {
  const data = after || before;
  if (!data) return '—';
  const hasPrepay = (value) => {
    if (value === null || value === undefined) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== '' && normalized !== 'нет' && normalized !== '0' && normalized !== 'false';
  };
  switch (action) {
    case 'CREATE_BOOKING_PC':
    case 'UPDATE_BOOKING_PC':
    case 'DELETE_BOOKING_PC':
    case 'MARK_ARRIVED':
    case 'MARK_LATE':
    case 'MARK_CANCELLED':
    case 'MARK_NO_SHOW': {
      const name = data.name || data.guest_name || '';
      const pc = data.pc || '';
      const dateLabel = data.date_display || data.date_value || '';
      const time = data.time || '';
      const bookingUid = forcedBookingUid || data.booking_uid || '';
      const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
      const parts = [];
      if (bookingUid) parts.push('ID ' + bookingUid);
      if (name) parts.push(name);
      if (pc) parts.push('ПК ' + pc);
      if (dateLabel) parts.push(dateLabel);
      if (time) parts.push(time);
      if (hasPrepay(prepay)) parts.push('Предоплата: ' + prepay + ' ₸');
      if (action.startsWith('MARK_') && before && after && before.status && after.status) {
        parts.push(before.status + ' → ' + after.status);
      }
      return parts.join(' · ') || '—';
    }
    case 'CREATE_BOOKING_PS':
    case 'UPDATE_BOOKING_PS':
    case 'DELETE_BOOKING_PS': {
      const name = data.name || data.client_name || '';
      const ps = data.ps_id || data.console_id || '';
      const dateLabel = data.date_display || data.date_value || '';
      const time = data.time || '';
      const bookingUid = forcedBookingUid || data.booking_uid || '';
      const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
      const parts = [];
      if (bookingUid) parts.push('ID ' + bookingUid);
      if (name) parts.push(name);
      if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
      if (dateLabel) parts.push(dateLabel);
      if (time) parts.push(time);
      if (hasPrepay(prepay)) parts.push('Предоплата: ' + prepay + ' ₸');
      return parts.join(' · ') || '—';
    }
    case 'PS_SESSION_START': {
      const ps = data.ps_id || '';
      const pkg = data.selected_package || '';
      const parts = [];
      if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
      if (pkg) parts.push(pkg);
      return parts.join(' · ') || '—';
    }
    case 'PS_SESSION_END': {
      const ps = data.ps_id || '';
      const cost = data.total_paid;
      const parts = [];
      if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
      if (cost !== undefined && cost !== null) parts.push(cost + ' ₸');
      return parts.join(' · ') || '—';
    }
    case 'PS_ADD_TIME': {
      const ps = data.ps_id || '';
      const added = data.added_time || data.added_minutes || '';
      const parts = [];
      if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
      if (added) parts.push('+' + added + ' мин');
      return parts.join(' · ') || '—';
    }
    case 'CREATE_ADMIN':
    case 'DELETE_ADMIN': {
      const login = data.login || '';
      const name2 = data.name || '';
      return [name2, login ? '(' + login + ')' : ''].filter(Boolean).join(' ') || '—';
    }
    case 'PASSWORD_CHANGE':
      return data.login ? 'Логин: ' + data.login : '—';
    default:
      return '—';
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

router.use(requireAuth);
router.use(requireClubOwnerOrRoot);

function appendScope(query, params, req) {
  if (!req.auth.isRoot && (req.auth.role === CLUB_OWNER_ROLE || req.auth.isClubOwner)) {
    query += ' AND l.club_id = ?';
    params.push(Number(req.auth.clubId));
  }
  return query;
}

function normalizeBookingUid(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('8') && digits.length === 11) return `7${digits.slice(1)}`;
  return digits;
}

function appendBookingUidFilter(query, params, bookingUid) {
  const uid = normalizeBookingUid(bookingUid);
  if (!uid) return query;

  const likePattern = `\"booking_uid\":\"${uid}\"`;
  query += ` AND (
    l.before_state LIKE ?
    OR l.after_state LIKE ?
    OR (l.entity = 'booking_pc' AND l.entity_id IN (
      SELECT id FROM bookings_pc WHERE booking_uid = ?
    ))
    OR (l.entity = 'booking_ps' AND l.entity_id IN (
      SELECT id FROM bookings_ps WHERE booking_uid = ?
    ))
  )`;
  params.push(`%${likePattern}%`, `%${likePattern}%`, uid, uid);
  return query;
}

async function attachBookingUids(db, rows) {
  const result = rows.map((row) => {
    const before = parseJsonSafe(row.before_state);
    const after = parseJsonSafe(row.after_state);
    return {
      ...row,
      _beforeParsed: before,
      _afterParsed: after,
      _bookingUidParsed: (after && after.booking_uid) || (before && before.booking_uid) || ''
    };
  });

  const missingPcIds = [];
  const missingPsIds = [];
  result.forEach((row) => {
    if (row._bookingUidParsed) return;
    if (row.entity === 'booking_pc' && row.entity_id) missingPcIds.push(Number(row.entity_id));
    if (row.entity === 'booking_ps' && row.entity_id) missingPsIds.push(Number(row.entity_id));
  });

  const pcMap = new Map();
  const psMap = new Map();

  if (missingPcIds.length > 0) {
    const ids = Array.from(new Set(missingPcIds));
    const placeholders = ids.map(() => '?').join(',');
    const pcRows = await dbAll(db, `SELECT id, booking_uid FROM bookings_pc WHERE id IN (${placeholders})`, ids);
    pcRows.forEach((row) => pcMap.set(Number(row.id), row.booking_uid || ''));
  }

  if (missingPsIds.length > 0) {
    const ids = Array.from(new Set(missingPsIds));
    const placeholders = ids.map(() => '?').join(',');
    const psRows = await dbAll(db, `SELECT id, booking_uid FROM bookings_ps WHERE id IN (${placeholders})`, ids);
    psRows.forEach((row) => psMap.set(Number(row.id), row.booking_uid || ''));
  }

  return result.map((row) => ({
    ...row,
    booking_uid: row._bookingUidParsed
      || (row.entity === 'booking_pc' ? (pcMap.get(Number(row.entity_id)) || '') : '')
      || (row.entity === 'booking_ps' ? (psMap.get(Number(row.entity_id)) || '') : ''),
    before: row._beforeParsed,
    after: row._afterParsed
  }));
}

router.get('/logs', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity, booking_uid, limit, offset } = req.query;

    const params = [];
    let query = `SELECT l.*, a.name AS admin_name
           FROM audit_logs l
           LEFT JOIN admins a ON a.id = l.admin_id
           WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND l.action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND l.entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND l.admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND l.timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND l.timestamp <= ?';
      params.push(String(to));
    }
    query = appendBookingUidFilter(query, params, booking_uid);

    const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const parsedOffset = Math.max(0, Number(offset) || 0);
    query += ' ORDER BY l.id DESC LIMIT ? OFFSET ?';
    params.push(parsedLimit, parsedOffset);

    const rows = await dbAll(db, query, params);
    const withBookingUids = await attachBookingUids(db, rows);
    const logs = withBookingUids.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      admin_login: row.admin_login,
      admin_name: row.admin_name || null,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      booking_uid: row.booking_uid || null,
      before: row.before,
      after: row.after,
      timestamp: row.timestamp,
      source: row.source,
      ip_address: row.ip_address
    }));

    return res.json({ count: logs.length, logs });
  } catch (error) {
    return next(error);
  }
});

router.get('/booking-history/:bookingUid', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const bookingUid = normalizeBookingUid(req.params.bookingUid);
    if (!bookingUid) {
      return res.status(400).json({ error: 'bookingUid is required' });
    }

    const params = [];
    let query = `SELECT l.*, a.name AS admin_name
           FROM audit_logs l
           LEFT JOIN admins a ON a.id = l.admin_id
           WHERE 1=1`;
    query = appendScope(query, params, req);
    query = appendBookingUidFilter(query, params, bookingUid);
    query += ' ORDER BY l.timestamp ASC, l.id ASC LIMIT 2000';

    const rows = await dbAll(db, query, params);
    const withBookingUids = await attachBookingUids(db, rows);
    const logs = withBookingUids.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      admin_login: row.admin_login,
      admin_name: row.admin_name || null,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      booking_uid: row.booking_uid || bookingUid,
      before: row.before,
      after: row.after,
      details: formatAuditDetails(
        row.action,
        row.before,
        row.after,
        row.booking_uid || bookingUid
      ),
      action_label: ACTION_LABELS[row.action] || row.action,
      timestamp: row.timestamp
    }));

    return res.json({ booking_uid: bookingUid, count: logs.length, logs });
  } catch (error) {
    return next(error);
  }
});

router.get('/customer-history/:phone', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const requestedPhone = String(req.params.phone || '').trim();
    const normalizedPhone = normalizePhone(requestedPhone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const scopeParams = [];
    let pcQuery = `SELECT b.booking_uid, b.name, b.phone, b.date_value, b.time, b.status,
                          b.created_at, b.updated_at, b.deleted_at,
                          a.name AS admin_name, a.login AS admin_login
                   FROM bookings_pc b
                   LEFT JOIN admins a ON a.id = b.admin_id
                   WHERE 1=1`;
    let psQuery = `SELECT b.booking_uid, b.name, b.phone, b.date_value, b.time, b.status,
                          b.created_at, b.updated_at, b.deleted_at,
                          a.name AS admin_name, a.login AS admin_login
                   FROM bookings_ps b
                   LEFT JOIN admins a ON a.id = b.admin_id
                   WHERE 1=1`;

    if (!req.auth.isRoot && (req.auth.role === CLUB_OWNER_ROLE || req.auth.isClubOwner)) {
      pcQuery += ' AND b.club_id = ?';
      psQuery += ' AND b.club_id = ?';
      scopeParams.push(Number(req.auth.clubId));
    }

    pcQuery += ' ORDER BY COALESCE(b.updated_at, b.created_at) DESC, b.id DESC LIMIT 5000';
    psQuery += ' ORDER BY COALESCE(b.updated_at, b.created_at) DESC, b.id DESC LIMIT 5000';

    const [pcRows, psRows] = await Promise.all([
      dbAll(db, pcQuery, scopeParams),
      dbAll(db, psQuery, scopeParams)
    ]);

    const bookings = [];

    pcRows.forEach((row) => {
      if (normalizePhone(row.phone) !== normalizedPhone) return;
      bookings.push({
        booking_uid: row.booking_uid || null,
        platform: 'pc',
        platform_label: 'ПК',
        name: row.name || '',
        phone: row.phone || '',
        date_value: row.date_value || '',
        time: row.time || '',
        status: row.status || '',
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        deleted_at: row.deleted_at || null,
        admin_name: row.admin_name || null,
        admin_login: row.admin_login || null
      });
    });

    psRows.forEach((row) => {
      if (normalizePhone(row.phone) !== normalizedPhone) return;
      bookings.push({
        booking_uid: row.booking_uid || null,
        platform: 'ps',
        platform_label: 'PS',
        name: row.name || '',
        phone: row.phone || '',
        date_value: row.date_value || '',
        time: row.time || '',
        status: row.status || '',
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        deleted_at: row.deleted_at || null,
        admin_name: row.admin_name || null,
        admin_login: row.admin_login || null
      });
    });

    // Fallback for legacy rows without admin_id: derive account from audit trail by booking_uid.
    const missingUids = Array.from(new Set(bookings
      .filter((item) => !item.admin_name && !item.admin_login && item.booking_uid)
      .map((item) => normalizeBookingUid(item.booking_uid))
      .filter(Boolean)));

    if (missingUids.length > 0) {
      const placeholders = missingUids.map(() => '?').join(',');
      const auditParams = [...missingUids];
      let auditQuery = `SELECT l.booking_uid, l.action, l.admin_login, a.name AS admin_name, l.timestamp
                        FROM audit_logs l
                        LEFT JOIN admins a ON a.id = l.admin_id
                        WHERE l.booking_uid IN (${placeholders})`;

      if (!req.auth.isRoot && (req.auth.role === CLUB_OWNER_ROLE || req.auth.isClubOwner)) {
        auditQuery += ' AND l.club_id = ?';
        auditParams.push(Number(req.auth.clubId));
      }

      auditQuery += ' ORDER BY l.timestamp ASC';

      const auditRows = await dbAll(db, auditQuery, auditParams);
      const accountByUid = new Map();

      auditRows.forEach((row) => {
        const uid = normalizeBookingUid(row.booking_uid);
        if (!uid) return;
        const accountName = row.admin_name || row.admin_login || '';
        if (!accountName) return;

        const candidate = {
          admin_name: row.admin_name || null,
          admin_login: row.admin_login || null,
          priority: (row.action === 'CREATE_BOOKING_PC' || row.action === 'CREATE_BOOKING_PS') ? 0 : 1
        };

        const existing = accountByUid.get(uid);
        if (!existing || (existing.priority > candidate.priority)) {
          accountByUid.set(uid, candidate);
        }
      });

      bookings.forEach((item) => {
        if (item.admin_name || item.admin_login || !item.booking_uid) return;
        const account = accountByUid.get(normalizeBookingUid(item.booking_uid));
        if (!account) return;
        item.admin_name = account.admin_name || null;
        item.admin_login = account.admin_login || null;
      });
    }

    bookings.sort((a, b) => {
      const left = new Date(b.updated_at || b.created_at || 0).getTime();
      const right = new Date(a.updated_at || a.created_at || 0).getTime();
      return left - right;
    });

    const customerName = bookings.find((item) => item.name)?.name || '';
    const customerPhone = bookings.find((item) => item.phone)?.phone || requestedPhone;

    return res.json({
      phone: customerPhone,
      normalized_phone: normalizedPhone,
      customer_name: customerName,
      count: bookings.length,
      bookings
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/export', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity, booking_uid } = req.body || {};

    const params = [];
    let query = `SELECT l.*, a.name AS admin_name
           FROM audit_logs l
           LEFT JOIN admins a ON a.id = l.admin_id
           WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND l.action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND l.entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND l.admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND l.timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND l.timestamp <= ?';
      params.push(String(to));
    }
    query = appendBookingUidFilter(query, params, booking_uid);

    query += ' ORDER BY l.id DESC LIMIT 10000';

    const rows = await dbAll(db, query, params);
    const withBookingUids = await attachBookingUids(db, rows);

    // Create Excel workbook
    const data = [];

    // Add header row
    data.push(['Дата и время', 'Аккаунт', 'Действие', 'Подробности']);

    // Add data rows
    withBookingUids.forEach((row) => {
      const date = new Date(row.timestamp);
      const formattedDate = date.toLocaleString('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const before = row.before;
      const after = row.after;
      const actionLabel = ACTION_LABELS[row.action] || row.action;
      const details = formatAuditDetails(row.action, before, after, row.booking_uid);

      data.push([
        formattedDate,
        row.admin_name || row.admin_login || '—',
        actionLabel,
        details
      ]);
    });

    // Create worksheet
    const ws = XLSX.utils.aoa_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Дата и время
      { wch: 18 },  // Аккаунт
      { wch: 25 },  // Действие
      { wch: 45 }   // Подробности
    ];
    ws['!autofilter'] = { ref: `A1:D1` };

    // Create workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Logs');

    // Generate buffer
    const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    return res
      .status(200)
      .setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.xlsx"`)
      .send(excelBuffer);
  } catch (error) {
    return next(error);
  }
});

router.post('/export/json', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity, booking_uid } = req.body || {};

    const params = [];
    let query = `SELECT l.* FROM audit_logs l WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND l.action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND l.entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND l.admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND l.timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND l.timestamp <= ?';
      params.push(String(to));
    }
    query = appendBookingUidFilter(query, params, booking_uid);

    query += ' ORDER BY l.id DESC LIMIT 10000';
    const rows = await dbAll(db, query, params);
    const withBookingUids = await attachBookingUids(db, rows);

    const logs = withBookingUids.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      admin_login: row.admin_login,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      booking_uid: row.booking_uid || null,
      before: row.before,
      after: row.after,
      timestamp: row.timestamp,
      source: row.source,
      ip_address: row.ip_address
    }));

    return res.json({
      exported_at: new Date().toISOString(),
      filter: {
        action: action || null,
        admin_id: admin_id || null,
        from: from || null,
        to: to || null,
        entity: entity || null,
        booking_uid: booking_uid || null
      },
      total_records: logs.length,
      logs
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
