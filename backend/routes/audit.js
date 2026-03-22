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

function formatAuditDetails(action, before, after) {
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
      const time = data.time || '';
      const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
      const parts = [];
      if (name) parts.push(name);
      if (pc) parts.push('ПК ' + pc);
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
      const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
      const parts = [];
      if (name) parts.push(name);
      if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
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

router.get('/logs', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity, limit, offset } = req.query;

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

    const parsedLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const parsedOffset = Math.max(0, Number(offset) || 0);
    query += ' ORDER BY l.id DESC LIMIT ? OFFSET ?';
    params.push(parsedLimit, parsedOffset);

    const rows = await dbAll(db, query, params);
    const logs = rows.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      admin_login: row.admin_login,
      admin_name: row.admin_name || null,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      before: row.before_state ? JSON.parse(row.before_state) : null,
      after: row.after_state ? JSON.parse(row.after_state) : null,
      timestamp: row.timestamp,
      source: row.source,
      ip_address: row.ip_address
    }));

    return res.json({ count: logs.length, logs });
  } catch (error) {
    return next(error);
  }
});

router.post('/export', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity } = req.body || {};

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

    query += ' ORDER BY l.id DESC LIMIT 10000';

    const rows = await dbAll(db, query, params);

    // Create Excel workbook
    const data = [];

    // Add header row
    data.push(['Дата и время', 'Аккаунт', 'Действие', 'Подробности']);

    // Add data rows
    rows.forEach((row) => {
      const date = new Date(row.timestamp);
      const formattedDate = date.toLocaleString('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const before = parseJsonSafe(row.before_state);
      const after = parseJsonSafe(row.after_state);
      const actionLabel = ACTION_LABELS[row.action] || row.action;
      const details = formatAuditDetails(row.action, before, after);

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
    const { action, admin_id, from, to, entity } = req.body || {};

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

    query += ' ORDER BY l.id DESC LIMIT 10000';
    const rows = await dbAll(db, query, params);

    const logs = rows.map((row) => ({
      id: row.id,
      admin_id: row.admin_id,
      admin_login: row.admin_login,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      before: row.before_state ? JSON.parse(row.before_state) : null,
      after: row.after_state ? JSON.parse(row.after_state) : null,
      timestamp: row.timestamp,
      source: row.source,
      ip_address: row.ip_address
    }));

    return res.json({
      exported_at: new Date().toISOString(),
      filter: { action: action || null, admin_id: admin_id || null, from: from || null, to: to || null, entity: entity || null },
      total_records: logs.length,
      logs
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
