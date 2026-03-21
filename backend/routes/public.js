import express from 'express';
import bcryptjs from 'bcryptjs';
import { dbGet, dbRun } from '../db.js';
import { nowIso } from '../utils/time.js';
import {
  buildPublicUrl,
  cleanupSecurityArtifacts,
  hashToken
} from '../utils/security.js';
import { computeSubscriptionState } from '../utils/subscription.js';

const router = express.Router();

const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';
const CLUB_OWNER_ROLE = 'CLUB_OWNER';

async function resolveInvite(db, rawToken, expectedType) {
  const tokenHash = hashToken(rawToken);
  const invite = await dbGet(
    db,
    `SELECT i.id, i.club_id, i.invite_type, i.expires_at, i.used_at,
            c.slug, c.name, c.is_enabled, c.subscription_status,
            c.subscription_type, c.subscription_started_at, c.subscription_expires_at,
            c.trial_ends_at, c.subscription_ends_at
     FROM invite_tokens i
     JOIN clubs c ON c.id = i.club_id
     WHERE i.token_hash = ?
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );

  if (!invite) return { error: 'INVITE_NOT_FOUND' };
  if (expectedType && invite.invite_type !== expectedType) return { error: 'INVITE_TYPE_MISMATCH' };
  if (invite.used_at) return { error: 'INVITE_ALREADY_USED' };
  if (String(invite.expires_at) <= nowIso()) return { error: 'INVITE_EXPIRED' };
  const subscription = computeSubscriptionState(invite);
  if (!invite.is_enabled || subscription.subscription_status === 'blocked' || subscription.subscription_status === 'expired') {
    return { error: 'CLUB_UNAVAILABLE' };
  }

  return { invite, tokenHash };
}

function getInviteErrorResponse(errorCode) {
  const map = {
    INVITE_NOT_FOUND: { status: 404, error: 'Invite not found', code: 'INVITE_NOT_FOUND' },
    INVITE_TYPE_MISMATCH: { status: 400, error: 'Invite type mismatch', code: 'INVITE_TYPE_MISMATCH' },
    INVITE_ALREADY_USED: { status: 409, error: 'Invite already used', code: 'INVITE_ALREADY_USED' },
    INVITE_EXPIRED: { status: 410, error: 'Invite expired', code: 'INVITE_EXPIRED' },
    CLUB_UNAVAILABLE: { status: 403, error: 'Club registration is unavailable', code: 'CLUB_UNAVAILABLE' }
  };
  return map[errorCode] || { status: 400, error: 'Invalid invite token', code: 'INVITE_INVALID' };
}

router.get('/club-by-slug/:slug', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);
    const slug = String(req.params.slug || '').trim().toLowerCase();

    if (!slug) {
      return res.status(400).json({ error: 'slug is required' });
    }

    const club = await dbGet(
      db,
      `SELECT id, slug, name, club_type, is_enabled, subscription_status,
              subscription_type, subscription_started_at, subscription_expires_at,
              trial_ends_at, subscription_ends_at,
              is_configured
       FROM clubs
       WHERE slug = ? AND deleted_at IS NULL
       LIMIT 1`,
      [slug]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const pcCountRow = await dbGet(
      db,
      `SELECT COUNT(*) AS count
       FROM club_devices
       WHERE club_id = ?
         AND device_type = 'PC'
         AND is_active = 1
         AND deleted_at IS NULL`,
      [club.id]
    );

    const psCountRow = await dbGet(
      db,
      `SELECT COUNT(*) AS count
       FROM club_devices
       WHERE club_id = ?
         AND device_type = 'PS'
         AND is_active = 1
         AND deleted_at IS NULL`,
      [club.id]
    );

    const latestVersion = await dbGet(
      db,
      `SELECT config_json
       FROM club_config_versions
       WHERE club_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      [club.id]
    );

    let applyOptions = null;
    if (latestVersion && latestVersion.config_json) {
      try {
        const parsed = JSON.parse(latestVersion.config_json);
        applyOptions = {
          pc_mode: String(parsed?.pc_mode || 'SET_COUNT').trim().toUpperCase(),
          ps_mode: String(parsed?.ps_mode || 'SET_COUNT').trim().toUpperCase()
        };
      } catch (_) {
        applyOptions = null;
      }
    }

    const subscription = computeSubscriptionState(club);

    return res.json({
      id: club.id,
      slug: club.slug,
      name: club.name,
      club_type: club.club_type || null,
      is_enabled: Boolean(club.is_enabled),
      subscription_type: subscription.subscription_type,
      subscription_started_at: subscription.subscription_started_at,
      subscription_expires_at: subscription.subscription_expires_at,
      subscription_status: subscription.subscription_status,
      subscription_days_left: subscription.subscription_days_left,
      subscription_is_expired: subscription.subscription_is_expired,
      subscription_notice: subscription.subscription_notice,
      is_configured: Boolean(club.is_configured),
      apply_options: applyOptions,
      pc_count: Number(pcCountRow?.count || 0),
      ps_count: Number(psCountRow?.count || 0),
      local_link: buildPublicUrl(`/club/${club.slug}`)
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/invites', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);

    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'token is required', code: 'TOKEN_REQUIRED' });
    }

    const resolved = await resolveInvite(db, token);
    if (resolved.error) {
      const inviteError = getInviteErrorResponse(resolved.error);
      return res.status(inviteError.status).json({ error: inviteError.error, code: inviteError.code });
    }

    const { invite } = resolved;
    return res.json({
      invite_type: invite.invite_type,
      club_id: invite.club_id,
      club_slug: invite.slug,
      club_name: invite.name,
      expires_at: invite.expires_at,
      register_link: buildPublicUrl(`/register?token=${encodeURIComponent(token)}`),
      activate_owner_link: buildPublicUrl(`/activate-owner?token=${encodeURIComponent(token)}`),
      club_link: buildPublicUrl(`/club/${invite.slug}`)
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/activate-owner', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);

    const token = String(req.body?.token || '').trim();
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim() || login;

    if (!token || !login || !password) {
      return res.status(400).json({ error: 'token, login and password are required', code: 'INVALID_PAYLOAD' });
    }

    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const resolved = await resolveInvite(db, token, 'OWNER');
    if (resolved.error) {
      const inviteError = getInviteErrorResponse(resolved.error);
      return res.status(inviteError.status).json({ error: inviteError.error, code: inviteError.code });
    }

    const { invite, tokenHash } = resolved;
    const existingOwner = await dbGet(
      db,
      `SELECT id, login
       FROM admins
       WHERE club_id = ? AND is_club_owner = 1 AND deleted_at IS NULL
       LIMIT 1`,
      [invite.club_id]
    );

    if (existingOwner) {
      return res.status(409).json({ error: `В клубе уже есть владелец: ${existingOwner.login}`, code: 'OWNER_EXISTS' });
    }

    const sameLoginInClub = await dbGet(
      db,
      'SELECT id FROM admins WHERE club_id = ? AND login = ? AND deleted_at IS NULL LIMIT 1',
      [invite.club_id, login]
    );
    if (sameLoginInClub) {
      return res.status(409).json({ error: 'Логин уже занят в этом клубе', code: 'LOGIN_EXISTS' });
    }

    const passwordHash = await bcryptjs.hash(password, 10);
    const timestamp = nowIso();

    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      const inserted = await dbRun(
        db,
        `INSERT INTO admins (login, password_hash, name, role, is_root, is_club_owner, saas_role, club_id, created_at)
         VALUES (?, ?, ?, 'admin', 0, 1, ?, ?, ?)` ,
        [login, passwordHash, name, CLUB_ADMIN_ROLE, invite.club_id, timestamp]
      );

      await dbRun(
        db,
        `UPDATE invite_tokens
         SET used_at = ?, used_by_admin_id = ?
         WHERE id = ? AND token_hash = ? AND used_at IS NULL`,
        [timestamp, inserted.id, invite.id, tokenHash]
      );

      await dbRun(db, 'COMMIT');

      return res.status(201).json({
        success: true,
        role: CLUB_OWNER_ROLE,
        club_id: invite.club_id,
        club_slug: invite.slug,
        club_link: buildPublicUrl(`/club/${invite.slug}`)
      });
    } catch (error) {
      await dbRun(db, 'ROLLBACK');
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await cleanupSecurityArtifacts(db, dbRun);

    const token = String(req.body?.token || '').trim();
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim() || login;

    if (!token || !login || !password) {
      return res.status(400).json({ error: 'token, login and password are required', code: 'INVALID_PAYLOAD' });
    }

    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const resolved = await resolveInvite(db, token, 'ADMIN');
    if (resolved.error) {
      const inviteError = getInviteErrorResponse(resolved.error);
      return res.status(inviteError.status).json({ error: inviteError.error, code: inviteError.code });
    }

    const { invite, tokenHash } = resolved;
    const sameLoginInClub = await dbGet(
      db,
      'SELECT id FROM admins WHERE club_id = ? AND login = ? AND deleted_at IS NULL LIMIT 1',
      [invite.club_id, login]
    );
    if (sameLoginInClub) {
      return res.status(409).json({ error: 'Логин уже занят в этом клубе', code: 'LOGIN_EXISTS' });
    }

    const passwordHash = await bcryptjs.hash(password, 10);
    const timestamp = nowIso();

    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      const inserted = await dbRun(
        db,
        `INSERT INTO admins (login, password_hash, name, role, is_root, is_club_owner, saas_role, club_id, created_at)
         VALUES (?, ?, ?, 'admin', 0, 0, ?, ?, ?)` ,
        [login, passwordHash, name, CLUB_ADMIN_ROLE, invite.club_id, timestamp]
      );

      await dbRun(
        db,
        `UPDATE invite_tokens
         SET used_at = ?, used_by_admin_id = ?
         WHERE id = ? AND token_hash = ? AND used_at IS NULL`,
        [timestamp, inserted.id, invite.id, tokenHash]
      );

      await dbRun(db, 'COMMIT');

      return res.status(201).json({
        success: true,
        role: CLUB_ADMIN_ROLE,
        club_id: invite.club_id,
        club_slug: invite.slug,
        club_link: buildPublicUrl(`/club/${invite.slug}`)
      });
    } catch (error) {
      await dbRun(db, 'ROLLBACK');
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post('/club-by-slug/:slug/register-admin', async (req, res, next) => {
  return res.status(410).json({
    error: 'Регистрация по slug отключена. Используйте invite-ссылку вида /register?token=...',
    code: 'INVITE_REQUIRED'
  });
});

export default router;
