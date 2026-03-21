import express from 'express';
import bcryptjs from 'bcryptjs';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth, requireClubOwnerOrRoot } from '../middleware/auth.js';
import { nowIso } from '../utils/time.js';
import {
  buildPublicUrl,
  cleanupSecurityArtifacts,
  createInviteToken,
  hashToken,
  INVITE_ADMIN_TTL_DAYS,
  plusDaysIso
} from '../utils/security.js';
import { computeSubscriptionState } from '../utils/subscription.js';

const router = express.Router();
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

async function writeAudit(db, payload) {
  await dbRun(
    db,
    `INSERT INTO audit_logs (
      club_id, admin_id, admin_login, action, entity, entity_id,
      before_state, after_state, timestamp, source, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

router.use(requireAuth);
router.use(requireClubOwnerOrRoot);

router.use(async (req, res, next) => {
  try {
    if (req.method === 'GET' || req.auth?.isRoot) return next();

    const clubId = Number(req.auth?.clubId || 0);
    if (!clubId) return next();

    const club = await dbGet(
      req.app.locals.db,
      `SELECT id, is_enabled, subscription_status,
              subscription_type, subscription_started_at, subscription_expires_at,
              trial_ends_at, subscription_ends_at
       FROM clubs
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [clubId]
    );

    if (!club || !club.is_enabled) {
      return res.status(403).json({ error: 'Club is disabled or not found' });
    }

    const subscription = computeSubscriptionState(club);
    if (subscription.subscription_status === 'blocked' || subscription.subscription_status === 'expired') {
      return res.status(403).json({
        error: 'Подписка истекла. Продлите подписку.',
        code: 'SUBSCRIPTION_EXPIRED',
        subscription
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
});

router.post('/invites', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);

    const requestedClubId = Number(req.body?.club_id || req.auth.clubId || 0);
    if (!Number.isInteger(requestedClubId) || requestedClubId <= 0) {
      return res.status(400).json({ error: 'club_id is required', code: 'CLUB_ID_REQUIRED' });
    }

    if (!req.auth.isRoot && Number(req.auth.clubId) !== requestedClubId) {
      return res.status(403).json({ error: 'You can only manage admins in your club' });
    }

    const club = await dbGet(
      db,
      `SELECT id, slug, is_enabled, subscription_status,
              subscription_type, subscription_started_at, subscription_expires_at,
              trial_ends_at, subscription_ends_at
       FROM clubs
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [requestedClubId]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const subscription = computeSubscriptionState(club);
    if (!club.is_enabled || subscription.subscription_status === 'blocked' || subscription.subscription_status === 'expired') {
      return res.status(403).json({ error: 'Club registration is unavailable', code: 'CLUB_UNAVAILABLE' });
    }

    const token = createInviteToken();
    const tokenHash = hashToken(token);
    const createdAt = nowIso();
    const expiresAt = plusDaysIso(INVITE_ADMIN_TTL_DAYS);

    await dbRun(
      db,
      `INSERT INTO invite_tokens (club_id, created_by_admin_id, invite_type, token_hash, created_at, expires_at)
       VALUES (?, ?, 'ADMIN', ?, ?, ?)` ,
      [requestedClubId, req.auth.adminId, tokenHash, createdAt, expiresAt]
    );

    return res.status(201).json({
      club_id: requestedClubId,
      club_slug: club.slug,
      invite_type: 'ADMIN',
      expires_at: expiresAt,
      register_link: buildPublicUrl(`/register?token=${encodeURIComponent(token)}`),
      club_link: buildPublicUrl(`/club/${club.slug}`)
    });
  } catch (error) {
    return next(error);
  }
});

function canManageAdmin(req, target) {
  if (req.auth.isRoot) return true;
  if (req.auth.role !== CLUB_OWNER_ROLE && !req.auth.isClubOwner) return false;
  return Number(req.auth.clubId) === Number(target.club_id);
}

router.get('/', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const includeDeleted = req.query.include_deleted === '1';

    const params = [];
    let query = `SELECT id, login, name, role, is_root, is_club_owner, club_id, created_at, deleted_at FROM admins`;

    if (req.auth.isRoot) {
      query += includeDeleted ? '' : ' WHERE deleted_at IS NULL';
    } else {
      query += includeDeleted
        ? ' WHERE club_id = ?'
        : ' WHERE club_id = ? AND deleted_at IS NULL';
      params.push(Number(req.auth.clubId));
    }

    query += ' ORDER BY is_root DESC, is_club_owner DESC, created_at ASC, id ASC';

    const rows = await dbAll(db, query, params);

    return res.json(rows.map((row) => ({
      id: row.id,
      login: row.login,
      name: row.name,
      role: row.role,
      is_root: Boolean(row.is_root),
      is_club_owner: Boolean(row.is_club_owner),
      club_id: row.club_id,
      created_at: row.created_at,
      deleted_at: row.deleted_at
    })));
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);

    const target = await dbGet(
      db,
      'SELECT id, login, name, role, is_root, is_club_owner, club_id, created_at, deleted_at FROM admins WHERE id = ? LIMIT 1',
      [id]
    );

    if (!target) return res.status(404).json({ error: 'Admin not found' });
    if (target.deleted_at) return res.status(409).json({ error: 'Admin already deleted' });
    if (target.is_root) return res.status(400).json({ error: 'Root admin cannot be deleted' });
    if (target.is_club_owner) return res.status(400).json({ error: 'Club owner cannot be deleted from this action' });
    if (!canManageAdmin(req, target)) return res.status(403).json({ error: 'You can only manage admins in your club' });

    const beforeState = {
      id: target.id,
      login: target.login,
      name: target.name,
      role: target.role,
      is_root: Boolean(target.is_root),
      is_club_owner: Boolean(target.is_club_owner),
      created_at: target.created_at
    };

    const deletedAt = nowIso();
    await dbRun(db, 'UPDATE admins SET deleted_at = ? WHERE id = ?', [deletedAt, id]);

    await writeAudit(db, {
      clubId: target.club_id,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'DELETE_ADMIN',
      entity: 'admin',
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

router.put('/:id/password', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const password = String(req.body?.password || '');

    if (!password || password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const target = await dbGet(
      db,
      'SELECT id, login, deleted_at FROM admins WHERE id = ? LIMIT 1',
      [id]
    );
    if (!target || target.deleted_at) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    if (!req.auth.isRoot) {
      const scopedTarget = await dbGet(
        db,
        'SELECT club_id, is_club_owner FROM admins WHERE id = ? LIMIT 1',
        [id]
      );
      if (!scopedTarget || Number(scopedTarget.club_id) !== Number(req.auth.clubId) || scopedTarget.is_club_owner) {
        return res.status(403).json({ error: 'You can only manage admins in your club' });
      }
    }

    const hash = await bcryptjs.hash(password, 10);
    await dbRun(db, 'UPDATE admins SET password_hash = ? WHERE id = ?', [hash, id]);

    await writeAudit(db, {
      clubId: req.auth.isRoot ? null : req.auth.clubId,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'PASSWORD_CHANGE',
      entity: 'admin',
      entityId: id,
      beforeState: { login: target.login },
      afterState: { login: target.login },
      ipAddress: req.ip
    });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
