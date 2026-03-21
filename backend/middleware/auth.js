import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { dbGet, dbRun } from '../db.js';
import { cleanupSecurityArtifacts, getAdminIdleCutoffIso } from '../utils/security.js';

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

function extractBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

export async function requireAuth(req, res, next) {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const blacklisted = await dbGet(
      db,
      'SELECT id FROM token_blacklist WHERE token_hash = ? LIMIT 1',
      [tokenHash]
    );

    if (blacklisted) {
      return res.status(401).json({ error: 'Token is no longer valid' });
    }

    // Reject tokens belonging to deactivated/deleted accounts or with revoked token_version.
    const adminRecord = await dbGet(
      db,
      'SELECT id, token_version FROM admins WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [payload.sub]
    );
    if (!adminRecord) {
      return res.status(401).json({ error: 'Account is no longer active', code: 'ACCOUNT_DEACTIVATED' });
    }
    if (Number(payload.token_version || 0) !== Number(adminRecord.token_version || 0)) {
      return res.status(401).json({ error: 'Session has been revoked. Please log in again.', code: 'SESSION_REVOKED' });
    }

    req.auth = {
      token,
      adminId: payload.sub,
      login: payload.login,
      name: payload.name,
      role: payload.role || (payload.is_root ? SUPER_ADMIN_ROLE : (payload.is_club_owner ? CLUB_OWNER_ROLE : CLUB_ADMIN_ROLE)),
      clubId: payload.club_id ?? null,
      isClubOwner: Boolean(payload.is_club_owner),
      isRoot: Boolean(payload.is_root),
      exp: payload.exp
    };

    if (req.auth.role === CLUB_ADMIN_ROLE && req.auth.clubId) {
      const activeSession = await dbGet(
        db,
        `SELECT admin_id, token_hash, expires_at, created_at, last_seen_at
         FROM admin_active_sessions
         WHERE club_id = ?
         LIMIT 1`,
        [req.auth.clubId]
      );

      if (!activeSession) {
        return res.status(401).json({ error: 'Admin session expired', code: 'ADMIN_SESSION_EXPIRED' });
      }

      const now = new Date().toISOString();
      const idleCutoff = getAdminIdleCutoffIso();
      const isExpired = String(activeSession.expires_at || '') <= now;
      const isIdle = String(activeSession.last_seen_at || activeSession.created_at || '') <= idleCutoff;

      if (isExpired || isIdle) {
        await dbRun(db, 'DELETE FROM admin_active_sessions WHERE club_id = ?', [req.auth.clubId]);
        return res.status(401).json({ error: 'Admin session expired', code: 'ADMIN_SESSION_EXPIRED' });
      }

      if (Number(activeSession.admin_id) !== Number(req.auth.adminId) || activeSession.token_hash !== tokenHash) {
        return res.status(401).json({
          error: 'Admin session was taken over by another login',
          code: 'ADMIN_SESSION_TAKEN_OVER'
        });
      }

      await dbRun(
        db,
        'UPDATE admin_active_sessions SET last_seen_at = ? WHERE club_id = ? AND admin_id = ?',
        [now, req.auth.clubId, req.auth.adminId]
      );
    }

    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRoot(req, res, next) {
  if (!req.auth || (!req.auth.isRoot && req.auth.role !== SUPER_ADMIN_ROLE)) {
    return res.status(403).json({ error: 'Root permissions required' });
  }
  return next();
}

export function requireClubOwnerOrRoot(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.auth.isRoot || req.auth.role === SUPER_ADMIN_ROLE || req.auth.role === CLUB_OWNER_ROLE || req.auth.isClubOwner) {
    return next();
  }
  return res.status(403).json({ error: 'Club owner permissions required' });
}

export function requireClubOwner(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.auth.role === CLUB_OWNER_ROLE || req.auth.isClubOwner) {
    return next();
  }
  return res.status(403).json({ error: 'Club owner permissions required' });
}
