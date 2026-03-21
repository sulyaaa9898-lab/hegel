import express from 'express';
import bcryptjs from 'bcryptjs';
import { dbAll, dbGet, dbRun } from '../db.js';
import { requireAuth, requireRoot } from '../middleware/auth.js';
import { nowIso } from '../utils/time.js';
import { buildPublicUrl, createInviteToken, hashToken, INVITE_OWNER_TTL_DAYS, plusDaysIso } from '../utils/security.js';
import { buildRenewedSubscription, buildSubscriptionWindow, computeSubscriptionState } from '../utils/subscription.js';

const router = express.Router();
const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';

function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function createOwnerInvite(db, clubId, createdByAdminId) {
  const existingOwner = await dbGet(
    db,
    `SELECT id, login
     FROM admins
     WHERE club_id = ?
       AND is_club_owner = 1
       AND deleted_at IS NULL
     ORDER BY id ASC
     LIMIT 1`,
    [clubId]
  );

  if (existingOwner) {
    return null;
  }

  const rawToken = createInviteToken();
  const tokenHash = hashToken(rawToken);
  const timestamp = nowIso();
  await dbRun(
    db,
    `INSERT INTO invite_tokens (club_id, created_by_admin_id, invite_type, token_value, token_hash, created_at, expires_at)
     VALUES (?, ?, 'OWNER', ?, ?, ?, ?)` ,
    [clubId, createdByAdminId || null, rawToken, tokenHash, timestamp, plusDaysIso(INVITE_OWNER_TTL_DAYS)]
  );

  return {
    invite_token: rawToken,
    invite_link: buildPublicUrl(`/activate-owner?token=${encodeURIComponent(rawToken)}`)
  };
}

async function getActiveOwnerInviteLink(db, clubId) {
  const row = await dbGet(
    db,
    `SELECT token_value
     FROM invite_tokens
     WHERE club_id = ?
       AND invite_type = 'OWNER'
       AND used_at IS NULL
       AND expires_at > ?
       AND token_value IS NOT NULL
       AND token_value <> ''
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [clubId, nowIso()]
  );

  if (!row || !row.token_value) return null;
  return buildPublicUrl(`/activate-owner?token=${encodeURIComponent(row.token_value)}`);
}

async function getOrCreateOwnerInviteLink(db, clubId, createdByAdminId) {
  const existing = await getActiveOwnerInviteLink(db, clubId);
  if (existing) return existing;
  const created = await createOwnerInvite(db, clubId, createdByAdminId);
  return created ? created.invite_link : null;
}

async function revokeActiveOwnerInvites(db, clubId) {
  const timestamp = nowIso();
  await dbRun(
    db,
    `UPDATE invite_tokens
     SET expires_at = ?
     WHERE club_id = ?
       AND invite_type = 'OWNER'
       AND used_at IS NULL
       AND expires_at > ?`,
    [timestamp, clubId, timestamp]
  );
}

async function rotateOwnerInvite(db, clubId, createdByAdminId) {
  await revokeActiveOwnerInvites(db, clubId);
  return createOwnerInvite(db, clubId, createdByAdminId);
}

async function getActiveClubOwners(db, clubId) {
  return dbAll(
    db,
    `SELECT id, login
     FROM admins
     WHERE club_id = ?
       AND is_club_owner = 1
       AND deleted_at IS NULL
     ORDER BY id ASC`,
    [clubId]
  );
}

function toSlug(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTariffs(items, deviceType) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      device_type: deviceType,
      tariff_name: String(item?.tariff_name || item?.name || '').trim(),
      billing_type: String(item?.billing_type || item?.type || '').trim().toLowerCase(),
      price: Number(item?.price || 0),
      duration_minutes: item?.duration_minutes === null || item?.duration_minutes === undefined
        ? null
        : Number(item.duration_minutes),
      applies_to_type: String(item?.applies_to_type || 'ALL').trim().toUpperCase(),
      applies_to_value: item?.applies_to_value === undefined || item?.applies_to_value === null
        ? null
        : String(item.applies_to_value).trim()
    }))
    .filter((item) => {
      const isBasicValid = item.tariff_name && item.price > 0 && (item.billing_type === 'hourly' || item.billing_type === 'package');
      if (!isBasicValid) return false;
      if (item.billing_type === 'package') {
        if (item.duration_minutes === null || Number(item.duration_minutes) <= 0) return false;
      }
      if (!['ALL', 'GROUP', 'DEVICE'].includes(item.applies_to_type)) return false;
      if (item.applies_to_type === 'ALL') return true;
      return Boolean(item.applies_to_value);
    });
}

function makeDeviceName(prefix, index, explicitName) {
  const fallback = `${prefix}-${String(index).padStart(2, '0')}`;
  const name = String(explicitName || '').trim();
  return name || fallback;
}

function enrichClubRow(row) {
  const subscription = computeSubscriptionState(row);
  return {
    ...row,
    is_enabled: Boolean(row.is_enabled),
    is_configured: Boolean(row.is_configured),
    subscription_type: subscription.subscription_type,
    subscription_started_at: subscription.subscription_started_at,
    subscription_expires_at: subscription.subscription_expires_at,
    subscription_status: subscription.subscription_status,
    subscription_days_left: subscription.subscription_days_left,
    subscription_is_expired: subscription.subscription_is_expired,
    subscription_notice: subscription.subscription_notice,
    // Legacy fields are kept for compatibility with old clients.
    trial_ends_at: subscription.subscription_type === 'trial' ? subscription.subscription_expires_at : row.trial_ends_at,
    subscription_ends_at: subscription.subscription_expires_at
  };
}

async function getClubConfig(db, clubId) {
  const devices = await dbAll(
    db,
    `SELECT id, device_type, device_code, display_name, sort_order, is_active, tariff_group
     FROM club_devices
     WHERE club_id = ? AND deleted_at IS NULL
     ORDER BY device_type ASC, sort_order ASC, id ASC`,
    [clubId]
  );

  const tariffs = await dbAll(
    db,
    `SELECT id, device_type, tariff_name, billing_type, price, duration_minutes,
            applies_to_type, applies_to_value, is_active
     FROM club_tariffs
     WHERE club_id = ? AND deleted_at IS NULL
     ORDER BY device_type ASC, billing_type ASC, id ASC`,
    [clubId]
  );

  const latestVersion = await dbGet(
    db,
    `SELECT config_json
     FROM club_config_versions
     WHERE club_id = ?
     ORDER BY version DESC
     LIMIT 1`,
    [clubId]
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

  return {
    devices,
    tariffs,
    apply_options: applyOptions,
    counts: {
      pc: devices.filter((item) => item.device_type === 'PC' && item.is_active).length,
      ps: devices.filter((item) => item.device_type === 'PS' && item.is_active).length
    }
  };
}

router.use(requireAuth);
router.use(requireRoot);

router.get('/clubs', async (req, res, next) => {
  try {
    const rows = await dbAll(
      req.app.locals.db,
      `SELECT id, slug, name, club_type, is_enabled, subscription_status,
              subscription_type, subscription_started_at, subscription_expires_at,
              trial_ends_at, subscription_ends_at,
              timezone, is_configured, created_at, updated_at
       FROM clubs
       WHERE deleted_at IS NULL
       ORDER BY id ASC`
    );

    return res.json(rows.map((row) => enrichClubRow(row)));
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs', async (req, res, next) => {
  let txStarted = false;
  let txFailedToStart = false;
  let insertedClubId = null;
  try {
    const db = req.app.locals.db;
    const payload = req.body || {};

    const name = String(payload.name || '').trim();
    const slug = toSlug(payload.slug || name);
    const clubType = String(payload.club_type || '').trim() || null;
    const timezone = String(payload.timezone || 'Asia/Almaty').trim();
    const timestamp = nowIso();
    const subscriptionWindow = buildSubscriptionWindow(payload, timestamp);

    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }

    const existingBySlug = await dbGet(
      db,
      'SELECT id, deleted_at FROM clubs WHERE slug = ? LIMIT 1',
      [slug]
    );

    if (existingBySlug && !existingBySlug.deleted_at) {
      // Recovery mode: if club already exists, allow creating owner account for it.
      const existingClub = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [existingBySlug.id]);
      const ownerInvite = await createOwnerInvite(db, existingBySlug.id, req.auth.adminId);
      return res.status(200).json({
        ...enrichClubRow(existingClub),
        reused: true,
        club_link: buildPublicUrl(`/club/${existingClub.slug}`),
        owner_invite_link: ownerInvite ? ownerInvite.invite_link : null,
        local_link: buildPublicUrl(`/club/${existingClub.slug}`)
      });
    }

    if (existingBySlug && existingBySlug.deleted_at) {
      // Restored club owner should be activated by invite token.
    }

    try {
      await dbRun(db, 'BEGIN IMMEDIATE TRANSACTION');
      txStarted = true;
    } catch (txError) {
      // SQLite can reject BEGIN on a shared connection if another transaction is active.
      if (String(txError?.message || '').includes('cannot start a transaction within a transaction')) {
        txFailedToStart = true;
        throw createHttpError(503, 'Сервер занят применением другой операции. Повторите создание клуба через 1-2 секунды.', 'DB_BUSY_RETRY');
      } else {
        throw txError;
      }
    }

    // Reuse the same slug if the club was soft-deleted earlier.
    if (existingBySlug && existingBySlug.deleted_at) {
      await dbRun(
        db,
        `UPDATE clubs
         SET name = ?, club_type = ?, is_enabled = 1, subscription_status = ?,
             subscription_type = ?, subscription_started_at = ?, subscription_expires_at = ?,
             trial_ends_at = ?, subscription_ends_at = ?, timezone = ?,
             is_configured = 0, deleted_at = NULL, updated_at = ?
         WHERE id = ?`,
        [
          name,
          clubType,
          subscriptionWindow.subscription_status,
          subscriptionWindow.subscription_type,
          subscriptionWindow.subscription_started_at,
          subscriptionWindow.subscription_expires_at,
          subscriptionWindow.subscription_type === 'trial' ? subscriptionWindow.subscription_expires_at : null,
          subscriptionWindow.subscription_expires_at,
          timezone,
          timestamp,
          existingBySlug.id
        ]
      );

      const restored = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [existingBySlug.id]);
      const ownerInvite = await createOwnerInvite(db, restored.id, req.auth.adminId);
      if (txStarted) {
        await dbRun(db, 'COMMIT');
        txStarted = false;
      }
      return res.status(200).json({
        ...enrichClubRow(restored),
        restored: true,
        club_link: buildPublicUrl(`/club/${restored.slug}`),
        owner_invite_link: ownerInvite ? ownerInvite.invite_link : null,
        local_link: buildPublicUrl(`/club/${restored.slug}`)
      });
    }

    const inserted = await dbRun(
      db,
      `INSERT INTO clubs (
        slug, name, club_type, is_enabled, subscription_status,
        subscription_type, subscription_started_at, subscription_expires_at,
        trial_ends_at, subscription_ends_at,
        timezone, is_configured, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        slug,
        name,
        clubType,
        subscriptionWindow.subscription_status,
        subscriptionWindow.subscription_type,
        subscriptionWindow.subscription_started_at,
        subscriptionWindow.subscription_expires_at,
        subscriptionWindow.subscription_type === 'trial' ? subscriptionWindow.subscription_expires_at : null,
        subscriptionWindow.subscription_expires_at,
        timezone,
        timestamp,
        timestamp
      ]
    );
    insertedClubId = inserted.id;

    const created = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [inserted.id]);
    const ownerInvite = await createOwnerInvite(db, created.id, req.auth.adminId);
    if (txStarted) {
      await dbRun(db, 'COMMIT');
      txStarted = false;
    }
    return res.status(201).json({
      ...enrichClubRow(created),
      club_link: buildPublicUrl(`/club/${created.slug}`),
      owner_invite_link: ownerInvite ? ownerInvite.invite_link : null,
      local_link: buildPublicUrl(`/club/${created.slug}`)
    });
  } catch (error) {
    if (txStarted) {
      try {
        await dbRun(req.app.locals.db, 'ROLLBACK');
      } catch (_) {
      }
    } else if (insertedClubId && txFailedToStart) {
      // Fallback cleanup for non-transactional path to avoid leaving a partial club.
      try {
        await dbRun(req.app.locals.db, 'UPDATE clubs SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), insertedClubId]);
      } catch (_) {
      }
    }
    return next(error);
  }
});

router.get('/clubs/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const club = await dbGet(
      db,
      `SELECT * FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [Number(req.params.id)]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const config = await getClubConfig(db, club.id);
    const ownerInviteLink = await getOrCreateOwnerInviteLink(db, club.id, req.auth.adminId);

    return res.json({
      ...enrichClubRow(club),
      local_link: buildPublicUrl(`/club/${club.slug}`),
      owner_invite_link: ownerInviteLink,
      config
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/clubs/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const payload = req.body || {};

    const existing = await dbGet(db, 'SELECT * FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
    if (!existing) return res.status(404).json({ error: 'Club not found' });

    const nextName = payload.name !== undefined ? String(payload.name || '').trim() : existing.name;
    const nextSlug = payload.slug !== undefined ? toSlug(payload.slug) : existing.slug;
    const nextType = payload.club_type !== undefined ? (String(payload.club_type || '').trim() || null) : existing.club_type;
    const nextEnabled = payload.is_enabled !== undefined ? (payload.is_enabled ? 1 : 0) : existing.is_enabled;
    const nextTimezone = payload.timezone !== undefined ? String(payload.timezone || '').trim() : existing.timezone;
    const nextStatus = payload.subscription_status !== undefined
      ? String(payload.subscription_status).trim()
      : existing.subscription_status;

    if (!nextName || !nextSlug) {
      return res.status(400).json({ error: 'name and slug cannot be empty' });
    }

    if (!['trial', 'active', 'expired', 'blocked'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid subscription_status' });
    }

    const duplicateSlug = await dbGet(
      db,
      'SELECT id FROM clubs WHERE slug = ? AND id <> ? AND deleted_at IS NULL LIMIT 1',
      [nextSlug, id]
    );
    if (duplicateSlug) {
      return res.status(409).json({ error: 'Club slug already exists' });
    }

    await dbRun(
      db,
      `UPDATE clubs
       SET name = ?, slug = ?, club_type = ?, is_enabled = ?, timezone = ?, subscription_status = ?,
           trial_ends_at = ?, subscription_ends_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        nextName,
        nextSlug,
        nextType,
        nextEnabled,
        nextTimezone,
        nextStatus,
        payload.trial_ends_at !== undefined ? payload.trial_ends_at : existing.trial_ends_at,
        payload.subscription_ends_at !== undefined ? payload.subscription_ends_at : existing.subscription_ends_at,
        nowIso(),
        id
      ]
    );

    const updated = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [id]);
    return res.json({
      ...enrichClubRow(updated),
      local_link: buildPublicUrl(`/club/${updated.slug}`)
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/enable', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const existing = await dbGet(db, 'SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
    if (!existing) return res.status(404).json({ error: 'Club not found' });

    await dbRun(db, 'UPDATE clubs SET is_enabled = 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
    return res.json({ success: true, is_enabled: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/disable', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const existing = await dbGet(db, 'SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
    if (!existing) return res.status(404).json({ error: 'Club not found' });

    await dbRun(db, 'UPDATE clubs SET is_enabled = 0, updated_at = ? WHERE id = ?', [nowIso(), id]);
    return res.json({ success: true, is_enabled: false });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/subscription', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);

    const existing = await dbGet(db, 'SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
    if (!existing) return res.status(404).json({ error: 'Club not found' });

    const manualStatus = String(req.body?.subscription_status || '').trim().toLowerCase();
    if (manualStatus && !['expired'].includes(manualStatus)) {
      return res.status(400).json({ error: 'Invalid subscription_status' });
    }

    if (manualStatus === 'expired') {
      await dbRun(
        db,
        `UPDATE clubs
         SET subscription_status = 'expired', updated_at = ?
         WHERE id = ?`,
        [nowIso(), id]
      );

      const updatedExpired = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [id]);
      return res.json(enrichClubRow(updatedExpired));
    }

    const club = await dbGet(db, 'SELECT * FROM clubs WHERE id = ? LIMIT 1', [id]);
    const renewed = buildRenewedSubscription(club, req.body || {}, nowIso());

    await dbRun(
      db,
      `UPDATE clubs
       SET subscription_status = ?,
           subscription_type = ?,
           subscription_started_at = ?,
           subscription_expires_at = ?,
           trial_ends_at = ?,
           subscription_ends_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        renewed.subscription_status,
        renewed.subscription_type,
        renewed.subscription_started_at,
        renewed.subscription_expires_at,
        renewed.subscription_type === 'trial' ? renewed.subscription_expires_at : null,
        renewed.subscription_expires_at,
        nowIso(),
        id
      ]
    );

    const updated = await dbGet(db, 'SELECT * FROM clubs WHERE id = ?', [id]);
    return res.json(enrichClubRow(updated));
  } catch (error) {
    return next(error);
  }
});

router.delete('/clubs/:id', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);

    const club = await dbGet(
      db,
      'SELECT id, slug, name, deleted_at FROM clubs WHERE id = ? LIMIT 1',
      [id]
    );

    if (!club || club.deleted_at) {
      return res.status(404).json({ error: 'Club not found' });
    }

    if (club.slug === 'default-club') {
      return res.status(400).json({ error: 'Default club cannot be deleted' });
    }

    const timestamp = nowIso();
    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      // Delete dependent rows first to satisfy foreign keys.
      await dbRun(db, 'DELETE FROM ps_sessions WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM bookings_ps WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM bookings_pc WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM guest_ratings WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM club_config_versions WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM club_tariffs WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM club_devices WHERE club_id = ?', [id]);

      // Delete audit and token rows before admins because they reference admin_id.
      await dbRun(db, 'DELETE FROM audit_logs WHERE club_id = ?', [id]);
      await dbRun(db, 'DELETE FROM token_blacklist WHERE club_id = ?', [id]);
        await dbRun(db, 'DELETE FROM invite_tokens WHERE club_id = ?', [id]);
        await dbRun(db, 'DELETE FROM admin_active_sessions WHERE club_id = ?', [id]);

      // Delete all club users (owner + admins) permanently.
      await dbRun(db, 'DELETE FROM admins WHERE club_id = ?', [id]);

      // Finally remove the club itself.
      await dbRun(
        db,
        'DELETE FROM clubs WHERE id = ?',
        [id]
      );

      await dbRun(db, 'COMMIT');
    } catch (error) {
      await dbRun(db, 'ROLLBACK');
      throw error;
    }

    return res.json({ success: true, hard_deleted: true, deleted_at: timestamp, club_id: id });
  } catch (error) {
    return next(error);
  }
});

router.get('/clubs/:id/link', async (req, res, next) => {
  try {
    const club = await dbGet(
      req.app.locals.db,
      'SELECT id, slug, is_configured FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [Number(req.params.id)]
    );

    if (!club) return res.status(404).json({ error: 'Club not found' });

    return res.json({
      club_id: club.id,
      slug: club.slug,
      is_configured: Boolean(club.is_configured),
      local_link: buildPublicUrl(`/club/${club.slug}`)
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/clubs/:id/config', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const id = Number(req.params.id);
    const club = await dbGet(db, 'SELECT id, slug, name, is_configured FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
    if (!club) return res.status(404).json({ error: 'Club not found' });

    const config = await getClubConfig(db, id);
    return res.json({ club, config });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/config/apply', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = Number(req.params.id);
    const club = await dbGet(db, 'SELECT id FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1', [clubId]);
    if (!club) return res.status(404).json({ error: 'Club not found' });

    const payload = req.body || {};

    const normalizeMode = (value) => String(value || 'SET_COUNT').trim().toUpperCase();
    const pcMode = normalizeMode(payload.pc_mode);
    const psMode = normalizeMode(payload.ps_mode);

    if (!['SET_COUNT', 'SKIP'].includes(pcMode) || !['SET_COUNT', 'SKIP'].includes(psMode)) {
      return res.status(400).json({ error: 'pc_mode and ps_mode must be SET_COUNT or SKIP' });
    }

    const pcCount = payload.pc_count === null || payload.pc_count === undefined ? null : Number(payload.pc_count);
    const psCount = payload.ps_count === null || payload.ps_count === undefined ? null : Number(payload.ps_count);

    if (pcMode === 'SET_COUNT' && (!Number.isFinite(pcCount) || pcCount <= 0)) {
      return res.status(400).json({ error: 'Количество ПК / PS должно быть больше 0 или выберите "Не указывать количество"' });
    }

    if (psMode === 'SET_COUNT' && (!Number.isFinite(psCount) || psCount <= 0)) {
      return res.status(400).json({ error: 'Количество ПК / PS должно быть больше 0 или выберите "Не указывать количество"' });
    }

    const pcNames = Array.isArray(payload.pc_names) ? payload.pc_names : [];
    const psNames = Array.isArray(payload.ps_names) ? payload.ps_names : [];
    const psAssignments = Array.isArray(payload.ps_assignments) ? payload.ps_assignments : [];
    const tariffsPs = normalizeTariffs(payload.tariffs?.ps || [], 'PS');

    const timestamp = nowIso();

    let ownerInvite = null;
    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      const normalizeGroupName = (value) => {
        const normalized = String(value || '').trim();
        return normalized || null;
      };

      const buildDesiredDevices = (deviceType, count, names, assignments) => {
        const desired = [];
        for (let index = 1; index <= count; index += 1) {
          const code = `${deviceType}-${String(index).padStart(2, '0')}`;
          const displayName = makeDeviceName(deviceType, index, names[index - 1]);
          desired.push({
            device_type: deviceType,
            device_code: code,
            display_name: displayName,
            sort_order: index,
            tariff_group: deviceType === 'PS' ? normalizeGroupName(assignments[index - 1]) : null
          });
        }
        return desired;
      };

      const syncDevices = async (deviceType, desiredItems) => {
        const existing = await dbAll(
          db,
          `SELECT id, device_code, tariff_group
           FROM club_devices
           WHERE club_id = ? AND device_type = ?
           ORDER BY id ASC`,
          [clubId, deviceType]
        );

        const existingByCode = new Map(existing.map((row) => [String(row.device_code), row]));
        const desiredCodes = new Set();

        for (const item of desiredItems) {
          desiredCodes.add(item.device_code);
          const found = existingByCode.get(item.device_code);
          if (found) {
            if (deviceType === 'PS') {
              const nextTariffGroup = item.tariff_group ? item.tariff_group : found.tariff_group;
              await dbRun(
                db,
                `UPDATE club_devices
                 SET sort_order = ?, tariff_group = ?, is_active = 1, deleted_at = NULL, updated_at = ?
                 WHERE id = ?`,
                [item.sort_order, nextTariffGroup, timestamp, found.id]
              );
            } else {
              await dbRun(
                db,
                `UPDATE club_devices
                 SET display_name = ?, sort_order = ?, tariff_group = ?, is_active = 1, deleted_at = NULL, updated_at = ?
                 WHERE id = ?`,
                [item.display_name, item.sort_order, item.tariff_group, timestamp, found.id]
              );
            }
          } else {
            await dbRun(
              db,
              `INSERT INTO club_devices (
                club_id, device_type, device_code, display_name, sort_order, tariff_group, is_active, created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
              [clubId, item.device_type, item.device_code, item.display_name, item.sort_order, item.tariff_group, timestamp, timestamp]
            );
          }
        }

        for (const row of existing) {
          if (!desiredCodes.has(String(row.device_code))) {
            await dbRun(
              db,
              `UPDATE club_devices
               SET is_active = 0, updated_at = ?
               WHERE id = ?`,
              [timestamp, row.id]
            );
          }
        }
      };

      if (pcMode === 'SET_COUNT') {
        const desiredPcDevices = buildDesiredDevices('PC', pcCount, pcNames, []);
        await syncDevices('PC', desiredPcDevices);
      }

      if (psMode === 'SET_COUNT') {
        const desiredPsDevices = buildDesiredDevices('PS', psCount, psNames, psAssignments);
        await syncDevices('PS', desiredPsDevices);
      }

      const tariffKey = (item) => {
        const appliesValue = item.applies_to_value === null || item.applies_to_value === undefined
          ? ''
          : String(item.applies_to_value);
        return [
          String(item.device_type),
          String(item.tariff_name),
          String(item.billing_type),
          String(item.applies_to_type),
          appliesValue
        ].join('::');
      };

      const existingTariffs = await dbAll(
        db,
        `SELECT id, device_type, tariff_name, billing_type, applies_to_type, applies_to_value
         FROM club_tariffs
         WHERE club_id = ? AND device_type = 'PS'
         ORDER BY id ASC`,
        [clubId]
      );

      const existingByKey = new Map();
      for (const row of existingTariffs) {
        const key = tariffKey(row);
        if (!existingByKey.has(key)) {
          existingByKey.set(key, []);
        }
        existingByKey.get(key).push(row);
      }

      await dbRun(
        db,
        `UPDATE club_tariffs
         SET is_active = 0, updated_at = ?
         WHERE club_id = ? AND device_type = 'PC'`,
        [timestamp, clubId]
      );

      if (psMode === 'SET_COUNT') {
        await dbRun(
          db,
          `UPDATE club_tariffs
           SET is_active = 0, updated_at = ?
           WHERE club_id = ? AND device_type = 'PS'`,
          [timestamp, clubId]
        );

        for (const tariff of tariffsPs) {
          const key = tariffKey(tariff);
          const bucket = existingByKey.get(key);
          const reuse = bucket && bucket.length > 0 ? bucket.shift() : null;

          if (reuse) {
            await dbRun(
              db,
              `UPDATE club_tariffs
               SET price = ?, duration_minutes = ?, is_active = 1, deleted_at = NULL, updated_at = ?
               WHERE id = ?`,
              [tariff.price, tariff.duration_minutes, timestamp, reuse.id]
            );
          } else {
            await dbRun(
              db,
              `INSERT INTO club_tariffs (
                club_id, device_type, tariff_name, billing_type, price, duration_minutes,
                applies_to_type, applies_to_value,
                is_active, created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)` ,
              [
                clubId,
                tariff.device_type,
                tariff.tariff_name,
                tariff.billing_type,
                tariff.price,
                tariff.duration_minutes,
                tariff.applies_to_type,
                tariff.applies_to_value,
                timestamp,
                timestamp
              ]
            );
          }
        }
      }

      const versionRow = await dbGet(
        db,
        'SELECT COALESCE(MAX(version), 0) AS max_version FROM club_config_versions WHERE club_id = ?',
        [clubId]
      );
      const nextVersion = Number(versionRow?.max_version || 0) + 1;

      await dbRun(
        db,
        `INSERT INTO club_config_versions (club_id, version, config_json, created_by_admin_id, created_at, is_applied)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [clubId, nextVersion, JSON.stringify(payload), req.auth.adminId, timestamp]
      );

      await dbRun(
        db,
        `UPDATE clubs
         SET is_configured = 1, updated_at = ?
         WHERE id = ?`,
        [timestamp, clubId]
      );

      ownerInvite = await rotateOwnerInvite(db, clubId, req.auth.adminId);

      await dbRun(db, 'COMMIT');
    } catch (error) {
      await dbRun(db, 'ROLLBACK');
      throw error;
    }

    const config = await getClubConfig(db, clubId);
    return res.json({
      success: true,
      club_id: clubId,
      local_link: buildPublicUrl(`/club/${(await dbGet(db, 'SELECT slug FROM clubs WHERE id = ?', [clubId])).slug}`),
      owner_invite_link: ownerInvite ? ownerInvite.invite_link : null,
      config
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/owner-invite/regenerate', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = Number(req.params.id);
    const club = await dbGet(
      db,
      'SELECT id, slug FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [clubId]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const ownerInvite = await rotateOwnerInvite(db, clubId, req.auth.adminId);
    if (!ownerInvite) {
      return res.status(409).json({ error: 'Владелец уже активирован. Новая invite-ссылка не требуется.', code: 'OWNER_EXISTS' });
    }

    return res.json({
      success: true,
      club_id: clubId,
      club_slug: club.slug,
      club_link: buildPublicUrl(`/club/${club.slug}`),
      owner_invite_link: ownerInvite.invite_link
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/clubs/:id/config/versions', async (req, res, next) => {
  try {
    const rows = await dbAll(
      req.app.locals.db,
      `SELECT id, club_id, version, created_by_admin_id, created_at, is_applied
       FROM club_config_versions
       WHERE club_id = ?
       ORDER BY version DESC`,
      [Number(req.params.id)]
    );

    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/clubs/:id/admins', async (req, res, next) => {
  try {
    const rows = await dbAll(
      req.app.locals.db,
      `SELECT id, login, name, saas_role, club_id, is_club_owner, created_at, deleted_at
       FROM admins
       WHERE club_id = ? AND saas_role = ?
       ORDER BY is_club_owner DESC, id ASC`,
      [Number(req.params.id), CLUB_ADMIN_ROLE]
    );

    return res.json(rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/admins', async (req, res, next) => {
  return res.status(403).json({
    error: 'Создание админа в конструкторе отключено. Используйте invite-ссылку из панели владельца клуба.',
    code: 'ADMIN_INVITE_ONLY'
  });
});

router.put('/clubs/:id/admins/:adminId/password', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = Number(req.params.id);
    const adminId = Number(req.params.adminId);
    const password = String(req.body?.password || '').trim();

    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const admin = await dbGet(
      db,
      `SELECT id, deleted_at, is_club_owner
       FROM admins
       WHERE id = ? AND club_id = ? AND saas_role = ?
       LIMIT 1`,
      [adminId, clubId, CLUB_ADMIN_ROLE]
    );

    if (!admin || admin.deleted_at) {
      return res.status(404).json({ error: 'Club admin not found' });
    }
    if (admin.is_club_owner) {
      return res.status(400).json({ error: 'Club owner cannot be deleted here' });
    }

    const hash = await bcryptjs.hash(password, 10);
    await dbRun(db, 'UPDATE admins SET password_hash = ? WHERE id = ?', [hash, adminId]);

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.delete('/clubs/:id/admins/:adminId', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = Number(req.params.id);
    const adminId = Number(req.params.adminId);

    const admin = await dbGet(
      db,
      `SELECT id, deleted_at
       FROM admins
       WHERE id = ? AND club_id = ? AND saas_role = ?
       LIMIT 1`,
      [adminId, clubId, CLUB_ADMIN_ROLE]
    );

    if (!admin || admin.deleted_at) {
      return res.status(404).json({ error: 'Club admin not found' });
    }

    const deletedAt = nowIso();
    await dbRun(db, 'UPDATE admins SET deleted_at = ? WHERE id = ?', [deletedAt, adminId]);
    return res.json({ success: true, deleted_at: deletedAt });
  } catch (error) {
    return next(error);
  }
});

router.post('/clubs/:id/owner-access/reset', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = Number(req.params.id);
    
    // Verify club exists
    const club = await dbGet(
      db,
      'SELECT id, slug FROM clubs WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [clubId]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const timestamp = nowIso();
    
    // Start transaction to ensure all operations succeed or fail together
    await dbRun(db, 'BEGIN TRANSACTION');
    try {
      // 1. Soft-delete all active owners for this club.
      const activeOwners = await getActiveClubOwners(db, clubId);

      if (activeOwners.length) {
        await dbRun(
          db,
          `UPDATE admins
           SET deleted_at = ?,
               token_version = token_version + 1
           WHERE club_id = ?
             AND is_club_owner = 1
             AND deleted_at IS NULL`,
          [timestamp, clubId]
        );

        // 2. Blacklist any tracked sessions for those owners.
        for (const owner of activeOwners) {
          const oldSessions = await dbAll(
            db,
            `SELECT token_hash, expires_at FROM admin_active_sessions WHERE admin_id = ?`,
            [owner.id]
          );

          for (const session of oldSessions) {
            await dbRun(
              db,
              `INSERT OR IGNORE INTO token_blacklist (token_hash, admin_id, blacklisted_at, expires_at)
               VALUES (?, ?, ?, ?)`,
              [session.token_hash, owner.id, timestamp, session.expires_at]
            );
          }

          // 3. Delete active sessions for each revoked owner.
          await dbRun(
            db,
            `DELETE FROM admin_active_sessions WHERE admin_id = ?`,
            [owner.id]
          );
        }
      }

      // 4. Revoke all old owner invite tokens for this club
      await revokeActiveOwnerInvites(db, clubId);

      // 5. Create new owner invite token
      const newInvite = await createOwnerInvite(db, clubId, req.auth.adminId);
      
      if (!newInvite) {
        // This should not happen since we deleted the owner, but just in case
        await dbRun(db, 'ROLLBACK');
        return res.status(500).json({ error: 'Failed to create new owner invite' });
      }

      await dbRun(db, 'COMMIT');

      return res.json({
        success: true,
        message: 'Owner access has been reset successfully',
        club_id: clubId,
        club_slug: club.slug,
        owner_reset_at: timestamp,
        new_invite_link: newInvite.invite_link,
        club_link: buildPublicUrl(`/club/${club.slug}`)
      });

    } catch (txError) {
      await dbRun(db, 'ROLLBACK');
      throw txError;
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
