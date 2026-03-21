import express from 'express';
import { dbAll } from '../db.js';
import { requireAuth, requireClubOwnerOrRoot } from '../middleware/auth.js';

const router = express.Router();
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

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
    query += ' AND club_id = ?';
    params.push(Number(req.auth.clubId));
  }
  return query;
}

router.get('/logs', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity, limit } = req.query;

    const params = [];
    let query = `SELECT * FROM audit_logs WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND timestamp <= ?';
      params.push(String(to));
    }

    query += ' ORDER BY id DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(Math.min(5000, Math.max(1, Number(limit))));
    }

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
    let query = `SELECT * FROM audit_logs WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND timestamp <= ?';
      params.push(String(to));
    }

    query += ' ORDER BY id DESC LIMIT 10000';

    const rows = await dbAll(db, query, params);

    const header = [
      'id', 'timestamp', 'admin_id', 'admin_login', 'action',
      'entity', 'entity_id', 'source', 'ip_address', 'before', 'after'
    ];

    const lines = [header.join(',')];
    rows.forEach((row) => {
      lines.push([
        csvEscape(row.id),
        csvEscape(row.timestamp),
        csvEscape(row.admin_id),
        csvEscape(row.admin_login),
        csvEscape(row.action),
        csvEscape(row.entity),
        csvEscape(row.entity_id),
        csvEscape(row.source),
        csvEscape(row.ip_address),
        csvEscape(row.before_state),
        csvEscape(row.after_state)
      ].join(','));
    });

    const csv = lines.join('\n');
    return res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="audit-export-${Date.now()}.csv"`)
      .send(csv);
  } catch (error) {
    return next(error);
  }
});

router.post('/export/json', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { action, admin_id, from, to, entity } = req.body || {};

    const params = [];
    let query = `SELECT * FROM audit_logs WHERE 1=1`;
    query = appendScope(query, params, req);

    if (action) {
      query += ' AND action = ?';
      params.push(String(action));
    }
    if (entity) {
      query += ' AND entity = ?';
      params.push(String(entity));
    }
    if (admin_id) {
      query += ' AND admin_id = ?';
      params.push(Number(admin_id));
    }
    if (from) {
      query += ' AND timestamp >= ?';
      params.push(String(from));
    }
    if (to) {
      query += ' AND timestamp <= ?';
      params.push(String(to));
    }

    query += ' ORDER BY id DESC LIMIT 10000';
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
