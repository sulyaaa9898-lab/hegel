import express from 'express';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { nowIso } from '../utils/time.js';
import { cleanupSecurityArtifacts, getAdminIdleCutoffIso } from '../utils/security.js';
import { computeSubscriptionState } from '../utils/subscription.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '12h';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

function getEffectiveRole(admin) {
  if (admin.is_root) return SUPER_ADMIN_ROLE;
  if (admin.is_club_owner) return CLUB_OWNER_ROLE;
  return admin.saas_role || CLUB_ADMIN_ROLE;
}

function createToken(admin) {
  return jwt.sign(
    {
      sub: admin.id,
      login: admin.login,
      name: admin.name,
      role: getEffectiveRole(admin),
      club_id: admin.club_id ?? null,
      is_club_owner: Boolean(admin.is_club_owner),
      is_root: admin.is_root,
      token_version: Number(admin.token_version || 0)
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function getTokenExpiryIso(token) {
  const decoded = jwt.decode(token);
  if (!decoded || !decoded.exp) {
    return new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  }
  return new Date(Number(decoded.exp) * 1000).toISOString();
}

async function ensureNoActiveClubAdminSession(db, clubId) {
  const now = nowIso();
  const idleCutoff = getAdminIdleCutoffIso();

  await dbRun(
    db,
    `DELETE FROM admin_active_sessions
     WHERE club_id = ?
       AND (expires_at <= ? OR COALESCE(last_seen_at, created_at) <= ?)` ,
    [clubId, now, idleCutoff]
  );

  return dbGet(
    db,
    `SELECT s.id, s.admin_id
     FROM admin_active_sessions s
     JOIN admins a ON a.id = s.admin_id
     WHERE s.club_id = ?
       AND a.deleted_at IS NULL
       AND COALESCE(a.is_club_owner, 0) = 0
     LIMIT 1`,
    [clubId]
  );
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
      payload.entity || null,
      payload.entityId || null,
      payload.beforeState ? JSON.stringify(payload.beforeState) : null,
      payload.afterState ? JSON.stringify(payload.afterState) : null,
      nowIso(),
      'web',
      payload.ipAddress || null
    ]
  );
}

router.post('/register', async (req, res, next) => {
  return res.status(403).json({
    error: 'Глобальная регистрация отключена. Используйте регистрацию по ссылке клуба.',
    code: 'REGISTRATION_DISABLED'
  });
});

router.post('/login', async (req, res, next) => {
  try {
    const { login, password } = req.body || {};

    if (!login || !password) {
      return res.status(400).json({ error: 'login and password are required' });
    }

    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);
    const requestedClubId = Number(req.headers['x-club-id']);
    const hasClubContext = Number.isInteger(requestedClubId) && requestedClubId > 0;

    let admin = null;
    if (hasClubContext) {
      admin = await dbGet(
        db,
        `SELECT id, login, password_hash, name, role, saas_role, club_id, is_root, is_club_owner, token_version
         FROM admins
         WHERE login = ? AND club_id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [String(login).trim(), requestedClubId]
      );
    } else {
      const rows = await dbAll(
        db,
        `SELECT id, login, password_hash, name, role, saas_role, club_id, is_root, is_club_owner, token_version
         FROM admins
         WHERE login = ? AND deleted_at IS NULL
         ORDER BY is_root DESC, is_club_owner DESC, id ASC`,
        [String(login).trim()]
      );

      if (rows.length > 1) {
        return res.status(400).json({
          error: 'Этот логин используется в нескольких клубах. Входите через ссылку конкретного клуба.',
          code: 'CLUB_CONTEXT_REQUIRED'
        });
      }

      admin = rows[0] || null;
    }

    if (!admin) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const validPassword = await bcryptjs.compare(String(password), admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const effectiveRole = getEffectiveRole(admin);
    let subscriptionInfo = null;
    if (effectiveRole === CLUB_ADMIN_ROLE || effectiveRole === CLUB_OWNER_ROLE) {
      const club = await dbGet(
        db,
        `SELECT id, is_enabled, subscription_status,
                subscription_type, subscription_started_at, subscription_expires_at,
                trial_ends_at, subscription_ends_at
         FROM clubs
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [admin.club_id]
      );

      if (!club || !club.is_enabled) {
        return res.status(403).json({ error: 'Club is disabled or not found' });
      }

      subscriptionInfo = computeSubscriptionState(club);
      if (subscriptionInfo.subscription_status === 'blocked') {
        return res.status(403).json({ error: 'Club access denied: blocked' });
      }
    }

    if (effectiveRole === CLUB_ADMIN_ROLE) {
      const activeSession = await ensureNoActiveClubAdminSession(db, admin.club_id);
      if (activeSession) {
        if (Number(activeSession.admin_id) === Number(admin.id)) {
          return res.status(409).json({
            error: 'Этот администратор уже находится в активной сессии. Сначала завершите текущую сессию.',
            code: 'ADMIN_ALREADY_LOGGED_IN'
          });
        } else {
          return res.status(409).json({
            error: 'В этом клубе уже работает другой администратор. Одновременно может быть только один администратор.',
            code: 'ADMIN_SESSION_ACTIVE'
          });
        }
      }
    }

    const token = createToken(admin);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = getTokenExpiryIso(token);

    if (effectiveRole === CLUB_ADMIN_ROLE) {
      const timestamp = nowIso();
      await dbRun(
        db,
        `INSERT INTO admin_active_sessions (club_id, admin_id, token_hash, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)` ,
        [admin.club_id, admin.id, tokenHash, timestamp, timestamp, expiresAt]
      );
    }

    await writeAudit(db, {
      clubId: admin.club_id,
      adminId: admin.id,
      adminLogin: admin.login,
      action: 'LOGIN',
      entity: 'user',
      entityId: admin.id,
      afterState: {
        admin_id: admin.id,
        login: admin.login,
        name: admin.name
      },
      ipAddress: req.ip
    });

    return res.json({
      token,
      token_type: 'Bearer',
      expires_in: JWT_EXPIRY,
      admin: {
        id: admin.id,
        login: admin.login,
        name: admin.name,
        role: effectiveRole,
        club_id: admin.club_id,
        is_club_owner: Boolean(admin.is_club_owner),
        is_root: Boolean(admin.is_root)
      },
      subscription: subscriptionInfo
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);
    const tokenHash = crypto.createHash('sha256').update(req.auth.token).digest('hex');
    const expiresAt = new Date(req.auth.exp * 1000).toISOString();

    await dbRun(
      db,
      `INSERT OR IGNORE INTO token_blacklist (token_hash, admin_id, club_id, expires_at)
       VALUES (?, ?, ?, ?)` ,
      [tokenHash, req.auth.adminId, req.auth.clubId || null, expiresAt]
    );

    if (req.auth.role === CLUB_ADMIN_ROLE && req.auth.clubId) {
      await dbRun(
        db,
        'DELETE FROM admin_active_sessions WHERE club_id = ? AND admin_id = ?',
        [req.auth.clubId, req.auth.adminId]
      );
    }

    await writeAudit(db, {
      clubId: req.auth.clubId,
      adminId: req.auth.adminId,
      adminLogin: req.auth.login,
      action: 'LOGOUT',
      entity: 'user',
      entityId: req.auth.adminId,
      ipAddress: req.ip
    });

    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    return next(error);
  }
});

router.post('/refresh', requireAuth, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);
    const admin = await dbGet(
      db,
      `SELECT id, login, name, role, saas_role, club_id, is_root, is_club_owner
       FROM admins
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [req.auth.adminId]
    );

    if (!admin) {
      return res.status(401).json({ error: 'Admin not found or deleted' });
    }

    const effectiveRole = getEffectiveRole(admin);
    const token = createToken(admin);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = getTokenExpiryIso(token);

    if (effectiveRole === CLUB_ADMIN_ROLE && admin.club_id) {
      const updated = await dbRun(
        db,
        `UPDATE admin_active_sessions
         SET token_hash = ?, expires_at = ?, last_seen_at = ?
         WHERE club_id = ? AND admin_id = ?` ,
        [tokenHash, expiresAt, nowIso(), admin.club_id, admin.id]
      );

      if (!updated.changes) {
        return res.status(401).json({
          error: 'Admin session expired',
          code: 'ADMIN_SESSION_EXPIRED'
        });
      }
    }

    return res.json({
      token,
      token_type: 'Bearer',
      expires_in: JWT_EXPIRY,
      admin: {
        id: admin.id,
        login: admin.login,
        name: admin.name,
        role: effectiveRole,
        club_id: admin.club_id,
        is_club_owner: Boolean(admin.is_club_owner),
        is_root: Boolean(admin.is_root)
      }
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
