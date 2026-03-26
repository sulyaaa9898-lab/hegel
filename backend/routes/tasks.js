import express from 'express';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';
import { nowIso } from '../utils/time.js';

const router = express.Router();

function mapTask(row) {
  return {
    id: row.id,
    club_id: row.club_id,
    title: row.title,
    description: row.description || '',
    is_done: Boolean(row.is_done),
    is_urgent: Boolean(row.is_urgent),
    created_by_admin_id: row.created_by_admin_id,
    created_by_login: row.created_by_login || null,
    created_by_name: row.created_by_name || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at || null
  };
}

router.use(requireAuth);
router.use(requireClubContext);

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const status = String(req.query.status || 'all').trim().toLowerCase();

    const params = [Number(req.club.id)];
    let query = `
      SELECT
        t.*,
        a.login AS created_by_login,
        a.name AS created_by_name
      FROM club_tasks t
      LEFT JOIN admins a ON a.id = t.created_by_admin_id
      WHERE t.club_id = ?
        AND t.deleted_at IS NULL
    `;

    if (status === 'open') {
      query += ' AND t.is_done = 0';
    } else if (status === 'done') {
      query += ' AND t.is_done = 1';
    }

    query += `
      ORDER BY
        t.is_done ASC,
        t.is_urgent DESC,
        datetime(t.created_at) DESC,
        t.id DESC
      LIMIT 500
    `;

    const rows = await dbAll(db, query, params);
    return res.json({ count: rows.length, tasks: rows.map(mapTask) });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const isUrgent = req.body?.is_urgent === true || String(req.body?.is_urgent || '').trim() === '1';

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    if (title.length > 200) {
      return res.status(400).json({ error: 'title is too long (max 200 chars)' });
    }

    if (description.length > 2000) {
      return res.status(400).json({ error: 'description is too long (max 2000 chars)' });
    }

    const timestamp = nowIso();
    const insert = await dbRun(
      db,
      `INSERT INTO club_tasks (
        club_id, title, description, is_done, is_urgent,
        created_by_admin_id, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)` ,
      [
        Number(req.club.id),
        title,
        description || null,
        isUrgent ? 1 : 0,
        Number(req.auth.adminId),
        timestamp,
        timestamp
      ]
    );

    const created = await dbGet(
      db,
      `SELECT
         t.*,
         a.login AS created_by_login,
         a.name AS created_by_name
       FROM club_tasks t
       LEFT JOIN admins a ON a.id = t.created_by_admin_id
       WHERE t.id = ?
       LIMIT 1`,
      [insert.id]
    );

    return res.status(201).json(mapTask(created));
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    const existing = await dbGet(
      db,
      'SELECT * FROM club_tasks WHERE id = ? AND club_id = ? AND deleted_at IS NULL LIMIT 1',
      [taskId, Number(req.club.id)]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(req.body || {}, 'title');
    const hasDescription = Object.prototype.hasOwnProperty.call(req.body || {}, 'description');
    const hasDone = Object.prototype.hasOwnProperty.call(req.body || {}, 'is_done');
    const hasUrgent = Object.prototype.hasOwnProperty.call(req.body || {}, 'is_urgent');

    const nextTitle = hasTitle ? String(req.body.title || '').trim() : String(existing.title || '').trim();
    const nextDescription = hasDescription ? String(req.body.description || '').trim() : String(existing.description || '').trim();
    const nextDone = hasDone
      ? (req.body.is_done === true || String(req.body.is_done || '').trim() === '1')
      : Boolean(existing.is_done);
    const nextUrgent = hasUrgent
      ? (req.body.is_urgent === true || String(req.body.is_urgent || '').trim() === '1')
      : Boolean(existing.is_urgent);

    if (!nextTitle) {
      return res.status(400).json({ error: 'title is required' });
    }

    if (nextTitle.length > 200) {
      return res.status(400).json({ error: 'title is too long (max 200 chars)' });
    }

    if (nextDescription.length > 2000) {
      return res.status(400).json({ error: 'description is too long (max 2000 chars)' });
    }

    const timestamp = nowIso();
    const resolvedAt = nextDone ? (existing.resolved_at || timestamp) : null;

    await dbRun(
      db,
      `UPDATE club_tasks
       SET title = ?,
           description = ?,
           is_done = ?,
           is_urgent = ?,
           resolved_at = ?,
           updated_at = ?
       WHERE id = ? AND club_id = ?`,
      [
        nextTitle,
        nextDescription || null,
        nextDone ? 1 : 0,
        nextUrgent ? 1 : 0,
        resolvedAt,
        timestamp,
        taskId,
        Number(req.club.id)
      ]
    );

    const updated = await dbGet(
      db,
      `SELECT
         t.*,
         a.login AS created_by_login,
         a.name AS created_by_name
       FROM club_tasks t
       LEFT JOIN admins a ON a.id = t.created_by_admin_id
       WHERE t.id = ?
       LIMIT 1`,
      [taskId]
    );

    return res.json(mapTask(updated));
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const taskId = Number(req.params.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    const result = await dbRun(
      db,
      `UPDATE club_tasks
       SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND club_id = ? AND deleted_at IS NULL`,
      [nowIso(), nowIso(), taskId, Number(req.club.id)]
    );

    if (!result.changes) {
      return res.status(404).json({ error: 'Task not found' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
