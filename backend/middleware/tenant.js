import { dbGet } from '../db.js';
import { nowIso } from '../utils/time.js';
import { computeSubscriptionState } from '../utils/subscription.js';

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

async function resolveClubById(db, clubId) {
  return dbGet(
    db,
    `SELECT id, slug, name, is_enabled, subscription_status,
            subscription_type, subscription_started_at, subscription_expires_at,
            subscription_ends_at, trial_ends_at, is_configured
     FROM clubs
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [clubId]
  );
}

export async function requireClubContext(req, res, next) {
  try {
    const db = req.app.locals.db;

    let clubId = null;
    if (req.auth.role === SUPER_ADMIN_ROLE) {
      const input = req.headers['x-club-id'] || req.query.club_id || req.body?.club_id;
      if (!input) {
        return res.status(400).json({ error: 'SUPER_ADMIN requests must include club context (x-club-id or club_id)' });
      }
      clubId = Number(input);
    } else {
      clubId = Number(req.auth.clubId || 0);
    }

    if (!clubId) {
      return res.status(403).json({ error: 'Club context is missing in token' });
    }

    const club = await resolveClubById(db, clubId);
    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    if (!club.is_enabled) {
      return res.status(403).json({ error: 'Club is disabled' });
    }

    if (club.subscription_status === 'blocked') {
      return res.status(403).json({ error: 'Club subscription is blocked' });
    }

    const subscription = computeSubscriptionState(club);
    res.setHeader('x-club-subscription-status', subscription.subscription_status);

    if (subscription.subscription_status === 'expired' && req.method !== 'GET') {
      return res.status(403).json({
        error: 'Подписка истекла. Продлите подписку.',
        code: 'SUBSCRIPTION_EXPIRED',
        subscription
      });
    }

    req.club = {
      id: club.id,
      slug: club.slug,
      name: club.name,
      isConfigured: Boolean(club.is_configured),
      subscription,
      checkedAt: nowIso()
    };

    return next();
  } catch (error) {
    return next(error);
  }
}
