function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\s+/g, '');
  if (!raw) {
    throw new Error('APP_BASE_URL is not set');
  }

  try {
    return new URL(raw).origin;
  } catch (_) {
    throw new Error('APP_BASE_URL is not a valid absolute URL');
  }
}

export const BASE_URL = normalizeBaseUrl(process.env.APP_BASE_URL);