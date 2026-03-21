import { nowIso } from './time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function addDaysIso(baseIso, days) {
  const base = new Date(baseIso || nowIso());
  const safeDays = Math.max(0, Number(days || 0));
  base.setUTCDate(base.getUTCDate() + safeDays);
  return base.toISOString();
}

function addMonthsIso(baseIso, months) {
  const base = new Date(baseIso || nowIso());
  const safeMonths = Math.max(0, Number(months || 0));
  base.setUTCMonth(base.getUTCMonth() + safeMonths);
  return base.toISOString();
}

function computeDaysLeft(expiresAtIso, referenceIso) {
  if (!expiresAtIso) return 0;
  const end = new Date(expiresAtIso).getTime();
  const now = new Date(referenceIso || nowIso()).getTime();
  if (Number.isNaN(end) || Number.isNaN(now)) return 0;
  const diffMs = end - now;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / DAY_MS);
}

export function buildSubscriptionWindow(payload, referenceIso) {
  const now = toIsoOrNull(referenceIso) || nowIso();
  const subscriptionType = String(payload?.subscription_type || 'trial').trim().toLowerCase();
  const startedAt = now;

  if (subscriptionType === 'monthly') {
    return {
      subscription_type: 'monthly',
      subscription_started_at: startedAt,
      subscription_expires_at: addMonthsIso(startedAt, 1),
      subscription_status: 'active'
    };
  }

  const trialDays = Math.max(1, Number(payload?.trial_days || 7));
  return {
    subscription_type: 'trial',
    subscription_started_at: startedAt,
    subscription_expires_at: addDaysIso(startedAt, trialDays),
    subscription_status: 'active'
  };
}

export function computeSubscriptionState(clubRow, referenceIso) {
  const now = toIsoOrNull(referenceIso) || nowIso();
  const type = String(clubRow?.subscription_type || (clubRow?.subscription_status === 'trial' ? 'trial' : 'monthly') || 'trial').trim().toLowerCase();
  const startedAt = toIsoOrNull(clubRow?.subscription_started_at) || toIsoOrNull(clubRow?.created_at) || now;
  const expiresAt = toIsoOrNull(clubRow?.subscription_expires_at)
    || toIsoOrNull(clubRow?.subscription_ends_at)
    || toIsoOrNull(clubRow?.trial_ends_at)
    || (type === 'monthly' ? addMonthsIso(startedAt, 1) : addDaysIso(startedAt, 7));

  const manualStatus = String(clubRow?.subscription_status || '').trim().toLowerCase();
  if (manualStatus === 'blocked') {
    return {
      subscription_type: type,
      subscription_started_at: startedAt,
      subscription_expires_at: expiresAt,
      subscription_status: 'blocked',
      subscription_days_left: 0,
      subscription_is_expired: true,
      subscription_notice: 'Подписка истекла. Продлите подписку.'
    };
  }

  if (manualStatus === 'expired') {
    return {
      subscription_type: type,
      subscription_started_at: startedAt,
      subscription_expires_at: expiresAt,
      subscription_status: 'expired',
      subscription_days_left: 0,
      subscription_is_expired: true,
      subscription_notice: 'Подписка истекла. Продлите подписку.'
    };
  }

  const daysLeft = computeDaysLeft(expiresAt, now);
  const isExpired = daysLeft <= 0;
  const isExpiring = !isExpired && daysLeft <= 2;
  const status = isExpired ? 'expired' : (isExpiring ? 'expiring' : 'active');

  let notice = null;
  if (isExpired) {
    notice = 'Подписка истекла. Продлите подписку.';
  } else if (isExpiring) {
    notice = `До окончания подписки осталось ${daysLeft} дн. Продлите подписку.`;
  }

  return {
    subscription_type: type,
    subscription_started_at: startedAt,
    subscription_expires_at: expiresAt,
    subscription_status: status,
    subscription_days_left: daysLeft,
    subscription_is_expired: isExpired,
    subscription_notice: notice
  };
}

export function buildRenewedSubscription(currentClub, payload, referenceIso) {
  const now = toIsoOrNull(referenceIso) || nowIso();
  const mode = String(payload?.subscription_type || currentClub?.subscription_type || 'monthly').trim().toLowerCase();

  if (mode === 'trial') {
    const trialDays = Math.max(1, Number(payload?.trial_days || 7));
    return {
      subscription_type: 'trial',
      subscription_started_at: now,
      subscription_expires_at: addDaysIso(now, trialDays),
      subscription_status: 'active'
    };
  }

  const months = Math.max(1, Number(payload?.months || 1));
  return {
    subscription_type: 'monthly',
    subscription_started_at: now,
    subscription_expires_at: addMonthsIso(now, months),
    subscription_status: 'active'
  };
}
