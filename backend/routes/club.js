import express from 'express';
import { dbAll, dbGet } from '../db.js';
import { requireAuth, requireClubOwner } from '../middleware/auth.js';
import { requireClubContext } from '../middleware/tenant.js';
import { computeSubscriptionState } from '../utils/subscription.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireClubContext);

router.get('/config', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = req.club.id;

    const club = await dbGet(
      db,
      `SELECT id, slug, name, club_type, is_configured, subscription_status,
              subscription_type, subscription_started_at, subscription_expires_at,
              trial_ends_at, subscription_ends_at
       FROM clubs
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [clubId]
    );

    if (!club) {
      return res.status(404).json({ error: 'Club not found' });
    }

    const psRows = await dbAll(
      db,
      `SELECT sort_order, device_code, display_name, tariff_group
       FROM club_devices
       WHERE club_id = ?
         AND device_type = 'PS'
         AND is_active = 1
         AND deleted_at IS NULL
       ORDER BY sort_order ASC`,
      [clubId]
    );

    const tariffRows = await dbAll(
      db,
      `SELECT tariff_name, billing_type, price, duration_minutes, applies_to_type, applies_to_value
       FROM club_tariffs
       WHERE club_id = ?
         AND device_type = 'PS'
         AND is_active = 1
         AND deleted_at IS NULL
       ORDER BY id ASC`,
      [clubId]
    );

    const groupMap = new Map();
    const allScope = {
      hourly_price: null,
      packages: []
    };
    const deviceMap = new Map();

    const normalizeGroupName = (value) => {
      const normalized = String(value || '').trim();
      return normalized || null;
    };

    const normalizeDeviceKey = (value) => {
      const normalized = String(value || '').trim().toUpperCase();
      return normalized || null;
    };

    const normalizePackage = (row) => {
      const durationMinutes = row.duration_minutes === null || row.duration_minutes === undefined
        ? null
        : Number(row.duration_minutes);
      const price = Number(row.price || 0);
      const packageName = String(row.tariff_name || '').trim();
      if (!packageName || price <= 0 || !durationMinutes || durationMinutes <= 0) {
        return null;
      }
      return {
        name: packageName,
        price,
        duration_minutes: durationMinutes
      };
    };

    const ensureDeviceEntry = (key) => {
      if (!deviceMap.has(key)) {
        deviceMap.set(key, {
          hourly_price: null,
          packages: []
        });
      }
      return deviceMap.get(key);
    };

    for (const ps of psRows) {
      const groupName = normalizeGroupName(ps.tariff_group);
      if (!groupName) continue;
      if (!groupMap.has(groupName)) {
        groupMap.set(groupName, {
          name: groupName,
          hourly_price: null,
          packages: []
        });
      }
    }

    for (const row of tariffRows) {
      const scopeType = String(row.applies_to_type || '').trim().toUpperCase();
      const billingType = String(row.billing_type || '').trim().toLowerCase();

      if (billingType !== 'hourly' && billingType !== 'package') {
        continue;
      }

      if (scopeType === 'ALL') {
        if (billingType === 'hourly') {
          allScope.hourly_price = Number(row.price || 0);
        } else {
          const pkg = normalizePackage(row);
          if (pkg) allScope.packages.push(pkg);
        }
        continue;
      }

      if (scopeType === 'GROUP') {
        const groupName = normalizeGroupName(row.applies_to_value);
        if (!groupName) continue;

        if (!groupMap.has(groupName)) {
          groupMap.set(groupName, {
            name: groupName,
            hourly_price: null,
            packages: []
          });
        }

        const group = groupMap.get(groupName);
        if (billingType === 'hourly') {
          group.hourly_price = Number(row.price || 0);
        } else {
          const pkg = normalizePackage(row);
          if (pkg) group.packages.push(pkg);
        }
        continue;
      }

      if (scopeType === 'DEVICE') {
        const deviceKey = normalizeDeviceKey(row.applies_to_value);
        if (!deviceKey) continue;
        const device = ensureDeviceEntry(deviceKey);
        if (billingType === 'hourly') {
          device.hourly_price = Number(row.price || 0);
        } else {
          const pkg = normalizePackage(row);
          if (pkg) device.packages.push(pkg);
        }
      }
    }

    const effectivePricingByPsId = new Map();
    for (const row of psRows) {
      const psId = Number(row.sort_order);
      const groupName = normalizeGroupName(row.tariff_group);
      const byGroup = groupName ? groupMap.get(groupName) : null;

      const deviceCodeKey = normalizeDeviceKey(row.device_code);
      const numericIdKey = normalizeDeviceKey(psId);
      const byDevice = (deviceCodeKey && deviceMap.get(deviceCodeKey)) || (numericIdKey && deviceMap.get(numericIdKey)) || null;

      let hourlyPrice = allScope.hourly_price;
      if (byGroup && byGroup.hourly_price !== null && byGroup.hourly_price !== undefined) {
        hourlyPrice = byGroup.hourly_price;
      }
      if (byDevice && byDevice.hourly_price !== null && byDevice.hourly_price !== undefined) {
        hourlyPrice = byDevice.hourly_price;
      }

      let packages = allScope.packages.slice();
      if (byGroup && Array.isArray(byGroup.packages) && byGroup.packages.length > 0) {
        packages = byGroup.packages.slice();
      }
      if (byDevice && Array.isArray(byDevice.packages) && byDevice.packages.length > 0) {
        packages = byDevice.packages.slice();
      }

      effectivePricingByPsId.set(psId, {
        hourly_price: hourlyPrice === null || hourlyPrice === undefined ? null : Number(hourlyPrice),
        packages
      });
    }

    const subscription = computeSubscriptionState(club);

    return res.json({
      club: {
        id: club.id,
        slug: club.slug,
        name: club.name,
        club_type: club.club_type || null,
        is_configured: Boolean(club.is_configured),
        subscription
      },
      ps_consoles: psRows.map((row) => ({
        id: Number(row.sort_order),
        code: row.device_code,
        display_name: row.display_name,
        tariff_group: normalizeGroupName(row.tariff_group),
        tariff: effectivePricingByPsId.get(Number(row.sort_order)) || { hourly_price: null, packages: [] }
      })),
      tariff_groups: Array.from(groupMap.values())
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/stats', requireClubOwner, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const clubId = req.club.id;

    const [
      totalBookingsRow,
      activeBookingsRow,
      arrivedRow,
      lateRow,
      cancelledRow,
      noShowRow,
      guestsRow,
      adminsRow,
      activePsSessionsRow,
      pcCapacityRow,
      psCapacityRow
    ] = await Promise.all([
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL', [clubId]),
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL AND status = ?', [clubId, 'pending']),
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL AND status = ?', [clubId, 'arrived']),
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL AND status = ?', [clubId, 'late']),
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL AND status = ?', [clubId, 'cancelled']),
      dbGet(db, 'SELECT COUNT(*) AS count FROM bookings_pc WHERE club_id = ? AND deleted_at IS NULL AND status = ?', [clubId, 'no-show']),
      dbGet(db, 'SELECT COUNT(*) AS count FROM guest_ratings WHERE club_id = ?', [clubId]),
      dbGet(db, 'SELECT COUNT(*) AS count FROM admins WHERE club_id = ? AND deleted_at IS NULL AND is_root = 0 AND is_club_owner = 0', [clubId]),
      dbGet(db, 'SELECT COUNT(*) AS count FROM ps_sessions WHERE club_id = ? AND ended_at IS NULL', [clubId]),
      dbGet(db, `SELECT COUNT(*) AS count FROM club_devices WHERE club_id = ? AND device_type = 'PC' AND is_active = 1 AND deleted_at IS NULL`, [clubId]),
      dbGet(db, `SELECT COUNT(*) AS count FROM club_devices WHERE club_id = ? AND device_type = 'PS' AND is_active = 1 AND deleted_at IS NULL`, [clubId])
    ]);

    return res.json({
      total_bookings: Number(totalBookingsRow?.count || 0),
      active_bookings: Number(activeBookingsRow?.count || 0),
      done_arrived: Number(arrivedRow?.count || 0),
      done_late: Number(lateRow?.count || 0),
      done_cancelled: Number(cancelledRow?.count || 0),
      done_no_show: Number(noShowRow?.count || 0),
      guests_total: Number(guestsRow?.count || 0),
      admins_total: Number(adminsRow?.count || 0),
      active_ps_sessions: Number(activePsSessionsRow?.count || 0),
      pc_capacity: Number(pcCapacityRow?.count || 0),
      ps_capacity: Number(psCapacityRow?.count || 0)
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
