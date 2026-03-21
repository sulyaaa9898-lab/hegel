import crypto from 'node:crypto';

const DEFAULT_PORT = process.env.PORT || '3000';
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_BASE_URL = process.env.APP_BASE_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export const INVITE_OWNER_TTL_DAYS = Number(process.env.OWNER_INVITE_TTL_DAYS || 7);
export const INVITE_ADMIN_TTL_DAYS = Number(process.env.ADMIN_INVITE_TTL_DAYS || 7);
export const ADMIN_SESSION_IDLE_MINUTES = Number(process.env.ADMIN_SESSION_IDLE_MINUTES || 90);

function normalizeBaseUrl(input) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch (_) {
    return DEFAULT_BASE_URL;
  }
}

export function buildPublicUrl(pathname) {
  const base = normalizeBaseUrl(process.env.APP_BASE_URL);
  const normalizedPath = `/${String(pathname || '').trim().replace(/^\/+/, '')}`;
  return new URL(normalizedPath, `${base}/`).toString();
}

export function createInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function plusDaysIso(days) {
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 0;
  return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

export function getAdminIdleCutoffIso(now = Date.now()) {
  return new Date(now - ADMIN_SESSION_IDLE_MINUTES * 60 * 1000).toISOString();
}

export async function cleanupSecurityArtifacts(db, dbRun) {
  const nowIso = new Date().toISOString();
  const idleCutoffIso = getAdminIdleCutoffIso();

  await dbRun(db, 'DELETE FROM invite_tokens WHERE used_at IS NOT NULL OR expires_at <= ?', [nowIso]);
  await dbRun(db, 'DELETE FROM token_blacklist WHERE expires_at <= ?', [nowIso]);
  await dbRun(
    db,
    'DELETE FROM admin_active_sessions WHERE expires_at <= ? OR COALESCE(last_seen_at, created_at) <= ?',
    [nowIso, idleCutoffIso]
  );
}
