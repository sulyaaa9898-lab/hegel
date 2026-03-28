﻿const config = window.AppConfig;
const state = window.AppState;
const storage = window.AppStorage;
const authModule = window.AuthModule;
const pcBookingsModule = window.PCBookingsModule;
const psModule = window.PSModule;
const uiModule = window.UIModule;
const API_BASE = '/api';
const SESSION_TOKEN_KEY = 'cyber_auth_token';
const SESSION_ADMIN_KEY = 'cyber_current_admin';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';
const CLUB_OWNER_ROLE = 'CLUB_OWNER';
const INVITE_MODE_ADMIN = 'ADMIN';
const INVITE_MODE_OWNER = 'OWNER';
let authToken = '';
let pendingForceAdminLogin = null;
let realtimeSyncIntervalId = null;
let realtimeSyncInFlight = false;
const REALTIME_SYNC_MS = 10000;

// System for monitoring notifications
let dashboardNotifications = [];
const BOOKING_NOTIFICATION_CHECK_MS = 5000;
let bookingNotificationIntervalId = null;
const MAX_DASHBOARD_NOTIFICATIONS = 10;
const NOTIFICATION_TIMESTAMPS_KEY = 'cyber_notification_timestamps_v1';
const LATE_SUMMARY_TIMESTAMP_KEY = 'booking-late-summary';
const OWNER_STATS_UI_STATE_KEY = 'owner_stats_ui_state_v1';

function getDefaultOwnerStatsUiState() {
  return {
    pcRange: 'month',
    topClientsExpanded: false,
    worstClientsExpanded: false
  };
}

function loadOwnerStatsUiState() {
  try {
    const raw = sessionStorage.getItem(OWNER_STATS_UI_STATE_KEY);
    if (!raw) return getDefaultOwnerStatsUiState();
    const parsed = JSON.parse(raw);
    return {
      ...getDefaultOwnerStatsUiState(),
      ...(parsed && typeof parsed === 'object' ? parsed : {})
    };
  } catch (_) {
    return getDefaultOwnerStatsUiState();
  }
}

let ownerStatsUiState = loadOwnerStatsUiState();

function saveOwnerStatsUiState() {
  try {
    sessionStorage.setItem(OWNER_STATS_UI_STATE_KEY, JSON.stringify(ownerStatsUiState));
  } catch (_) {
  }
}

const notificationTypes = {
  BOOKING_LATE: 'booking-late',
  PS_TIME_EXPIRED: 'ps-time-expired',
  PS_SESSION_ENDING_SOON: 'ps-session-ending-soon'
};

const inviteContext = {
token: '',
mode: null,
resolved: null
};
const clubContext = {
id: null,
slug: null,
name: null,
pcCapacity: config.maxPCs,
psCapacity: 0,
pcEnabled: true,
psEnabled: true,
subscription: null
};
const psRuntimeConfig = {
groupsByName: new Map(),
consoleToGroup: new Map(),
consolePricingById: new Map()
};

function resetPsRuntimeConfig() {
psRuntimeConfig.groupsByName = new Map();
psRuntimeConfig.consoleToGroup = new Map();
psRuntimeConfig.consolePricingById = new Map();
}

function applyPsRuntimeConfig(payload) {
resetPsRuntimeConfig();
if (!payload || typeof payload !== 'object') return;

const normalizeGroupName = (value) => {
const normalized = String(value || '').trim();
return normalized || null;
};

const groups = Array.isArray(payload.tariff_groups) ? payload.tariff_groups : [];
groups.forEach((group) => {
const groupName = normalizeGroupName(group && group.name);
if (!groupName) return;
psRuntimeConfig.groupsByName.set(groupName, {
name: groupName,
hourly_price: group.hourly_price === null || group.hourly_price === undefined ? null : Number(group.hourly_price),
packages: Array.isArray(group.packages)
? group.packages.map((item) => ({
name: String(item.name || '').trim(),
price: Number(item.price || 0),
duration_minutes: item.duration_minutes === null || item.duration_minutes === undefined ? null : Number(item.duration_minutes)
})).filter((item) => item.name && item.price > 0 && item.duration_minutes > 0)
: []
});
});

const consoles = Array.isArray(payload.ps_consoles) ? payload.ps_consoles : [];
consoles.forEach((item) => {
const id = Number(item.id);
if (!Number.isInteger(id) || id <= 0) return;
const groupName = normalizeGroupName(item.tariff_group);
psRuntimeConfig.consoleToGroup.set(id, groupName);

const rawTariff = item && item.tariff && typeof item.tariff === 'object' ? item.tariff : null;
const hourlyPrice = rawTariff && rawTariff.hourly_price !== null && rawTariff.hourly_price !== undefined
? Number(rawTariff.hourly_price)
: null;
const packages = rawTariff && Array.isArray(rawTariff.packages)
? rawTariff.packages.map((pkg) => ({
name: String(pkg.name || '').trim(),
price: Number(pkg.price || 0),
duration_minutes: pkg.duration_minutes === null || pkg.duration_minutes === undefined ? null : Number(pkg.duration_minutes)
})).filter((pkg) => pkg.name && pkg.price > 0 && pkg.duration_minutes > 0)
: [];

psRuntimeConfig.consolePricingById.set(id, {
hourly_price: Number.isFinite(hourlyPrice) && hourlyPrice > 0 ? hourlyPrice : null,
packages
});
});

if (consoles.length > 0) {
clubContext.psCapacity = consoles.length;
}
}

function getClubSlugFromPath() {
const parts = window.location.pathname.split('/').filter(Boolean);
if (parts.length >= 2 && parts[0] === 'club') {
return decodeURIComponent(parts.slice(1).join('/'));
}
return null;
}

function getInviteTokenFromQuery() {
try {
const params = new URLSearchParams(window.location.search || '');
return String(params.get('token') || '').trim();
} catch (_) {
return '';
}
}

function getInviteModeFromPath() {
const path = String(window.location.pathname || '').toLowerCase();
if (path === '/activate-owner') return INVITE_MODE_OWNER;
if (path === '/register') return INVITE_MODE_ADMIN;
return null;
}

function isInviteFlow() {
return Boolean(inviteContext.mode && inviteContext.token);
}

function getCurrentPcCapacity() {
return Number(clubContext.pcCapacity || config.maxPCs || 0);
}

function getCurrentPsCapacity() {
return Number(clubContext.psCapacity || 0);
}

function ensurePreferredPlatform() {
if (!clubContext.pcEnabled && clubContext.psEnabled) {
switchPlatform('ps');
return;
}

if (!clubContext.psEnabled && clubContext.pcEnabled) {
switchPlatform('pc');
return;
}
}

function applyPlatformVisibility() {
const pcBtn = document.getElementById('platformPcBtn');
const psBtn = document.getElementById('platformPsBtn');
const platformSelector = document.querySelector('.platform-selector');
const pcControls = document.querySelector('.controls-row[data-platform="pc"]');
const navPC = document.getElementById('navPC');
const navPS = document.getElementById('navPS');

if (pcBtn) pcBtn.style.display = clubContext.pcEnabled ? 'inline-flex' : 'none';
if (psBtn) psBtn.style.display = clubContext.psEnabled ? 'inline-flex' : 'none';
if (navPC) navPC.style.display = clubContext.pcEnabled ? 'flex' : 'none';
if (navPS) navPS.style.display = clubContext.psEnabled ? 'flex' : 'none';
if (platformSelector) platformSelector.style.display = (clubContext.pcEnabled || clubContext.psEnabled) ? 'block' : 'none';
if (pcControls) pcControls.style.display = clubContext.pcEnabled && currentPlatform === 'pc' ? 'flex' : 'none';

if (!clubContext.pcEnabled) {
document.getElementById('addPanel').style.display = 'none';
document.getElementById('searchPanel').style.display = 'none';
document.getElementById('mainContent').style.display = 'none';
document.getElementById('donePage').style.display = 'none';
document.getElementById('guestsPage').style.display = 'none';
}

if (!clubContext.psEnabled) {
document.getElementById('psConsolesPage').style.display = 'none';
}
const dashActivePsCard = document.getElementById('dashActivePsCard');
if (dashActivePsCard) dashActivePsCard.style.display = clubContext.psCapacity > 0 ? '' : 'none';

if (currentPlatform === 'pc' && !clubContext.pcEnabled && clubContext.psEnabled) {
switchPlatform('ps');
return;
}

if (currentPlatform === 'ps' && !clubContext.psEnabled && clubContext.pcEnabled) {
switchPlatform('pc');
return;
}
}

function applyClubBranding() {
if (!clubContext.name) return;
const logo = document.querySelector('.logo');
if (logo) logo.textContent = clubContext.name;
document.title = `${clubContext.name} | Киберклуб`;
}

function resolveSubscriptionState(raw) {
const status = String(raw?.subscription_status || 'active').trim().toLowerCase();
const daysLeft = Math.max(0, Number(raw?.subscription_days_left || 0));
const notice = status === 'expired'
? 'Подписка истекла. Продлите подписку.'
: (status === 'expiring' ? `До окончания подписки осталось ${daysLeft} дней. Продлите подписку.` : '');

return {
subscription_type: String(raw?.subscription_type || 'monthly').trim().toLowerCase(),
subscription_status: status,
subscription_days_left: daysLeft,
subscription_notice: raw?.subscription_notice || notice,
subscription_expires_at: raw?.subscription_expires_at || null,
subscription_started_at: raw?.subscription_started_at || null,
subscription_is_expired: status === 'expired' || Boolean(raw?.subscription_is_expired)
};
}

function isSubscriptionExpired() {
return Boolean(clubContext.subscription && clubContext.subscription.subscription_is_expired);
}

function getAuthInlineErrorEl() {
return document.getElementById('authInlineError');
}

function clearAuthInlineError() {
const errorEl = getAuthInlineErrorEl();
if (!errorEl) return;
errorEl.textContent = '';
errorEl.style.display = 'none';
}

function showAuthInlineError(message) {
const errorEl = getAuthInlineErrorEl();
if (!errorEl) return;
errorEl.textContent = String(message || 'Произошла ошибка. Попробуйте снова.');
errorEl.style.display = 'block';
}

function enforceSubscriptionLock() {
const modalEl = document.getElementById('subscriptionBlockModal');
if (!modalEl) return;

const sub = clubContext.subscription;
const hasAuthContext = Boolean(currentAdmin || getAuthToken());
const mustLock = Boolean(sub && sub.subscription_status === 'expired' && hasAuthContext);
modalEl.style.display = mustLock ? 'flex' : 'none';
}

function renderSubscriptionState() {
const noticeEl = document.getElementById('subscriptionNotice');
const modalEl = document.getElementById('subscriptionBlockModal');
if (!noticeEl || !modalEl) return;

const sub = clubContext.subscription;
if (!sub || !currentAdmin) {
noticeEl.style.display = 'none';
modalEl.style.display = 'none';
return;
}

if (sub.subscription_status === 'expiring' || sub.subscription_status === 'expired') {
noticeEl.textContent = sub.subscription_notice || 'Подписка истекла. Продлите подписку.';
noticeEl.classList.remove('expiring', 'expired');
noticeEl.classList.add(sub.subscription_status === 'expired' ? 'expired' : 'expiring');
noticeEl.style.display = 'block';
} else {
noticeEl.style.display = 'none';
}

if (sub.subscription_status === 'expired') {
modalEl.style.display = 'flex';
} else {
modalEl.style.display = 'none';
}

enforceSubscriptionLock();
}

async function loadClubContext() {
const slug = getClubSlugFromPath();
if (!slug) return;

clubContext.slug = slug;
try {
const meta = await apiRequest(`/public/club-by-slug/${encodeURIComponent(slug)}`);
clubContext.id = Number(meta.id || 0) || null;
if (!clubContext.id) throw new Error('CLUB_ID_NOT_RESOLVED');
clubContext.name = meta.name || null;
const applyOptions = meta && meta.apply_options ? meta.apply_options : null;
const pcMode = String(applyOptions && applyOptions.pc_mode ? applyOptions.pc_mode : 'SET_COUNT').trim().toUpperCase();
const psMode = String(applyOptions && applyOptions.ps_mode ? applyOptions.ps_mode : 'SET_COUNT').trim().toUpperCase();
clubContext.pcEnabled = pcMode !== 'SKIP';
clubContext.psEnabled = psMode !== 'SKIP';
clubContext.pcCapacity = clubContext.pcEnabled ? Number(meta.pc_count || config.maxPCs) : 0;
clubContext.psCapacity = clubContext.psEnabled ? Number(meta.ps_count || 0) : 0;
clubContext.subscription = resolveSubscriptionState(meta || {});
applyClubBranding();
applyPlatformVisibility();
ensurePreferredPlatform();
renderSubscriptionState();
updateCounter();
} catch (error) {
clubContext.id = null;
clubContext.psCapacity = 0;
throw error;
}
}

function loadSessionToken() {
try {
return sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
} catch (_) {
return '';
}
}

function loadSessionAdmin() {
try {
const raw = sessionStorage.getItem(SESSION_ADMIN_KEY);
if (!raw) return null;
const parsed = JSON.parse(raw);
if (!parsed || typeof parsed !== 'object' || !parsed.login) return null;
return parsed;
} catch (_) {
return null;
}
}

function saveSessionAdmin(admin) {
try {
if (admin) {
sessionStorage.setItem(SESSION_ADMIN_KEY, JSON.stringify(admin));
} else {
sessionStorage.removeItem(SESSION_ADMIN_KEY);
}
} catch (error) {
reportClientError('Не удалось сохранить сессию администратора', error, { silent: true });
}
}

function getAuthToken() {
return authToken;
}

function isClubOwner() {
return !!(currentAdmin && currentAdmin.role === CLUB_OWNER_ROLE);
}

function canManageClub() {
return !!(currentAdmin && (currentAdmin.role === CLUB_OWNER_ROLE || currentAdmin.isRoot));
}

function canViewHistoryAndStats() {
return !!(currentAdmin && (currentAdmin.role === CLUB_OWNER_ROLE || currentAdmin.role === CLUB_ADMIN_ROLE || currentAdmin.isRoot));
}

function updateManagementNavVisibility() {
const canManage = canManageClub();
const ownerOnly = isClubOwner();
const canViewStatsAndHistory = canViewHistoryAndStats();
const adminBtn = document.getElementById('adminBtn');
const statsBtn = document.getElementById('statsBtn');
const logsBtn = document.getElementById('logsBtn');
const bookingHistoryBtn = document.getElementById('bookingHistoryBtn');
const customerHistoryBtn = document.getElementById('customerHistoryBtn');
const tasksBtn = document.getElementById('tasksBtn');

if (adminBtn) adminBtn.style.display = canManage ? 'flex' : 'none';
if (statsBtn) statsBtn.style.display = canViewStatsAndHistory ? 'flex' : 'none';
if (logsBtn) logsBtn.style.display = ownerOnly ? 'flex' : 'none';
if (bookingHistoryBtn) bookingHistoryBtn.style.display = canViewStatsAndHistory ? 'flex' : 'none';
if (customerHistoryBtn) customerHistoryBtn.style.display = canViewStatsAndHistory ? 'flex' : 'none';
if (tasksBtn) tasksBtn.style.display = canViewStatsAndHistory ? 'flex' : 'none';
}

function expandSidebar() {
const sidebar = document.querySelector('.sidebar');
const appLayout = document.getElementById('userPanel');
if (!sidebar) return;
sidebar.classList.add('sidebar-expanded');
if (appLayout) appLayout.classList.add('sidebar-pushed');
}

function collapseSidebar() {
const sidebar = document.querySelector('.sidebar');
const appLayout = document.getElementById('userPanel');
if (!sidebar) return;
sidebar.classList.remove('sidebar-expanded');
if (appLayout) appLayout.classList.remove('sidebar-pushed');
}

function syncSidebarDrawerForViewport() {
collapseSidebar();
}

function setupSidebarDrawer() {
const sidebar = document.querySelector('.sidebar');

if (sidebar) {
sidebar.addEventListener('click', function() {
if (!sidebar.classList.contains('sidebar-expanded')) {
expandSidebar();
}
});
}

document.addEventListener('click', function(e) {
if (sidebar && sidebar.classList.contains('sidebar-expanded') && !sidebar.contains(e.target)) {
collapseSidebar();
}
});
}

function setAuthToken(token) {
authToken = token || '';
try {
if (authToken) {
sessionStorage.setItem(SESSION_TOKEN_KEY, authToken);
} else {
sessionStorage.removeItem(SESSION_TOKEN_KEY);
}
} catch (error) {
reportClientError('Не удалось сохранить токен сессии', error, { silent: true });
}
}

function clearAuthToken() {
authToken = '';
try {
sessionStorage.removeItem(SESSION_TOKEN_KEY);
} catch (error) {
reportClientError('Не удалось очистить токен сессии', error, { silent: true });
}
}

function parseApiPayload(text) {
if (!text) return null;
try {
return JSON.parse(text);
} catch (_) {
return text;
}
}

function createApiError(response, data) {
let message = (data && typeof data === 'object' && data.error) ? data.error : `HTTP ${response.status}`;
if (response.status === 409 && data && data.code === 'LOGIN_EXISTS') {
message = `${data.error} Логин должен быть уникальным во всей системе.`;
}
if (response.status === 409 && data && data.code === 'ADMIN_SESSION_ACTIVE') {
message = 'В этом клубе уже работает другой администратор. Одновременно может быть только один администратор.';
}
if (response.status === 409 && data && data.code === 'ADMIN_ALREADY_LOGGED_IN') {
message = 'Этот администратор уже находится в активной сессии. Сначала завершите текущую сессию.';
}
if (response.status === 401 && data && (data.code === 'ADMIN_SESSION_TAKEN_OVER' || data.code === 'ADMIN_SESSION_EXPIRED')) {
message = 'Ваша сессия завершена. Возможно, вошел другой администратор или истекло время активности.';
}
if (response.status === 401 && data && (data.code === 'SESSION_REVOKED' || data.code === 'ACCOUNT_DEACTIVATED')) {
message = 'Доступ был сброшен администратором. Войдите заново.';
}
const error = new Error(message);
error.status = response.status;
error.code = data && typeof data === 'object' ? data.code : null;
error.payload = data;
return error;
}

function handleForcedAdminRelogin() {
clearAuthToken();
currentAdmin = null;
storage.saveCurrentAdmin(state);
saveSessionAdmin(null);

if (document.getElementById('userPanel')) {
document.getElementById('userPanel').style.display = 'none';
}
updateManagementNavVisibility();
if (document.getElementById('authModal')) {
document.getElementById('authModal').style.display = 'flex';
}
notify('Ваша сессия завершена. Возможно, вошел другой администратор или истекло время активности.', 'Ошибка');
}

function reportClientError(context, error, options = {}) {
const message = error && error.message ? error.message : String(error || 'Unknown error');
console.warn(`[client-error] ${context}: ${message}`, error);
if (!options.silent) {
notify(`⚠️ ${context}: ${message}`, 'Ошибка');
}
}

async function apiRequest(path, options = {}) {
const token = getAuthToken();
const method = String(options.method || 'GET').toUpperCase();
if (token && method !== 'GET' && isSubscriptionExpired()) {
throw new Error('Подписка истекла. Продлите подписку.');
}
const headers = Object.assign({}, options.headers || {});
if (!headers['Content-Type'] && options.body !== undefined) {
headers['Content-Type'] = 'application/json';
}
if (token) headers.Authorization = `Bearer ${token}`;
if (clubContext.id) headers['x-club-id'] = String(clubContext.id);

const response = await fetch(`${API_BASE}${path}`, {
method: options.method || 'GET',
headers,
body: options.body
});

const text = await response.text();
const data = parseApiPayload(text);

if (!response.ok) {
const error = createApiError(response, data);
if (error.code === 'ADMIN_SESSION_TAKEN_OVER' || error.code === 'ADMIN_SESSION_EXPIRED' ||
    error.code === 'SESSION_REVOKED' || error.code === 'ACCOUNT_DEACTIVATED') {
handleForcedAdminRelogin();
}
throw error;
}

return data;
}

function fromApiBooking(row) {
return {
id: row.id,
booking_uid: row.booking_uid || '',
name: row.name,
pc: row.pc,
time: row.time,
dateValue: row.date_value,
dateDisplay: row.date_display,
phone: row.phone || '',
prepay: row.prepay || 'Нет',
status: row.status,
pcStatuses: row.pc_statuses || {},
arrived: row.status === 'arrived',
addedBy: row.admin_name || row.admin_login || null,
    addedAt: row.created_at,
    updatedAt: row.updated_at || null
};
}

function toApiBooking(booking) {
return {
name: booking.name,
pc: booking.pc,
time: booking.time,
date_value: booking.dateValue,
date_display: booking.dateDisplay,
phone: booking.phone || null,
prepay: booking.prepay,
pc_statuses: booking.pcStatuses || {}
};
}

async function syncStateFromBackend() {
if (!getAuthToken()) return;
const [activeRes, finishedRes, ratingsRes, adminRes, psConsolesRes, clubConfigRes] = await Promise.allSettled([
apiRequest('/bookings/pc?status=pending'),
apiRequest('/bookings/pc/done'),
apiRequest('/guests/ratings'),
apiRequest('/admins'),
apiRequest('/ps/consoles'),
apiRequest('/club/config')
]);

const active = activeRes.status === 'fulfilled' ? activeRes.value : [];
const finished = finishedRes.status === 'fulfilled' ? finishedRes.value : [];
const ratings = ratingsRes.status === 'fulfilled' ? ratingsRes.value : [];
const adminList = adminRes.status === 'fulfilled' ? adminRes.value : [];
const psConsolesApi = psConsolesRes.status === 'fulfilled' ? psConsolesRes.value : [];
const clubConfig = clubConfigRes.status === 'fulfilled' ? clubConfigRes.value : null;

if (!clubConfig || !Array.isArray(clubConfig.ps_consoles)) {
throw new Error('CLUB_CONFIG_NOT_FOUND');
}

if (clubConfig && clubConfig.club && clubConfig.club.subscription) {
clubContext.subscription = resolveSubscriptionState(clubConfig.club.subscription);
}
applyPsRuntimeConfig(clubConfig);

bookings = Array.isArray(active) ? active.map(fromApiBooking) : [];
done = Array.isArray(finished) ? finished.map(fromApiBooking) : [];

guestRatings = {};
(Array.isArray(ratings) ? ratings : []).forEach((item) => {
guestRatings[item.phone] = {
phone: item.phone,
rating: item.rating,
total: item.total_bookings,
arrived: item.arrived,
late: item.late,
cancelled: item.cancelled,
noShow: item.no_show
};
});

admins = (Array.isArray(adminList) ? adminList : []).map((a) => ({
id: a.id,
login: a.login,
name: a.name,
isRoot: !!a.is_root,
isClubOwner: !!a.is_club_owner,
role: a.is_club_owner ? CLUB_OWNER_ROLE : CLUB_ADMIN_ROLE,
created: a.created_at
}));

psConsoles = (Array.isArray(psConsolesApi) ? psConsolesApi : []).map((item) => {
const session = item.session || null;
const booking = item.booking || null;
return {
id: item.id,
status: item.status || 'idle',
remaining: item.remaining || 0,
startTime: session ? new Date(session.start_time).getTime() : 0,
prepaid: session ? Number(session.prepaid_minutes || 0) : 0,
totalPaid: session ? Number(session.total_paid || 0) : 0,
selectedPackage: session ? session.selected_package : null,
addedTime: session ? Number(session.added_time || 0) : 0,
clientName: session ? session.client_name : null,
clientPhone: session ? session.client_phone : null,
booking: booking ? {
id: booking.id,
name: booking.name,
phone: booking.phone,
time: booking.time,
dateValue: booking.date_value,
dateDisplay: booking.date_display,
bookedAt: booking.created_at
} : null,
isFreeTime: session ? !!session.is_free_time : false
};
});

storage.saveBookingsState(state);
storage.saveAdmins(state);
renderTable();
renderDone();
renderGuests();
updateCounter();
renderSubscriptionState();
enforceSubscriptionLock();
}

async function syncCreateBooking(booking, force = false) {
const created = await apiRequest('/bookings/pc', {
method: 'POST',
body: JSON.stringify(Object.assign({}, toApiBooking(booking), { force }))
});
booking.id = created.id;
}

async function syncUpdateBooking(booking) {
if (!booking.id) return;
await apiRequest(`/bookings/pc/${booking.id}`, {
method: 'PUT',
body: JSON.stringify(toApiBooking(booking))
});
}

async function syncDeleteBooking(booking) {
if (!booking || !booking.id) return;
await apiRequest(`/bookings/pc/${booking.id}`, { method: 'DELETE' });
}

async function syncBookingStatus(booking, status) {
if (!booking || !booking.id) return;
await apiRequest(`/bookings/pc/${booking.id}/status`, {
method: 'POST',
body: JSON.stringify({ status })
});
}

storage.loadInitialState(state);
authModule.ensureRootAdmin(state, config, storage);

[
	'currentPlatform',
	'bookings',
	'done',
	'guestRatings',
	'currentBookingIndex',
	'pendingForce',
	'currentAdmin',
	'admins',
	'psConsoles',
	'currentPSID',
	'psTimerInterval',
	'currentEditPCBookingIndex',
	'currentEditPSID'
].forEach((key) => {
	Object.defineProperty(window, key, {
		get() {
			return state[key];
		},
		set(value) {
			state[key] = value;
		},
		configurable: true
	});
});

authToken = loadSessionToken();
if (!currentAdmin) {
const restoredAdmin = loadSessionAdmin();
if (restoredAdmin) currentAdmin = restoredAdmin;
}

function updateUserTime() {
const time = new Date().toLocaleTimeString('ru-RU');
if (document.getElementById('userTime')) {
document.getElementById('userTime').textContent = time;
}
}
setInterval(updateUserTime, 1000);
setInterval(() => {
if (currentPlatform === 'pc') renderTable();
}, 30000);

async function runRealtimeSyncTick() {
if (realtimeSyncInFlight) return;
if (!currentAdmin || !getAuthToken() || isInviteFlow()) return;

realtimeSyncInFlight = true;
try {
await syncStateFromBackend();
if (typeof window.refreshDashboard === 'function') {
window.refreshDashboard();
}

const ownerStatsSection = document.getElementById('ownerStatsSection');
if (ownerStatsSection && ownerStatsSection.style.display !== 'none') {
await refreshOwnerStatsPageContent();
}
} catch (_) {
} finally {
realtimeSyncInFlight = false;
}
}

function ensureRealtimeSyncStarted() {
if (realtimeSyncIntervalId) return;
realtimeSyncIntervalId = setInterval(() => {
if (document.hidden) return;
runRealtimeSyncTick();
}, REALTIME_SYNC_MS);
}

ensureRealtimeSyncStarted();
document.addEventListener('visibilitychange', () => {
if (!document.hidden) runRealtimeSyncTick();
});
window.addEventListener('focus', () => {
runRealtimeSyncTick();
});

// ===== NOTIFICATION SYSTEM =====
function readNotificationTimestamps() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_TIMESTAMPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeNotificationTimestamps(map) {
  try {
    localStorage.setItem(NOTIFICATION_TIMESTAMPS_KEY, JSON.stringify(map));
  } catch (_) {
  }
}

function buildPsExpiredTimestampKey(psId) {
  return `ps-expired-${Number(psId)}`;
}

function getOrCreateNotificationTimestamp(key) {
  const map = readNotificationTimestamps();
  const existing = map[key];
  if (existing) {
    const date = new Date(existing);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const nowIso = new Date().toISOString();
  map[key] = nowIso;
  writeNotificationTimestamps(map);
  return new Date(nowIso);
}

function clearNotificationTimestamp(key) {
  const map = readNotificationTimestamps();
  if (!Object.prototype.hasOwnProperty.call(map, key)) return;
  delete map[key];
  writeNotificationTimestamps(map);
}

function addNotification(type, message, booking = null, ps = null) {
  const notificationPsId = ps && ps.id ? Number(ps.id) : null;
  let timestamp = new Date();
  if (type === notificationTypes.BOOKING_LATE) {
    timestamp = getOrCreateNotificationTimestamp(LATE_SUMMARY_TIMESTAMP_KEY);
  } else if (type === notificationTypes.PS_TIME_EXPIRED && notificationPsId) {
    timestamp = getOrCreateNotificationTimestamp(buildPsExpiredTimestampKey(notificationPsId));
  }

  const notification = {
    id: Date.now() + Math.random(),
    type,
    message,
    booking,
    ps,
    psId: notificationPsId,
    timestamp
  };
  
  dashboardNotifications.unshift(notification);
  if (dashboardNotifications.length > MAX_DASHBOARD_NOTIFICATIONS) {
    dashboardNotifications = dashboardNotifications.slice(0, MAX_DASHBOARD_NOTIFICATIONS);
  }
  
  renderNotifications();
}

function removeNotification(notificationId) {
  dashboardNotifications = dashboardNotifications.filter(n => n.id !== notificationId);
  renderNotifications();
}

// Remove notifications by booking ID when booking is completed or deleted
function removeNotificationsByBookingId(bookingId) {
  dashboardNotifications = dashboardNotifications.filter(n => {
    if (n.booking && n.booking.id === bookingId) {
      return false;
    }
    return true;
  });
  // Recalculate aggregated booking notifications immediately (without waiting interval).
  checkBookingNotifications();
  renderNotifications();
}

// Remove notifications by PS ID when session ends
function removeNotificationsByPsId(psId) {
  const targetPsId = Number(psId);
  clearNotificationTimestamp(buildPsExpiredTimestampKey(targetPsId));
  dashboardNotifications = dashboardNotifications.filter(n => {
    const notificationPsId = Number(n.psId || (n.ps && n.ps.id));
    if (notificationPsId && notificationPsId === targetPsId) {
      return false;
    }
    return true;
  });
  renderNotifications();
}

function syncPsExpiredNotifications() {
  const expiredPsIds = new Set(
    psConsoles
      .filter((ps) => ps && ps.status === 'expired')
      .map((ps) => Number(ps.id))
      .filter((id) => Number.isInteger(id) && id > 0)
  );

  const beforeLength = dashboardNotifications.length;
  dashboardNotifications = dashboardNotifications.filter((n) => {
    if (n.type !== notificationTypes.PS_TIME_EXPIRED) return true;
    const notificationPsId = Number(n.psId || (n.ps && n.ps.id));
    if (!expiredPsIds.has(notificationPsId)) {
      clearNotificationTimestamp(buildPsExpiredTimestampKey(notificationPsId));
      return false;
    }
    return expiredPsIds.has(notificationPsId);
  });

  psConsoles.forEach((ps) => {
    if (!ps || ps.status !== 'expired') return;
    const id = Number(ps.id);
    if (!Number.isInteger(id) || id <= 0) return;
    const exists = dashboardNotifications.some((n) => {
      if (n.type !== notificationTypes.PS_TIME_EXPIRED) return false;
      return Number(n.psId || (n.ps && n.ps.id)) === id;
    });
    if (!exists) {
      dashboardNotifications.unshift({
        id: Date.now() + Math.random(),
        type: notificationTypes.PS_TIME_EXPIRED,
        message: `PlayStation ${id} - время сессии истекло`,
        booking: null,
        ps,
        psId: id,
        timestamp: getOrCreateNotificationTimestamp(buildPsExpiredTimestampKey(id))
      });
    }
  });

  if (dashboardNotifications.length > MAX_DASHBOARD_NOTIFICATIONS) {
    dashboardNotifications = dashboardNotifications.slice(0, MAX_DASHBOARD_NOTIFICATIONS);
  }

  if (beforeLength !== dashboardNotifications.length || expiredPsIds.size > 0) {
    renderNotifications();
  }
}

function getNotificationDotColor(type) {
  switch (type) {
    case notificationTypes.BOOKING_LATE:
      return 'orange';
    case notificationTypes.PS_TIME_EXPIRED:
    case notificationTypes.PS_SESSION_ENDING_SOON:
      return 'red';
    default:
      return 'gray';
  }
}

function updateDashboardNotificationBadge() {
  const badge = document.getElementById('dashNotifBadge');
  if (!badge) return;
  if (dashboardNotifications.length > 0) {
    badge.classList.add('is-visible');
  } else {
    badge.classList.remove('is-visible');
  }
}

function renderNotifications() {
  const activityList = document.getElementById('activityList');
  updateDashboardNotificationBadge();
  if (!activityList) return;
  
  if (dashboardNotifications.length === 0) {
    activityList.innerHTML = `
      <div class="activity-item">
        <span class="activity-dot gray"></span>
        <div class="activity-content">
          <div class="activity-text">Нет уведомлений</div>
        </div>
      </div>
    `;
    return;
  }
  
  activityList.innerHTML = dashboardNotifications.map(notification => {
    const timeStr = formatTimeDifference(notification.timestamp);
    const dotColor = getNotificationDotColor(notification.type);
    const isLateSummary = notification.type === notificationTypes.BOOKING_LATE;
    const isPsNotification = notification.type === notificationTypes.PS_TIME_EXPIRED
      || notification.type === notificationTypes.PS_SESSION_ENDING_SOON;
    const clickAttr = isLateSummary
      ? 'onclick="window.openLateBookingsFromNotification && window.openLateBookingsFromNotification()" style="cursor:pointer;"'
      : (isPsNotification
        ? 'onclick="window.openPsTab && window.openPsTab()" style="cursor:pointer;"'
        : '');
    
    let content = `
      <div class="activity-item activity-item-${notification.type}" ${clickAttr}>
        <span class="activity-dot ${dotColor}"></span>
        <div class="activity-content">
          <div class="activity-text">${notification.message}</div>
          <div class="activity-time">${timeStr}</div>
        </div>
    `;
    
    content += `
      </div>
    `;
    
    return content;
  }).join('');
}

function formatTimeDifference(pastDate) {
  const now = new Date();
  const diff = now - pastDate;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (seconds < 60) return 'только что';
  if (minutes < 60) return `${minutes} ${getMinutesLabel(minutes)} назад`;
  if (hours < 24) return `${hours} ${getHoursLabel(hours)} назад`;
  return pastDate.toLocaleString('ru-RU');
}

function getMinutesLabel(num) {
  if (num % 10 === 1 && num !== 11) return 'минута';
  if ([2, 3, 4].includes(num % 10) && ![12, 13, 14].includes(num)) return 'минуты';
  return 'минут';
}

function getHoursLabel(num) {
  if (num % 10 === 1 && num !== 11) return 'час';
  if ([2, 3, 4].includes(num % 10) && ![12, 13, 14].includes(num)) return 'часа';
  return 'часов';
}

function getBookingLateMinutes(booking, now = new Date()) {
  if (!booking || booking.arrived) return 0;
  const bookingTime = new Date(`${booking.dateValue}T${booking.time}:00`);
  if (Number.isNaN(bookingTime.getTime())) return 0;
  const diffMs = now.getTime() - bookingTime.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 60000);
}

function checkBookingNotifications() {
  const now = new Date();
  const lateBookings = bookings.filter((booking) => getBookingLateMinutes(booking, now) >= 1);
  const existingLateSummary = dashboardNotifications.find((n) => n.type === notificationTypes.BOOKING_LATE);

  if (lateBookings.length === 0) {
    if (existingLateSummary) {
      dashboardNotifications = dashboardNotifications.filter((n) => n.type !== notificationTypes.BOOKING_LATE);
      clearNotificationTimestamp(LATE_SUMMARY_TIMESTAMP_KEY);
      renderNotifications();
    }
    return;
  }

  const count = lateBookings.length;
  const message = count === 1
    ? 'Есть клиент, который опаздывает по брони'
    : `Есть клиенты, которые опаздывают по брони (${count})`;

  if (existingLateSummary) {
    existingLateSummary.message = message;
    renderNotifications();
  } else {
    addNotification(notificationTypes.BOOKING_LATE, message);
  }
}

function getLateMinutesLabel(num) {
  if (num % 10 === 1 && num !== 11) return 'минуту';
  if ([2, 3, 4].includes(num % 10) && ![12, 13, 14].includes(num)) return 'минуты';
  return 'минут';
}

function startBookingNotificationMonitoring() {
  if (bookingNotificationIntervalId) return;
  renderNotifications();
  syncPsExpiredNotifications();
  checkBookingNotifications();
  bookingNotificationIntervalId = setInterval(() => {
    syncPsExpiredNotifications();
    checkBookingNotifications();
  }, BOOKING_NOTIFICATION_CHECK_MS);
}

function stopBookingNotificationMonitoring() {
  if (bookingNotificationIntervalId) {
    clearInterval(bookingNotificationIntervalId);
    bookingNotificationIntervalId = null;
  }
}

// Send WhatsApp reminder
window.sendReminder = function(phone, name, time, pc) {
  if (!phone) return;
  const message = `Напоминаем: Ваша бронь на ${time} на ПК ${pc}. Ждем Вас! 😊`;
  const waLink = getWhatsAppLink(phone, message);
  if (waLink) {
    window.location.href = waLink;
  }
};

function sendWhatsAppBooking(name, pc, time, dateDisplay, phone, prepay) {
const phoneDigits = phone.replace(/\D/g, '');
if (phoneDigits.length !== 11) return;
const pcList = pc.replace(/,/g, ', ');
const clubName = String(clubContext.name || '').trim();
let message = `Сәлеметсіз бе, ${name}!\n\n№${pcList} компьютерлер сіздің атыңызға ${time}, ${dateDisplay} күні брондалды.`;
if (prepay && prepay !== 'Нет' && prepay !== '0') {
message += `\nАлдын ала төлем: ${prepay}тг`;
}
message += `\n\nУақытында келуіңізді сұраймыз - бронь 15 минут сақталады.`;
if (prepay && prepay !== 'Нет' && prepay !== '0') {
message += `\nНазар аударыңыз: кешігу немесе келмеу жағдайында алдын ала төлем қайтарылмайды.`;
}
if (clubName) {
message += `\n\n${clubName} командасы <3`;
}
message += `\n\n---\n\n`;
message += `Здравствуйте, ${name}!\n\nКомпьютеры №${pcList} забронированы на Ваше имя на ${time}, ${dateDisplay}.`;
if (prepay && prepay !== 'Нет' && prepay !== '0') {
message += `\nПредоплата: ${prepay}тг`;
}
message += `\n\nПросим прийти вовремя - бронь держится 15 минут.`;
if (prepay && prepay !== 'Нет' && prepay !== '0') {
message += `\nОбратите внимание: при опоздании или неявке предоплата не возвращается.`;
}
if (clubName) {
message += `\n\nС любовью, ${clubName} <3`;
}
const encodedMessage = encodeURIComponent(message);
const whatsappUrl = `whatsapp://send?phone=${phoneDigits}&text=${encodedMessage}`;
window.location.href = whatsappUrl;
}
function sendWhatsAppPSBooking(name, psID, time, dateDisplay, phone) {
const phoneDigits = phone.replace(/\D/g, '');
if (phoneDigits.length !== 11) return;
const clubName = String(clubContext.name || '').trim();
let message = `Сәлеметсіз бе, ${name}!\n\nPlayStation #${psID} сіздің атыңызға ${time}, ${dateDisplay} күні брондалды.`;
message += `\n\nУақытында келуіңізді сұраймыз - бронь 15 минут сақталады.`;
if (clubName) {
message += `\n\n${clubName} командасы <3`;
}
message += `\n\n---\n\n`;
message += `Здравствуйте, ${name}!\n\nPlayStation #${psID} забронирована на Ваше имя на ${time}, ${dateDisplay}.`;
message += `\n\nПросим прийти вовремя - бронь держится 15 минут.`;
if (clubName) {
message += `\n\nС любовью, ${clubName} <3`;
}
const encodedMessage = encodeURIComponent(message);
const whatsappUrl = `whatsapp://send?phone=${phoneDigits}&text=${encodedMessage}`;
window.location.href = whatsappUrl;
}
function sendWhatsAppPSReminder(booking, psID) {
if (!booking || !booking.phone) return;
let phoneDigits = booking.phone.replace(/\D/g, '');
if (phoneDigits.startsWith('8')) phoneDigits = `7${phoneDigits.slice(1)}`;
if (!(phoneDigits.startsWith('7') && phoneDigits.length === 11)) return;

const dateText = booking.dateDisplay || booking.dateValue.split('-').reverse().join('.');
const clubName = String(clubContext.name || '').trim();
let message = `Сәлеметсіз бе, ${booking.name}!\n\nСізде PlayStation #${psID} үшін ${booking.time}, ${dateText} уақытына бронь бар.`;
message += `\nҚазіргі уақыт бронь уақытынан өтті. Келетініңізді растауыңызды сұраймыз.`;
message += `\n\n---\n\n`;
message += `Здравствуйте, ${booking.name}!\n\nУ Вас бронь на PlayStation #${psID} на ${booking.time}, ${dateText}.`;
message += `\nСейчас время брони уже наступило. Пожалуйста, подтвердите, что Вы в пути.`;
if (clubName) {
message += `\n\n${clubName}`;
}

const encodedMessage = encodeURIComponent(message);
const whatsappUrl = `whatsapp://send?phone=${phoneDigits}&text=${encodedMessage}`;
window.location.href = whatsappUrl;
}
function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isBookingOverdue(booking, now = new Date()) {
if (booking.arrived) return false;
const bookingTime = new Date(`${booking.dateValue}T${booking.time}:00`);
if (Number.isNaN(bookingTime.getTime())) return false;
return now > bookingTime;
}

function isBookingTimeValid(dateValue, time) {
  const now = new Date();
  const bookingTime = new Date(`${dateValue}T${time}:00`);
  if (Number.isNaN(bookingTime.getTime())) return false;
  return bookingTime > now;
}
function sendWhatsAppReminder(booking) {
if (!booking || !booking.phone) return;
let phoneDigits = booking.phone.replace(/\D/g, '');
if (phoneDigits.startsWith('8')) phoneDigits = `7${phoneDigits.slice(1)}`;
if (!(phoneDigits.startsWith('7') && phoneDigits.length === 11)) return;

const dateText = booking.dateDisplay || booking.dateValue.split('-').reverse().join('.');
const pcList = booking.pc.replace(/,/g, ', ');
const clubName = String(clubContext.name || '').trim();
let message = `Сәлеметсіз бе, ${booking.name}!\n\nСізде №${pcList} компьютерлерге ${booking.time}, ${dateText} уақытына бронь бар.`;
message += `\nҚазіргі уақыт бронь уақытынан өтті. Келетініңізді растауыңызды сұраймыз.`;
message += `\n\n---\n\n`;
message += `Здравствуйте, ${booking.name}!\n\nУ Вас бронь на компьютеры №${pcList} на ${booking.time}, ${dateText}.`;
message += `\nСейчас время брони уже наступило. Пожалуйста, подтвердите, что Вы в пути.`;
if (clubName) {
message += `\n\n${clubName}`;
}

const encodedMessage = encodeURIComponent(message);
const whatsappUrl = `whatsapp://send?phone=${phoneDigits}&text=${encodedMessage}`;
window.location.href = whatsappUrl;
}
function toggleAddPanel() { document.getElementById('addPanel').classList.toggle('show'); }
function toggleSearchPanel() { document.getElementById('searchPanel').classList.toggle('show'); }
function showDonePage() {
if (currentPlatform !== 'pc') return; 
document.querySelector('.controls-row').style.display = 'none';
document.getElementById('addPanel').classList.remove('show');
document.getElementById('searchPanel').classList.remove('show');
document.getElementById('mainContent').style.display = 'none';
document.getElementById('guestsPage').style.display = 'none';
document.getElementById('donePage').style.display = 'block';
renderDone();
}
function hideDonePage() {
if (currentPlatform === 'pc') {
document.querySelector('.controls-row').style.display = 'flex';
document.getElementById('donePage').style.display = 'none';
document.getElementById('mainContent').style.display = 'block';
}
}
function showGuestsPage() {
if (currentPlatform !== 'pc') return; 
const bookingsHeading = document.getElementById('bookingsHeading');
if (bookingsHeading) bookingsHeading.style.display = 'none';
document.querySelector('.controls-row').style.display = 'none';
document.getElementById('addPanel').classList.remove('show');
document.getElementById('searchPanel').classList.remove('show');
document.getElementById('mainContent').style.display = 'none';
document.getElementById('donePage').style.display = 'none';
document.getElementById('guestsPage').style.display = 'block';
renderGuests();
}
function hideGuestsPage() {
if (currentPlatform === 'pc') {
const bookingsHeading = document.getElementById('bookingsHeading');
if (bookingsHeading) bookingsHeading.style.display = 'flex';
document.querySelector('.controls-row').style.display = 'flex';
document.getElementById('guestsPage').style.display = 'none';
document.getElementById('mainContent').style.display = 'block';
}
}
function switchPlatform(platform) {
if (platform === 'pc' && !clubContext.pcEnabled) return;
if (platform === 'ps' && !clubContext.psEnabled) return;
currentPlatform = platform;
document.getElementById('addPanel').classList.remove('show');
document.getElementById('searchPanel').classList.remove('show');
document.getElementById('mainContent').style.display = 'none';
document.getElementById('donePage').style.display = 'none';
document.getElementById('guestsPage').style.display = 'none';
document.getElementById('psConsolesPage').style.display = 'none';
const bookingsHeading = document.getElementById('bookingsHeading');
const bookingsHeadingTitle = document.getElementById('bookingsHeadingTitle');
const bookingsHeadingSub = document.getElementById('bookingsHeadingSub');
if (bookingsHeading) bookingsHeading.style.display = 'flex';
if (bookingsHeadingTitle) bookingsHeadingTitle.textContent = platform === 'pc' ? 'Бронирование ПК' : 'Бронирование PlayStation';
if (bookingsHeadingSub) bookingsHeadingSub.textContent = platform === 'pc'
? 'Управление активными бронированиями'
: 'Управление активными сессиями PlayStation';
const controlsRows = document.querySelectorAll('.controls-row');
controlsRows.forEach(row => {
if (row.getAttribute('data-platform') === 'pc') {
row.style.display = platform === 'pc' ? 'flex' : 'none';
} else if (row.getAttribute('data-platform') === 'ps') {
row.style.display = platform === 'ps' ? 'flex' : 'none';
}
});
const pcBtn = document.getElementById('platformPcBtn');
const psBtn = document.getElementById('platformPsBtn');
if (pcBtn && psBtn) {
if (platform === 'pc') {
pcBtn.classList.add('active');
psBtn.classList.remove('active');
document.getElementById('mainContent').style.display = 'block';
updatePCCounter();
} else {
pcBtn.classList.remove('active');
psBtn.classList.add('active');
document.getElementById('psConsolesPage').style.display = 'block';
renderPSConsoles();
updatePSCounter();
}
}

applyPlatformVisibility();
}
function updatePCCounter() {
let count = 0;
const selectedDate = document.getElementById('searchDate')?.value || '';
bookings.forEach(b => {
if (selectedDate && b.dateValue !== selectedDate) return;
count += b.pc.split(',').length;
});
const counter = document.getElementById('counter');
if (counter) counter.textContent = `${count}/${getCurrentPcCapacity()}`;
}
function updatePSCounter() {
let activeCount = 0;
psConsoles.forEach(ps => {
if (ps.status === 'active' || ps.status === 'warning') {
activeCount++;
}
});
const counter = document.getElementById('counter');
const totalPS = getCurrentPsCapacity();
if (counter) counter.textContent = `${activeCount}/${totalPS}`;
}
function resetSearch() {
document.getElementById('searchDate').value = "";
document.getElementById('searchName').value = "";
document.getElementById('searchPC').value = "";
document.getElementById('searchPhone').value = "";
window._filterPrepayOnly = false;
window._filterLateOnly = false;
renderTable();
updatePCCounter();
}

window.resetPcTableFilters = function() {
  const searchDate = document.getElementById('searchDate');
  const searchName = document.getElementById('searchName');
  const searchPC = document.getElementById('searchPC');
  const searchPhone = document.getElementById('searchPhone');
  if (searchDate) searchDate.value = '';
  if (searchName) searchName.value = '';
  if (searchPC) searchPC.value = '';
  if (searchPhone) searchPhone.value = '';
  window._filterPrepayOnly = false;
  window._filterLateOnly = false;
  renderTable();
  updateCounter();
};

window._filterPrepayOnly = false;
window._filterLateOnly = false;
window.loadDashboardTasksWidget = loadDashboardTasksWidget;

window.openPcTabToday = function(prepayOnly) {
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
  var navPC = document.getElementById('navPC');
  if (navPC) navPC.classList.add('active');
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('bookingsSection').style.display = 'flex';
  ['logsSection','bookingHistorySection','customerHistorySection','ownerStatsSection','adminsSection','tasksSection']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  window._filterPrepayOnly = !!prepayOnly;
  window._filterLateOnly = false;
  switchPlatform('pc');
  var todayStr = getLocalDateString(getCurrentLocalDate());
  var searchDate = document.getElementById('searchDate');
  if (searchDate) searchDate.value = todayStr;
  renderTable();
  updateCounter();
};

window.openPsTab = function() {
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
  var navPS = document.getElementById('navPS');
  if (navPS) navPS.classList.add('active');
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('bookingsSection').style.display = 'flex';
  ['logsSection','bookingHistorySection','customerHistorySection','ownerStatsSection','adminsSection','tasksSection']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  switchPlatform('ps');
};

window.openAllPcTab = function() {
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
  var navPC = document.getElementById('navPC');
  if (navPC) navPC.classList.add('active');
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('bookingsSection').style.display = 'flex';
  ['logsSection','bookingHistorySection','customerHistorySection','ownerStatsSection','adminsSection','tasksSection']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  window._filterPrepayOnly = false;
  window._filterLateOnly = false;
  switchPlatform('pc');
  var searchDate = document.getElementById('searchDate');
  if (searchDate) searchDate.value = '';
  renderTable();
  updateCounter();
};

window.openLateBookingsFromNotification = function() {
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
  var navPC = document.getElementById('navPC');
  if (navPC) navPC.classList.add('active');
  document.getElementById('dashboardSection').style.display = 'none';
  document.getElementById('bookingsSection').style.display = 'flex';
  ['logsSection','bookingHistorySection','customerHistorySection','ownerStatsSection','adminsSection','tasksSection']
    .forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  switchPlatform('pc');
  window._filterPrepayOnly = false;
  window._filterLateOnly = true;
  var searchName = document.getElementById('searchName');
  if (searchName) searchName.value = '';
  var searchPC = document.getElementById('searchPC');
  if (searchPC) searchPC.value = '';
  var searchPhone = document.getElementById('searchPhone');
  if (searchPhone) searchPhone.value = '';
  var searchDate = document.getElementById('searchDate');
  if (searchDate) searchDate.value = '';
  renderTable();
  updateCounter();
};

function getCurrentLocalDate() {
return new Date();
}

function getMsUntilNextMidnight() {
const now = new Date();
const nextMidnight = new Date(now);
nextMidnight.setHours(24, 0, 0, 0);
return nextMidnight.getTime() - now.getTime();
}

function refillDateSelect(select, options, preserveEmptyOption = false) {
if (!select) return;
const previousValue = select.value;
const emptyOption = preserveEmptyOption
? Array.from(select.options).find(opt => opt.value === '')
: null;

select.innerHTML = '';

if (emptyOption) {
const placeholder = document.createElement('option');
placeholder.value = '';
placeholder.textContent = emptyOption.textContent;
select.appendChild(placeholder);
}

options.forEach((opt) => {
const option = document.createElement('option');
option.value = opt.value;
option.textContent = opt.text;
select.appendChild(option);
});

if (previousValue && options.some(opt => opt.value === previousValue)) {
select.value = previousValue;
return;
}

if (emptyOption) {
select.value = '';
return;
}

if (options.length > 0) {
select.value = options[0].value;
}
}

function populateDates() {
const dateSelect = document.getElementById('date');
const searchDateSelect = document.getElementById('searchDate');
const doneSearchDateSelect = document.getElementById('doneSearchDate');
const quickDateSelect = document.getElementById('quickDate');
const psBookingDateSelect = document.getElementById('psBookingDate');
const editPCDateSelect = document.getElementById('editPCDate');
const editPSBookingDateSelect = document.getElementById('editPSBookingDate');
const today = getCurrentLocalDate();
const dateOptions = [];
for (let i = 0; i < config.bookingDateHorizonDays; i++) {
const d = new Date(today);
d.setDate(today.getDate() + i);
const dateStr = getLocalDateString(d);
const dateText = d.toLocaleDateString('ru-RU', {day:'2-digit', month:'2-digit', year:'numeric'});
dateOptions.push({ value: dateStr, text: dateText });
}

refillDateSelect(dateSelect, dateOptions);
refillDateSelect(searchDateSelect, dateOptions, true);
refillDateSelect(doneSearchDateSelect, dateOptions, true);
refillDateSelect(quickDateSelect, dateOptions);
refillDateSelect(psBookingDateSelect, dateOptions);
refillDateSelect(editPCDateSelect, dateOptions);
refillDateSelect(editPSBookingDateSelect, dateOptions);
}

function scheduleDateRefreshAtMidnight() {
setTimeout(() => {
populateDates();
scheduleDateRefreshAtMidnight();
}, getMsUntilNextMidnight() + 1000);
}

populateDates();
scheduleDateRefreshAtMidnight();
const phoneInput = document.getElementById('phone');
function cleanPhone(str) {
let digits = str.replace(/\D/g, '');
if (digits.startsWith('7') || digits.startsWith('8')) digits = digits.slice(1);
return digits.slice(0, 10);
}
function formatPhone(digits) {
let result = '+7';
if (digits.length > 0) result += ' ' + digits.slice(0, 3);
if (digits.length > 3) result += ' ' + digits.slice(3, 6);
if (digits.length > 6) result += ' ' + digits.slice(6, 10);
return result;
}
function getPhoneDigits() {
return cleanPhone(phoneInput.value);
}
function getWhatsAppLink(phone, message = null) {
let digits = phone.replace(/\D/g, '');
if (digits.startsWith('8')) digits = '7' + digits.slice(1);
if (digits.startsWith('7') && digits.length === 11) {
  let url = `whatsapp://send?phone=${digits}`;
  if (message) {
    url += `&text=${encodeURIComponent(message)}`;
  }
  return url;
}
return null;
}
uiModule.bindRuPhoneInput(phoneInput, cleanPhone, formatPhone);
function saveAll() {
storage.saveBookingsState(state);
renderTable();
renderDone();
renderGuests();
updateCounter();
if (typeof window.refreshDashboard === 'function') {
window.refreshDashboard();
}
}
function getOrCreateGuestRating(phone) {
const phoneDigits = cleanPhone(phone);
if (!guestRatings[phoneDigits]) {
guestRatings[phoneDigits] = {
phone: phone,
rating: 100,
total: 0,
arrived: 0,
late: 0,
cancelled: 0,
noShow: 0
};
}
return guestRatings[phoneDigits];
}
function getRatingBadgeClass(rating) {
if (rating >= 90) return 'rating-excellent';
if (rating >= 70) return 'rating-good';
if (rating >= 50) return 'rating-fair';
return 'rating-poor';
}
function updateCounter() {
if (currentPlatform === 'pc') {
updatePCCounter();
} else {
updatePSCounter();
}
}
function showError(msg) {
uiModule.showAlert(msg, 'Ошибка');
}
function notify(msg, title = 'Уведомление') {
uiModule.showAlert(msg, title);
}
function showAdminInviteNotification(msg) {
const el = document.getElementById('adminInviteNotification');
if (!el) return;
el.textContent = msg;
el.style.display = 'block';
if (el._timeout) clearTimeout(el._timeout);
el._timeout = setTimeout(() => {
el.style.display = 'none';
}, 3500);
}
function confirmAction(msg, onConfirm, title = 'Подтвердите действие') {
uiModule.showConfirm(msg, onConfirm, title);
}
function getBookingPCs(booking) {
if (!booking || !booking.pc) return [];
return booking.pc.split(',').map(p => p.trim()).filter(Boolean);
}
function ensureBookingPCStatuses(booking) {
const pcs = getBookingPCs(booking);
if (!booking.pcStatuses || typeof booking.pcStatuses !== 'object') {
booking.pcStatuses = {};
}
pcs.forEach(pc => {
if (!booking.pcStatuses[pc]) {
booking.pcStatuses[pc] = 'pending';
}
});
return booking.pcStatuses;
}
function createPendingPCStatuses(pcString) {
const statuses = {};
pcBookingsModule.parsePcList(pcString.replace(/,/g, ' ')).forEach(pc => {
statuses[pc] = 'pending';
});
return statuses;
}
let currentPCStatusTarget = null;
function getPCStatusTitle(status) {
if (status === 'arrived') return 'пришёл';
return 'ожидается';
}
function getPendingPCCount(booking) {
const statuses = ensureBookingPCStatuses(booking);
return getBookingPCs(booking).filter(pc => (statuses[pc] || 'pending') === 'pending').length;
}
function completeBookingAsArrived(index) {
if (index === null || index < 0 || index >= bookings.length) return;
const booking = bookings[index];
const pcsCount = getBookingPCs(booking).length || 1;
if (booking.phone) {
const guestRating = getOrCreateGuestRating(booking.phone);
guestRating.total += pcsCount;
guestRating.arrived += pcsCount;
}
booking.status = 'arrived';
booking.updatedAt = new Date().toISOString();
done.push(booking);
bookings.splice(index, 1);
}
function closePCStatusModal() {
document.getElementById('pcStatusModal').style.display = 'none';
currentPCStatusTarget = null;
}
function openPCStatusModal(index, pc) {
const booking = bookings[index];
if (!booking) return;
currentPCStatusTarget = { index, pc };
const statuses = ensureBookingPCStatuses(booking);
const statusText = getPCStatusTitle(statuses[pc] || 'pending');
document.getElementById('pcStatusBookingInfo').textContent = `${booking.name} · ПК ${pc} (${statusText})`;
document.getElementById('pcStatusModal').style.display = 'flex';
}
async function confirmPCArrived() {
if (!currentPCStatusTarget) return;
const { index, pc } = currentPCStatusTarget;
const booking = bookings[index];
if (!booking) {
closePCStatusModal();
return;
}
const snapshotBookings = JSON.parse(JSON.stringify(bookings));
const snapshotDone = JSON.parse(JSON.stringify(done));
const snapshotRatings = JSON.parse(JSON.stringify(guestRatings));
const statuses = ensureBookingPCStatuses(booking);
statuses[pc] = 'arrived';

if (getPendingPCCount(booking) === 0) {
completeBookingAsArrived(index);
saveAll();
closePCStatusModal();
notify('Все ПК отмечены как пришедшие. Бронь перенесена в выполненные.', 'Успешно');
try {
await syncUpdateBooking(booking);
await syncBookingStatus(booking, 'arrived');
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
return;
}

saveAll();
closePCStatusModal();
try {
await syncUpdateBooking(booking);
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
}
function closeWarn() {
document.getElementById('warnModal').style.display = 'none';
pendingForce = null;
}
function closeModal() {
document.getElementById('modal').style.display = 'none';
currentBookingIndex = null;
}
function renderTable() {
const tbody = document.getElementById('bookingTable');
tbody.innerHTML = '';
const searchName = document.getElementById('searchName')?.value.trim().toLowerCase() || '';
const searchPC = document.getElementById('searchPC')?.value.trim() || '';
const searchPhone = document.getElementById('searchPhone')?.value.trim().replace(/\D/g, '') || '';
const selectedDate = document.getElementById('searchDate')?.value || '';
bookings.sort((a, b) => {
const dateTimeA = new Date(a.dateValue + 'T' + a.time + ':00');
const dateTimeB = new Date(b.dateValue + 'T' + b.time + ':00');
return dateTimeA - dateTimeB;
});
bookings.forEach((b, i) => {
if (selectedDate && b.dateValue !== selectedDate) return;
if (window._filterLateOnly && getBookingLateMinutes(b) < 1) return;
if (window._filterPrepayOnly) {
  const rawPrepay = String(b.prepay || '').trim().replace(/\s+/g,'').replace(/,/g,'.').replace(/[^0-9.\-]/g,'');
  if (!rawPrepay || Number(rawPrepay) <= 0) return;
}
let matches = true;
if (searchName) matches = matches && b.name.toLowerCase().includes(searchName);
if (searchPC) matches = matches && b.pc.split(',').map(p => p.trim()).includes(searchPC.trim());
if (searchPhone) {
let digits = b.phone.replace(/\D/g, '');
if (digits.startsWith('7') || digits.startsWith('8')) digits = digits.slice(1);
matches = matches && digits.slice(-4).includes(searchPhone.slice(-4));
}
if (!matches) return;
const tr = document.createElement('tr');
const overdue = isBookingOverdue(b);
if (overdue) tr.classList.add('booking-overdue');
const nameTd = document.createElement('td');
nameTd.append(document.createTextNode(b.name + ' '));
if (b.arrived) {
const arrived = document.createElement('span');
arrived.style.color = '#4caf50';
arrived.textContent = '✓';
nameTd.appendChild(arrived);
}
if (b.phone) {
const guestRating = getOrCreateGuestRating(b.phone);
const ratingClass = getRatingBadgeClass(guestRating.rating);
const percentage = Math.round(guestRating.rating);
const barColor =
ratingClass === 'rating-excellent' ? '#4caf50' :
ratingClass === 'rating-good' ? '#2196f3' :
ratingClass === 'rating-fair' ? '#ffc107' : '#f44336';
const badge = document.createElement('span');
badge.className = `rating-badge ${ratingClass}`;
const bar = document.createElement('span');
bar.className = 'rating-bar';
const fill = document.createElement('div');
fill.className = 'rating-fill';
fill.style.width = `${guestRating.rating}%`;
fill.style.background = barColor;
bar.appendChild(fill);
badge.appendChild(bar);
badge.append(document.createTextNode(`${percentage}%`));
nameTd.appendChild(badge);
}
const displayName = b.addedBy === 'Algaib' ? 'Султан' : b.addedBy;
if (b.addedBy) {
const addedDate = new Date(b.addedAt);
const time = addedDate.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
const dateStr = addedDate.toLocaleDateString('ru-RU');
const addedInfo = `${displayName}\n${time}\n${dateStr}`;
nameTd.classList.add('pc-booking-name-tooltip');
nameTd.setAttribute('data-admin-info', addedInfo);
}
const pcTd = document.createElement('td');
const pcs = getBookingPCs(b);
const statuses = ensureBookingPCStatuses(b);
const badges = document.createElement('div');
badges.className = 'pc-badges';
pcs.forEach(pc => {
const status = statuses[pc] || 'pending';
const badge = document.createElement('span');
badge.className = `pc-badge pc-${status}`;
badge.textContent = pc;
badge.title = `ПК ${pc}: ${getPCStatusTitle(status)}`;
badge.addEventListener('click', () => openPCStatusModal(i, pc));
badges.appendChild(badge);
});
pcTd.appendChild(badges);
const timeTd = document.createElement('td');
timeTd.textContent = b.time;
const dateTd = document.createElement('td');
dateTd.textContent = b.dateDisplay || b.dateValue.split('-').reverse().join('.');
const phoneTd = document.createElement('td');
if (b.phone) {
const waLink = getWhatsAppLink(b.phone);
if (waLink) {
const a = document.createElement('a');
a.href = waLink;
a.className = 'phone-link';
a.textContent = b.phone;
phoneTd.appendChild(a);
} else {
phoneTd.textContent = b.phone;
}
} else {
phoneTd.textContent = '-';
}
const prepayTd = document.createElement('td');
prepayTd.textContent = b.prepay;
const actionsTd = document.createElement('td');
actionsTd.className = 'booking-actions-cell';
const dropdown = document.createElement('div');
dropdown.className = 'action-dropdown';
const toggleBtn = document.createElement('button');
toggleBtn.type = 'button';
toggleBtn.className = 'dropdown-toggle';
toggleBtn.style.padding = '8px 12px';
toggleBtn.style.fontSize = '0.85em';
toggleBtn.textContent = 'Действия ▼';
const menu = document.createElement('div');
menu.className = 'dropdown-menu';
const editBtn = document.createElement('button');
editBtn.type = 'button';
editBtn.textContent = 'Редактировать';
editBtn.addEventListener('click', () => openEditPCBooking(i));
const arrivedBtn = document.createElement('button');
arrivedBtn.type = 'button';
arrivedBtn.textContent = 'Отметить прибытие';
arrivedBtn.addEventListener('click', () => openActionModal(i));
const deleteBtn = document.createElement('button');
deleteBtn.type = 'button';
deleteBtn.textContent = 'Удалить';
deleteBtn.addEventListener('click', () => deleteBooking(i));
menu.appendChild(editBtn);
menu.appendChild(arrivedBtn);
menu.appendChild(deleteBtn);
dropdown.appendChild(toggleBtn);
dropdown.appendChild(menu);
dropdown.addEventListener('mouseenter', () => {
const dropdownRect = dropdown.getBoundingClientRect();
const viewportHeight = window.innerHeight;
const spaceBelow = viewportHeight - dropdownRect.bottom;
const menuHeight = menu.scrollHeight || 150; 
if (spaceBelow < menuHeight + 10) {
menu.classList.add('dropdown-menu-top');
} else {
menu.classList.remove('dropdown-menu-top');
}
});
if (overdue && b.phone) {
const remindBtn = document.createElement('button');
remindBtn.type = 'button';
remindBtn.className = 'booking-remind-inline';
remindBtn.textContent = 'Напомнить';
remindBtn.addEventListener('click', () => sendWhatsAppReminder(b));
actionsTd.appendChild(remindBtn);
}
actionsTd.appendChild(dropdown);
tr.appendChild(nameTd);
tr.appendChild(pcTd);
tr.appendChild(timeTd);
tr.appendChild(dateTd);
tr.appendChild(phoneTd);
tr.appendChild(prepayTd);
tr.appendChild(actionsTd);
tbody.appendChild(tr);
});
updateCounter();
}
function adjustAllDropdownMenus() {
document.querySelectorAll('.action-dropdown').forEach(dropdown => {
const menu = dropdown.querySelector('.dropdown-menu');
if (!menu) return;
const dropdownRect = dropdown.getBoundingClientRect();
const viewportHeight = window.innerHeight;
const spaceBelow = viewportHeight - dropdownRect.bottom;
const menuHeight = menu.scrollHeight || 150;
if (spaceBelow < menuHeight + 10) {
menu.classList.add('dropdown-menu-top');
} else {
menu.classList.remove('dropdown-menu-top');
}
});
}
window.addEventListener('scroll', adjustAllDropdownMenus, { passive: true });
function renderDone() {
const tbody = document.getElementById('doneTable');
tbody.innerHTML = '';
const now = new Date();
const searchName = document.getElementById('doneSearchName')?.value.trim().toLowerCase() || '';
const searchPhone = document.getElementById('doneSearchPhone')?.value.trim().replace(/\D/g, '') || '';
const searchPC = document.getElementById('doneSearchPC')?.value.trim() || '';
const selectedDate = document.getElementById('doneSearchDate')?.value || '';
done = done.filter(b => (now - new Date(b.dateValue + 'T' + b.time)) < config.doneRetentionHours * 60 * 60 * 1000);
done.sort((a, b) => {
  const ta = a.updatedAt || a.addedAt || '';
  const tb = b.updatedAt || b.addedAt || '';
  if (tb > ta) return 1;
  if (tb < ta) return -1;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
});
done.forEach(b => {
let matches = true;
if (searchName) matches = matches && b.name.toLowerCase().includes(searchName);
if (selectedDate) matches = matches && b.dateValue === selectedDate;
if (searchPC) matches = matches && b.pc.split(',').map(p => p.trim()).includes(searchPC.trim());
if (searchPhone) {
let digits = b.phone.replace(/\D/g, '');
if (digits.startsWith('7') || digits.startsWith('8')) digits = digits.slice(1);
matches = matches && digits.slice(-4).includes(searchPhone.slice(-4));
}
if (!matches) return;
const tr = document.createElement('tr');
const uidTd = document.createElement('td');
const bookingUid = String(b.booking_uid || '').trim().toUpperCase();
if (bookingUid) {
const uidBtn = document.createElement('button');
uidBtn.type = 'button';
uidBtn.className = 'audit-booking-link';
uidBtn.textContent = bookingUid;
uidBtn.addEventListener('click', function() {
openBookingHistoryByUid(bookingUid);
});
uidTd.appendChild(uidBtn);
} else {
uidTd.textContent = '—';
}
const nameTd = document.createElement('td');
const customerName = String(b.name || '').trim();
const customerPhone = String(b.phone || '').trim();
if (customerName && customerPhone) {
const nameBtn = document.createElement('button');
nameBtn.type = 'button';
nameBtn.className = 'audit-booking-link';
nameBtn.textContent = customerName;
nameBtn.addEventListener('click', function() {
openCustomerHistoryByPhone(customerPhone, customerName);
});
nameTd.appendChild(nameBtn);
} else {
nameTd.textContent = customerName || '—';
}
const displayName = b.addedBy === 'Algaib' ? 'Султан' : b.addedBy;
if (b.addedBy) {
const addedDate = new Date(b.addedAt);
const time = addedDate.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
const dateStr = addedDate.toLocaleDateString('ru-RU');
const addedInfo = `${displayName}\n${time}\n${dateStr}`;
nameTd.classList.add('pc-booking-name-tooltip');
nameTd.setAttribute('data-admin-info', addedInfo);
}
const pcTd = document.createElement('td');
pcTd.textContent = b.pc;
const timeTd = document.createElement('td');
timeTd.textContent = b.time;
const dateTd = document.createElement('td');
dateTd.textContent = b.dateDisplay || b.dateValue.split('-').reverse().join('.');
const phoneTd = document.createElement('td');
phoneTd.textContent = b.phone || '-';
const prepayTd = document.createElement('td');
prepayTd.textContent = b.prepay;
const statusTd = document.createElement('td');
const statusSpan = document.createElement('span');
if (b.status === 'late') {
statusSpan.textContent = '⏰ Опоздал';
statusSpan.style.color = '#ffc107';
} else if (b.status === 'cancelled') {
statusSpan.textContent = '✕ Отмена';
statusSpan.style.color = '#f44336';
} else if (b.status === 'no-show') {
statusSpan.textContent = '✗ Не пришёл';
statusSpan.style.color = '#f44336';
} else {
statusSpan.textContent = '✓ Пришёл';
statusSpan.style.color = '#4caf50';
}
statusTd.appendChild(statusSpan);
tr.appendChild(uidTd);
tr.appendChild(nameTd);
tr.appendChild(pcTd);
tr.appendChild(timeTd);
tr.appendChild(dateTd);
tr.appendChild(phoneTd);
tr.appendChild(prepayTd);
tr.appendChild(statusTd);
tbody.appendChild(tr);
});
}
function renderGuests() {
const container = document.getElementById('guestsContainer');
if (!container) return;
container.innerHTML = '';
const searchVal = document.getElementById('guestSearchInput')?.value.toLowerCase() || '';
const guestList = Object.values(guestRatings).sort((a, b) => b.rating - a.rating);
guestList.forEach(guest => {
const relatedBookings = bookings.concat(done)
.filter(b => cleanPhone(b.phone || '') === cleanPhone(guest.phone || ''))
.sort((a, b) => {
// Сортируем только по времени создания брони (новые первыми)
return new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime();
});
const latestBooking = relatedBookings[0] || null;
const guestName = latestBooking?.name || 'Неизвестный';
if (searchVal && !guest.phone.toLowerCase().includes(searchVal) && !guestName.toLowerCase().includes(searchVal)) return;
const displayPhoneDigits = cleanPhone((latestBooking && latestBooking.phone) || guest.phone || '');
const guestPhoneDisplay = displayPhoneDigits
? formatPhone(displayPhoneDigits)
: (String((latestBooking && latestBooking.phone) || guest.phone || '—').trim() || '—');

let ratingColor = '#4caf50';
if (guest.rating < 90) ratingColor = '#2196f3';
if (guest.rating < 70) ratingColor = '#ffc107';
if (guest.rating < 50) ratingColor = '#f44336';

const activeCount = bookings.filter(b => cleanPhone(b.phone || '') === cleanPhone(guest.phone || '')).length;
const completedCount = done.filter(b => cleanPhone(b.phone || '') === cleanPhone(guest.phone || '')).length;
const latestBookingLabel = latestBooking
? [latestBooking.dateDisplay || latestBooking.dateValue || '', latestBooking.time || ''].filter(Boolean).join(' · ')
: 'Нет данных';
const safePhoneArg = String(guest.phone || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeNameArg = String(guestName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeBookingUidArg = latestBooking && latestBooking.booking_uid
? String(latestBooking.booking_uid).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
: '';
const latestBookingButton = safeBookingUidArg
? `<button type="button" class="guest-action-btn guest-action-btn--secondary" onclick="openBookingHistoryByUid('${safeBookingUidArg}')">Последняя бронь</button>`
: '';

const card = document.createElement('div');
card.className = 'guest-card';
card.innerHTML = `
<div class="guest-card-top">
	<div>
		<div class="guest-name">${escapeHtml(guestName)}</div>
    <div class="guest-phone">${escapeHtml(guestPhoneDisplay)}</div>
	</div>
	<span class="rating-badge ${getRatingBadgeClass(Number(guest.rating || 0))}">${Math.round(Number(guest.rating || 0))}%</span>
</div>
<div class="guest-summary-grid">
	<div class="guest-summary-item"><span>Всего броней</span><strong>${escapeHtml(String(guest.total || 0))}</strong></div>
	<div class="guest-summary-item"><span>Активные</span><strong>${escapeHtml(String(activeCount))}</strong></div>
	<div class="guest-summary-item"><span>Завершённые</span><strong>${escapeHtml(String(completedCount))}</strong></div>
	<div class="guest-summary-item"><span>Неявки</span><strong>${escapeHtml(String(guest.noShow || 0))}</strong></div>
</div>
<div class="guest-stats">Пришёл: ${escapeHtml(String(guest.arrived || 0))} · Опозданий: ${escapeHtml(String(guest.late || 0))} · Отмен: ${escapeHtml(String(guest.cancelled || 0))}</div>
<div class="guest-last-booking">
	<span class="guest-last-booking-label">Последняя бронь</span>
	<span class="guest-last-booking-value">${escapeHtml(latestBookingLabel)}</span>
</div>
<div class="guest-rating-bar"><div class="guest-rating-fill" style="width:${Math.max(0, Math.min(100, Number(guest.rating || 0)))}%;background-color:${ratingColor};"></div></div>
<div class="guest-card-actions">
	<button type="button" class="guest-action-btn" onclick="openCustomerHistoryByPhone('${safePhoneArg}', '${safeNameArg}')">История клиента</button>
	${latestBookingButton}
</div>`;
container.appendChild(card);
});
if (!container.children.length) {
container.innerHTML = '<div class="audit-empty">Клиенты не найдены</div>';
}
}
function openActionModal(index) {
currentBookingIndex = index;
const booking = bookings[index];
const infoElement = document.getElementById('modalBookingInfo');
infoElement.textContent = `${booking.name} - ${booking.time} (${booking.pc})`;
document.getElementById('modal').style.display = 'flex';
}
async function markArrived() {
if (currentBookingIndex === null) return;
const b = bookings[currentBookingIndex];
const snapshotBookings = JSON.parse(JSON.stringify(bookings));
const snapshotDone = JSON.parse(JSON.stringify(done));
const snapshotRatings = JSON.parse(JSON.stringify(guestRatings));
if (b.phone) {
const guestRating = getOrCreateGuestRating(b.phone);
guestRating.total++;
guestRating.arrived++;
}
b.status = 'arrived';
b.updatedAt = new Date().toISOString();
done.push(b);
bookings.splice(currentBookingIndex, 1);
saveAll();
closeModal();
removeNotificationsByBookingId(b.id);
try {
await syncBookingStatus(b, 'arrived');
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
}
async function markLate() {
if (currentBookingIndex === null) return;
const b = bookings[currentBookingIndex];
const snapshotBookings = JSON.parse(JSON.stringify(bookings));
const snapshotDone = JSON.parse(JSON.stringify(done));
const snapshotRatings = JSON.parse(JSON.stringify(guestRatings));
if (b.phone) {
const guestRating = getOrCreateGuestRating(b.phone);
guestRating.total++;
guestRating.late++;
guestRating.rating = Math.max(0, guestRating.rating - config.rating.latePenalty);
}
b.status = 'late';
b.updatedAt = new Date().toISOString();
done.push(b);
bookings.splice(currentBookingIndex, 1);
saveAll();
closeModal();
removeNotificationsByBookingId(b.id);
try {
await syncBookingStatus(b, 'late');
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
}
async function markCancelled() {
if (currentBookingIndex === null) return;
const b = bookings[currentBookingIndex];
const snapshotBookings = JSON.parse(JSON.stringify(bookings));
const snapshotDone = JSON.parse(JSON.stringify(done));
const snapshotRatings = JSON.parse(JSON.stringify(guestRatings));
if (b.phone) {
const guestRating = getOrCreateGuestRating(b.phone);
guestRating.total++;
guestRating.cancelled++;
guestRating.rating = Math.max(0, guestRating.rating - config.rating.cancelledPenalty);
}
b.status = 'cancelled';
b.updatedAt = new Date().toISOString();
done.push(b);
bookings.splice(currentBookingIndex, 1);
saveAll();
closeModal();
removeNotificationsByBookingId(b.id);
try {
await syncBookingStatus(b, 'cancelled');
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
}
async function markNoShow() {
if (currentBookingIndex === null) return;
const b = bookings[currentBookingIndex];
const snapshotBookings = JSON.parse(JSON.stringify(bookings));
const snapshotDone = JSON.parse(JSON.stringify(done));
const snapshotRatings = JSON.parse(JSON.stringify(guestRatings));
if (b.phone) {
const guestRating = getOrCreateGuestRating(b.phone);
guestRating.total++;
guestRating.noShow++;
guestRating.rating = Math.max(0, guestRating.rating - config.rating.noShowPenalty);
}
b.status = 'no-show';
b.updatedAt = new Date().toISOString();
done.push(b);
bookings.splice(currentBookingIndex, 1);
saveAll();
closeModal();
removeNotificationsByBookingId(b.id);
try {
await syncBookingStatus(b, 'no-show');
} catch (_) {
bookings = snapshotBookings;
done = snapshotDone;
guestRatings = snapshotRatings;
saveAll();
notify('Ошибка синхронизации с сервером. Изменение отменено.', 'Ошибка');
}
}
function deleteBooking(i) {
confirmAction('Удалить бронь?', () => {
const removed = bookings[i];
bookings.splice(i, 1);
saveAll();
removeNotificationsByBookingId(removed.id);
syncDeleteBooking(removed).catch(() => {
bookings.splice(i, 0, removed);
saveAll();
notify('Ошибка синхронизации с сервером. Удаление отменено.', 'Ошибка');
});
}, 'Удаление');
}
document.getElementById('forceAddBtn').addEventListener('click', () => {
if (pendingForce && currentAdmin) {
pendingForce.addedBy = currentAdmin.name;
pendingForce.addedAt = new Date().toISOString();
const createdBooking = Object.assign({}, pendingForce);
bookings.push(pendingForce);
const {name, pc, time, dateDisplay, phone, prepay} = pendingForce;
pendingForce = null;
saveAll();
syncCreateBooking(createdBooking, true)
.then(() => {
const localMatch = bookings.find((b) => b.addedAt === createdBooking.addedAt && b.name === createdBooking.name && b.time === createdBooking.time && b.pc === createdBooking.pc);
if (localMatch) localMatch.id = createdBooking.id;
saveAll();
})
.catch(() => {
bookings = bookings.filter((b) => !(b.name === createdBooking.name && b.time === createdBooking.time && b.pc === createdBooking.pc));
saveAll();
notify('Ошибка синхронизации с сервером. Бронь отменена.', 'Ошибка');
});
sendWhatsAppBooking(name, pc, time, dateDisplay, phone, prepay);
closeWarn();
}
});
document.getElementById('bookingForm').addEventListener('submit', function(e) {
e.preventDefault();
let name = document.getElementById('name').value.trim();
if (!name) return showError('Введите имя');
name = pcBookingsModule.normalizeName(name);
let pcInput = document.getElementById('pc').value.trim();
let pcs = pcBookingsModule.parsePcList(pcInput);
const pcLimit = getCurrentPcCapacity();
if (!pcBookingsModule.isValidPcList(pcs, pcLimit)) {
return showError(`ПК от 1 до ${pcLimit}`);
}
const pc = pcs.join(',');
let timeRaw = document.getElementById('time').value.trim();
const time = pcBookingsModule.parseTimeHHMM(timeRaw);
if (!time) return showError('Время в формате HHMM');
const dateSelect = document.getElementById('date');
const dateValue = dateSelect.value;
const dateDisplay = dateSelect.options[dateSelect.selectedIndex].textContent;
if (!isBookingTimeValid(dateValue, time)) return showError('Нельзя забронировать на прошлое время');
const phoneDigits = getPhoneDigits();
if (phoneDigits.length !== 10) return showError('Телефон — 10 цифр');
const phone = formatPhone(phoneDigits);
let prepay = document.getElementById('prepay').value.trim();
if (prepay === '') prepay = 'Нет';
else if (!/^\d+$/.test(prepay)) return showError('Предоплата — цифры');
let conflict = false;
pcs.forEach(p => {
if (bookings.some(b => b.dateValue === dateValue && b.pc.split(',').map(x=>x.trim()).includes(p))) {
conflict = true;
}
});
if (conflict) {
pendingForce = {name, pc, time, dateValue, dateDisplay, phone, prepay, arrived:false, shift:0, pcStatuses: createPendingPCStatuses(pc)};
document.getElementById('warnModal').style.display = 'flex';
return;
}
bookings.push({
name, pc, time, dateValue, dateDisplay, phone, prepay, arrived:false, shift:0,
pcStatuses: createPendingPCStatuses(pc),
addedBy: currentAdmin ? currentAdmin.name : 'Неизвестно', 
addedAt: new Date().toISOString()
});
const createdBooking = bookings[bookings.length - 1];
saveAll();
syncCreateBooking(createdBooking).catch(() => {
bookings = bookings.filter((b) => b !== createdBooking);
saveAll();
notify('Ошибка синхронизации с сервером. Бронь отменена.', 'Ошибка');
});
sendWhatsAppBooking(name, pc, time, dateDisplay, phone, prepay);
this.reset();
phoneInput.value = '+7 ';
dateSelect.value = getLocalDateString(getCurrentLocalDate());
document.getElementById('addPanel').classList.remove('show');
});
document.addEventListener('DOMContentLoaded', () => {
setupSidebarDrawer();
const searchName = document.getElementById('searchName');
const searchPC = document.getElementById('searchPC');
const searchPhone = document.getElementById('searchPhone');
const searchDate = document.getElementById('searchDate');
const doneSearchName = document.getElementById('doneSearchName');
const doneSearchPhone = document.getElementById('doneSearchPhone');
const doneSearchPC = document.getElementById('doneSearchPC');
const doneSearchDate = document.getElementById('doneSearchDate');
const guestSearchInput = document.getElementById('guestSearchInput');
const loginInput = document.getElementById('loginInput');
	syncAuditDateRangeTrigger();
if (searchName) searchName.addEventListener('input', renderTable);
if (searchPC) searchPC.addEventListener('input', renderTable);
if (searchPhone) searchPhone.addEventListener('input', renderTable);
if (searchDate) searchDate.addEventListener('change', () => { renderTable(); updateCounter(); });
if (doneSearchName) doneSearchName.addEventListener('input', renderDone);
if (doneSearchPhone) doneSearchPhone.addEventListener('input', renderDone);
if (doneSearchPC) doneSearchPC.addEventListener('input', renderDone);
if (doneSearchDate) doneSearchDate.addEventListener('change', renderDone);
if (guestSearchInput) guestSearchInput.addEventListener('input', renderGuests);
const passwordInput = document.getElementById('passwordInput');
const repeatPassword = document.getElementById('repeatPassword');
const passwordMismatch = document.getElementById('passwordMismatch');
const checkPasswordMatch = () => {
if (repeatPassword.value.length > 0) {
if (passwordInput.value !== repeatPassword.value) {
passwordMismatch.style.display = 'block';
} else {
passwordMismatch.style.display = 'none';
}
} else {
passwordMismatch.style.display = 'none';
}
};
if (passwordInput && repeatPassword) {
passwordInput.addEventListener('input', checkPasswordMatch);
repeatPassword.addEventListener('input', checkPasswordMatch);
}
if (loginInput) loginInput.addEventListener('input', clearAuthInlineError);
if (passwordInput) passwordInput.addEventListener('input', clearAuthInlineError);
if (repeatPassword) repeatPassword.addEventListener('input', clearAuthInlineError);
if (document.getElementById('adminName')) document.getElementById('adminName').addEventListener('input', clearAuthInlineError);
});
renderTable();
renderDone();
renderGuests();
updateCounter();
document.addEventListener('click', (e) => {
const addPanel = document.getElementById('addPanel');
const searchPanel = document.getElementById('searchPanel');
const addBtn = document.querySelector('button[onclick="toggleAddPanel()"]');
const searchBtn = document.querySelector('button[onclick="toggleSearchPanel()"]');
	const auditDatePicker = document.getElementById('auditDatePicker');
if (addPanel && addPanel.classList.contains('show') && !addPanel.contains(e.target) && !addBtn.contains(e.target)) {
addPanel.classList.remove('show');
}
if (searchPanel && searchPanel.classList.contains('show') && !searchPanel.contains(e.target) && !searchBtn.contains(e.target)) {
searchPanel.classList.remove('show');
}
	if (auditDatePicker && !auditDatePicker.contains(e.target)) {
		closeAuditDateRangePopover();
	}
});
document.addEventListener('keydown', (e) => {
if (e.key === 'Escape') {
if (isSidebarDrawerMode()) closeSidebarDrawer();
	closeAuditDateRangePopover();
const subLock = document.getElementById('subscriptionBlockModal');
if (subLock && subLock.style.display === 'flex') return;
document.getElementById('addPanel').classList.remove('show');
document.getElementById('searchPanel').classList.remove('show');
document.getElementById('modal').style.display = 'none';
document.getElementById('pcStatusModal').style.display = 'none';
document.getElementById('warnModal').style.display = 'none';
document.getElementById('adminsModal').style.display = 'none';
document.getElementById('ownerStatsModal').style.display = 'none';
document.getElementById('quickBookingModal').style.display = 'none';
currentBookingIndex = null;
pendingForce = null;
}
});
document.getElementById('modal').addEventListener('click', (e) => {
if (e.target.id === 'modal') closeModal();
});
document.getElementById('pcStatusModal').addEventListener('click', (e) => {
if (e.target.id === 'pcStatusModal') closePCStatusModal();
});
document.getElementById('warnModal').addEventListener('click', (e) => {
if (e.target.id === 'warnModal') closeWarn();
});
document.getElementById('adminsModal').addEventListener('click', (e) => {
if (e.target.id === 'adminsModal') closeAdminsModal();
});
document.getElementById('quickBookingModal').addEventListener('click', (e) => {
if (e.target.id === 'quickBookingModal') closeQuickBooking();
});
const ROOT_LOGIN = config.root.login;
const ROOT_NAME = config.root.name;
if (currentAdmin) {
try {
const userName = currentAdmin.isRoot ? ROOT_NAME : currentAdmin.name;
document.getElementById('currentUser').textContent = userName;
document.getElementById('userPanel').style.display = 'flex';
syncSidebarDrawerForViewport();
updateManagementNavVisibility();
document.getElementById('authModal').style.display = 'none';
renderSubscriptionState();

// Предотвратить навигацию браузера назад к странице логирования
window.history.pushState(null, null, window.location.href);
window.addEventListener('popstate', function(event) {
window.history.pushState(null, null, window.location.href);
});
} catch (e) {
currentAdmin = null;
storage.saveCurrentAdmin(state);
saveSessionAdmin(null);
}
}
document.getElementById('switchMode').addEventListener('click', function() {
if (isInviteFlow()) return;
if (document.getElementById('authTitle').textContent === 'Вход') {
document.getElementById('authTitle').textContent = 'Регистрация';
document.getElementById('repeatPasswordField').style.display = 'block';
document.getElementById('nameField').style.display = 'block';
document.getElementById('authBtn').textContent = 'Зарегистрироваться';
this.textContent = 'Уже есть аккаунт? Войти';
document.getElementById('repeatPassword').value = '';
document.getElementById('adminName').value = '';
document.getElementById('passwordMismatch').style.display = 'none';
clearAuthInlineError();
} else {
document.getElementById('authTitle').textContent = 'Вход';
document.getElementById('repeatPasswordField').style.display = 'none';
document.getElementById('nameField').style.display = 'none';
document.getElementById('authBtn').textContent = 'Войти';
this.textContent = 'Нет аккаунта? Зарегистрироваться';
document.getElementById('passwordMismatch').style.display = 'none';
clearAuthInlineError();
}
});

function setupAuthModeByContext() {
const switchModeEl = document.getElementById('switchMode');
if (!switchModeEl) return;
 clearAuthInlineError();

if (!isInviteFlow()) {
document.getElementById('authTitle').textContent = 'Вход';
document.getElementById('repeatPasswordField').style.display = 'none';
document.getElementById('nameField').style.display = 'none';
document.getElementById('authBtn').textContent = 'Войти';
switchModeEl.style.display = 'none';
return;
}

document.getElementById('authTitle').textContent = 'Регистрация';
document.getElementById('repeatPasswordField').style.display = 'block';
document.getElementById('nameField').style.display = 'block';
document.getElementById('authBtn').textContent = inviteContext.mode === INVITE_MODE_OWNER
? 'Активировать владельца'
: 'Зарегистрироваться';
switchModeEl.style.display = 'none';
}

async function resolveInviteContext() {
if (!isInviteFlow()) return;
const info = await apiRequest(`/public/invites?token=${encodeURIComponent(inviteContext.token)}`);
inviteContext.resolved = info;
if (!clubContext.slug && info && info.club_slug) {
clubContext.slug = info.club_slug;
}
}
async function performClubLogin(login, pass, force = false) {
const authData = await apiRequest('/auth/login', {
method: 'POST',
body: JSON.stringify({ login, password: pass, force })
});
setAuthToken(authData.token);
const user = authData.admin;
if (!user || (user.role !== CLUB_ADMIN_ROLE && user.role !== CLUB_OWNER_ROLE)) {
clearAuthToken();
throw new Error(`Вход разрешён только для аккаунтов клуба (получена роль: ${user && user.role ? user.role : 'UNKNOWN'})`);
}
if (!clubContext.id) {
clearAuthToken();
throw new Error('Не удалось определить клуб по ссылке');
}
if (Number(user.club_id) !== Number(clubContext.id)) {
clearAuthToken();
throw new Error('Этот аккаунт принадлежит другому клубу');
}
currentAdmin = {
id: user.id,
login: user.login,
name: user.name,
isRoot: !!user.is_root,
isClubOwner: !!user.is_club_owner,
clubId: user.club_id,
role: user.role
};
if (authData && authData.subscription) {
clubContext.subscription = resolveSubscriptionState(authData.subscription);
}
pendingForceAdminLogin = null;
clearAuthInlineError();
storage.saveCurrentAdmin(state);
saveSessionAdmin(currentAdmin);
const userName = currentAdmin.isRoot ? ROOT_NAME : user.name;
document.getElementById('currentUser').textContent = userName;
document.getElementById('userPanel').style.display = 'flex';
syncSidebarDrawerForViewport();
updateManagementNavVisibility();
document.getElementById('authModal').style.display = 'none';
renderSubscriptionState();
enforceSubscriptionLock();
try {
await syncStateFromBackend();
} catch (_) {
}
renderSubscriptionState();
enforceSubscriptionLock();
ensurePreferredPlatform();
if (currentPlatform === 'ps') renderPSConsoles();
else renderTable();
}
document.getElementById('authBtn').addEventListener('click', async function() {
const login = document.getElementById('loginInput').value.trim();
const pass = document.getElementById('passwordInput').value;
clearAuthInlineError();
if (document.getElementById('authTitle').textContent === 'Регистрация') {
const repeat = document.getElementById('repeatPassword').value;
const name = document.getElementById('adminName').value.trim();
if (!login || !pass || !repeat || !name) return showAuthInlineError('Заполните все поля');
if (pass !== repeat) {
document.getElementById('passwordMismatch').style.display = 'block';
return showAuthInlineError('Пароли не совпадают');
}
document.getElementById('passwordMismatch').style.display = 'none';
if (pass.length < 3) return showAuthInlineError('Пароль должен быть минимум 3 символа');
try {
if (!isInviteFlow()) {
throw new Error('Регистрация доступна только по invite-ссылке.');
}

const endpoint = inviteContext.mode === INVITE_MODE_OWNER ? '/public/activate-owner' : '/public/register';
const created = await apiRequest(endpoint, {
method: 'POST',
body: JSON.stringify({ token: inviteContext.token, login, password: pass, name })
});

const destination = created && created.club_link ? created.club_link : (inviteContext.resolved && inviteContext.resolved.club_link ? inviteContext.resolved.club_link : null);
if (inviteContext.mode === INVITE_MODE_OWNER) {
notify('✅ Владелец клуба активирован. Теперь выполните вход.', 'Успешно');
} else {
notify('✅ Администратор зарегистрирован. Теперь выполните вход.', 'Успешно');
}

if (destination) {
window.location.href = destination;
return;
}
} catch (err) {
return showAuthInlineError(err.message || 'Ошибка регистрации');
}
clearAuthInlineError();
document.getElementById('authTitle').textContent = 'Вход';
document.getElementById('repeatPasswordField').style.display = 'none';
document.getElementById('nameField').style.display = 'none';
document.getElementById('authBtn').textContent = 'Войти';
document.getElementById('switchMode').textContent = 'Нет аккаунта? Зарегистрироваться';
document.getElementById('loginInput').value = '';
document.getElementById('passwordInput').value = '';
document.getElementById('repeatPassword').value = '';
document.getElementById('adminName').value = '';
document.getElementById('passwordMismatch').style.display = 'none';
} else {
try {
const shouldForceLogin = Boolean(
pendingForceAdminLogin &&
pendingForceAdminLogin.login === login &&
pendingForceAdminLogin.password === pass
);
await performClubLogin(login, pass, shouldForceLogin);
} catch (err) {
if (err && err.code === 'ADMIN_SESSION_ACTIVE') {
pendingForceAdminLogin = null;
showAuthInlineError('В этом клубе уже работает другой администратор. Одновременно может быть только один администратор.');
return;
}
if (err && err.code === 'ADMIN_ALREADY_LOGGED_IN') {
pendingForceAdminLogin = { login, password: pass };
showAuthInlineError('Этот администратор уже находится в активной сессии. Нажмите "Войти" еще раз, чтобы завершить прошлую сессию и войти здесь.');
return;
}
pendingForceAdminLogin = null;
showAuthInlineError(err.message || 'Неверный логин или пароль');
}
}
});
async function logout() {
try {
if (getAuthToken()) await apiRequest('/auth/logout', { method: 'POST' });
} catch (error) {
reportClientError('Не удалось завершить сессию на сервере', error, { silent: true });
}
stopBookingNotificationMonitoring();
clearAuthToken();
currentAdmin = null;
storage.saveCurrentAdmin(state);
saveSessionAdmin(null);
document.getElementById('userPanel').style.display = 'none';
closeSidebarDrawer();
updateManagementNavVisibility();
document.getElementById('authModal').style.display = 'flex';
document.getElementById('loginInput').value = '';
document.getElementById('passwordInput').value = '';
document.getElementById('repeatPassword').value = '';
document.getElementById('adminName').value = '';
clearAuthInlineError();
document.getElementById('authTitle').textContent = 'Вход';
document.getElementById('repeatPasswordField').style.display = 'none';
document.getElementById('nameField').style.display = 'none';
document.getElementById('authBtn').textContent = 'Войти';
document.getElementById('switchMode').textContent = 'Нет аккаунта? Зарегистрироваться';
document.getElementById('mainContent').style.display = 'block';
document.getElementById('donePage').style.display = 'none';
document.getElementById('guestsPage').style.display = 'none';
renderSubscriptionState();
setupAuthModeByContext();
redirectToLoginScreen();
}
async function showAdmins() {
if (!canManageClub()) {
notify('❌ Только владелец клуба может управлять администраторами', 'Ошибка');
return;
}
const inviteField = document.getElementById('adminsPageInviteLink');
if (inviteField) inviteField.value = '';
try {
const listFromApi = await apiRequest('/admins');
admins = listFromApi.map((a) => ({
id: a.id,
login: a.login,
name: a.name,
isRoot: !!a.is_root,
isClubOwner: !!a.is_club_owner,
role: a.is_club_owner ? CLUB_OWNER_ROLE : CLUB_ADMIN_ROLE,
created: a.created_at
}));
storage.saveAdmins(state);
} catch (error) {
reportClientError('Не удалось загрузить список администраторов', error);
return;
}
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('adminBtn').classList.add('active');

const list = document.getElementById('adminsPageList');
list.innerHTML = '';
admins.forEach(a => {
const div = document.createElement('div');
div.className = 'admin-item admin-item--clickable';
const headerRow = document.createElement('div');
headerRow.className = 'admin-item-header';
const strong = document.createElement('strong');
strong.textContent = a.isRoot ? ROOT_NAME : a.name;
headerRow.appendChild(strong);
if (a.isRoot) {
const badge = document.createElement('span');
badge.className = 'root-badge';
badge.textContent = 'ROOT';
headerRow.appendChild(badge);
}
if (a.isClubOwner) {
const badge = document.createElement('span');
badge.className = 'root-badge';
badge.textContent = 'OWNER';
headerRow.appendChild(badge);
}
div.appendChild(headerRow);
const login = document.createElement('small');
login.textContent = `Логин: ${a.login}`;
div.appendChild(login);
const role = document.createElement('small');
role.textContent = `Роль: ${a.isRoot ? 'ROOT' : (a.isClubOwner ? 'OWNER' : 'ADMIN')}`;
div.appendChild(role);
const created = document.createElement('small');
created.textContent = `Создан: ${new Date(a.created).toLocaleString('ru-RU')}`;
div.appendChild(created);
const actRow = document.createElement('div');
actRow.className = 'admin-item-actions';
const statsBtn = document.createElement('button');
statsBtn.type = 'button';
statsBtn.className = 'btn-admin-stats';
statsBtn.textContent = 'Статистика';
statsBtn.addEventListener('click', (e) => {
e.stopPropagation();
toggleAdminStatsDropdown(div, a, statsBtn);
});
actRow.appendChild(statsBtn);
if (!a.isRoot && !a.isClubOwner) {
const delBtn = document.createElement('button');
delBtn.type = 'button';
delBtn.className = 'btn-admin-delete';
delBtn.textContent = 'Удалить';
delBtn.addEventListener('click', (e) => {
e.stopPropagation();
deleteAdmin(a.id);
});
actRow.appendChild(delBtn);
}
div.appendChild(actRow);

const dropdown = document.createElement('div');
dropdown.className = 'admin-item-dropdown';
div.appendChild(dropdown);

list.appendChild(div);
});
}
function deleteAdmin(adminId) {
if (!canManageClub()) {
notify('❌ Только владелец клуба может удалять админов!', 'Ошибка');
return;
}
const adminToDelete = admins.find(a => a.id === adminId);
if (!adminToDelete) {
notify('❌ Администратор не найден', 'Ошибка');
return;
}
if (adminToDelete.isRoot || adminToDelete.isClubOwner) {
notify('❌ Этот аккаунт удалить нельзя!', 'Ошибка');
return;
}
confirmAction(`⚠️ ВНИМАНИЕ!\n\nУдалить администратора "${adminToDelete.name}" (${adminToDelete.login})?\n\nЭто действие невозможно отменить!`, () => {
apiRequest(`/admins/${adminId}`, { method: 'DELETE' })
.then(() => {
admins = admins.filter(a => a.id !== adminId);
storage.saveAdmins(state);
notify('✅ Администратор удален', 'Успешно');
showAdmins();
})
.catch((err) => notify(err.message || 'Ошибка удаления администратора', 'Ошибка'));
}, 'Удаление администратора');
}
function closeAdminsModal() {
document.getElementById('adminsModal').style.display = 'none';
}

async function generateAdminInvite() {
if (!isClubOwner()) {
notify('❌ Только владелец клуба может создавать invite-ссылки', 'Ошибка');
return;
}

if (!clubContext.id) {
notify('❌ Не удалось определить клуб', 'Ошибка');
return;
}

try {
const response = await apiRequest('/admins/invites', {
method: 'POST',
body: JSON.stringify({ club_id: clubContext.id })
});
const input = document.getElementById('adminsPageInviteLink');
if (input) input.value = response.register_link || '';
showAdminInviteNotification('Invite для администратора создан');
} catch (error) {
notify(error.message || 'Ошибка создания invite', 'Ошибка');
}
}

function copyAdminInviteLink() {
const input = document.getElementById('adminsPageInviteLink');
const value = input ? String(input.value || '').trim() : '';
if (!value) return;

const copyFallback = function(text) {
const textarea = document.createElement('textarea');
textarea.value = text;
textarea.setAttribute('readonly', 'readonly');
textarea.style.position = 'fixed';
textarea.style.opacity = '0';
textarea.style.pointerEvents = 'none';
document.body.appendChild(textarea);
textarea.select();
textarea.setSelectionRange(0, textarea.value.length);
let copied = false;
try {
copied = document.execCommand('copy');
} catch (e) {
copied = false;
}
document.body.removeChild(textarea);
return copied;
};

const canUseClipboardApi = window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function';
if (canUseClipboardApi) {
navigator.clipboard.writeText(value)
.then(() => showAdminInviteNotification('Invite ссылка скопирована'))
.catch(() => {
if (copyFallback(value)) {
showAdminInviteNotification('Invite ссылка скопирована');
return;
}
notify('❌ Не удалось скопировать invite-ссылку', 'Ошибка');
});
return;
}
if (copyFallback(value)) {
showAdminInviteNotification('Invite ссылка скопирована');
} else {
notify('❌ Не удалось скопировать invite-ссылку', 'Ошибка');
}
}
function getAdminStatsData(a) {
const activeList = Array.isArray(state.bookings) ? state.bookings : [];
const doneList = Array.isArray(state.done) ? state.done : [];
const matchesAdmin = function(record) {
if (!record) return false;
const addedBy = String(record.addedBy || '').trim();
if (!addedBy) return false;
if (addedBy === a.name) return true;
if (a.isRoot && addedBy === ROOT_NAME) return true;
return false;
};
const myActive = activeList.filter(matchesAdmin);
const myDone = doneList.filter(matchesAdmin);
let prepaySum = 0;
[...myActive, ...myDone].forEach((b) => {
const raw = String(b.prepay || '').trim().replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
const val = Number(raw);
if (!Number.isNaN(val) && val > 0) prepaySum += val;
});
return {
total: myActive.length + myDone.length,
active: myActive.length,
prepaySum: Math.round(prepaySum),
arrived: myDone.filter((b) => b.status === 'arrived').length,
late: myDone.filter((b) => b.status === 'late').length,
cancelled: myDone.filter((b) => b.status === 'cancelled').length,
noShow: myDone.filter((b) => b.status === 'no-show').length
};
}

function renderAdminStatsDropdown(target, a) {
const stats = getAdminStatsData(a);
target.innerHTML = '';

const grid = document.createElement('div');
grid.className = 'admin-stats-grid';
[
{ label: 'Всего броней', value: stats.total },
{ label: 'Активных', value: stats.active },
{ label: 'Сумма предоплат', value: `${stats.prepaySum} ₸` }
].forEach((item) => {
const card = document.createElement('div');
card.className = 'admin-stat-card';
card.innerHTML = `<div class="admin-stat-value">${item.value}</div><div class="admin-stat-label">${item.label}</div>`;
grid.appendChild(card);
});
target.appendChild(grid);

const row = document.createElement('div');
row.className = 'admin-stats-status-row';
[
{ label: 'Пришёл', value: stats.arrived, cls: 'status-arrived' },
{ label: 'Опоздал', value: stats.late, cls: 'status-late' },
{ label: 'Отменён', value: stats.cancelled, cls: 'status-cancelled' },
{ label: 'Не пришёл', value: stats.noShow, cls: 'status-noshow' }
].forEach((item) => {
const chip = document.createElement('div');
chip.className = `admin-status-chip ${item.cls}`;
chip.innerHTML = `<span class="admin-status-chip-val">${item.value}</span><span class="admin-status-chip-lbl">${item.label}</span>`;
row.appendChild(chip);
});
target.appendChild(row);
}

function toggleAdminStatsDropdown(card, a, button) {
const dropdown = card.querySelector('.admin-item-dropdown');
if (!dropdown) return;
const opened = card.classList.contains('admin-item-open');
document.querySelectorAll('#adminsPageList .admin-item-open').forEach((node) => {
node.classList.remove('admin-item-open');
const btn = node.querySelector('.btn-admin-stats');
if (btn) btn.textContent = 'Статистика';
});
if (opened) {
return;
}
renderAdminStatsDropdown(dropdown, a);
card.classList.add('admin-item-open');
button.textContent = 'Скрыть';
}

function mapServerStatsToCards(stats) {
return [
{ value: Number(stats.total_bookings || 0), label: 'Всего броней' },
{ value: Number(stats.done_arrived || 0), label: 'Завершены с приходом' },
{ value: Number(stats.done_late || 0), label: 'Опоздания' },
{ value: Number(stats.done_cancelled || 0), label: 'Отмены' },
{ value: Number(stats.done_no_show || 0), label: 'Неявки' },
{ value: Number(stats.guests_total || 0), label: 'Гостей в рейтинге' }
];
}

function buildLocalOwnerStatsSnapshot() {
const doneList = Array.isArray(done) ? done : [];
const activeList = Array.isArray(bookings) ? bookings : [];
const psList = Array.isArray(psConsoles) ? psConsoles : [];
const adminsList = Array.isArray(admins) ? admins : [];
const ratings = guestRatings && typeof guestRatings === 'object' ? Object.keys(guestRatings).length : 0;

return {
total_bookings: activeList.length + doneList.length,
active_bookings: activeList.length,
done_arrived: doneList.filter((b) => b.status === 'arrived').length,
done_late: doneList.filter((b) => b.status === 'late').length,
done_cancelled: doneList.filter((b) => b.status === 'cancelled').length,
done_no_show: doneList.filter((b) => b.status === 'no-show').length,
guests_total: ratings,
admins_total: adminsList.length,
active_ps_sessions: psList.filter((ps) => ps.status === 'active' || ps.status === 'warning').length
};
}

function getOwnerStatsIconSvg(label) {
switch (label) {
case 'Всего броней':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="1" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><line x1="4.5" y1="4.5" x2="9.5" y2="4.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4.5" y1="7" x2="9.5" y2="7" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="4.5" y1="9.5" x2="7.5" y2="9.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>';
case 'Завершены с приходом':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.2 7.2L6.2 9.2L9.8 5.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
case 'Опоздания':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M7 3.6V7L9.5 8.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
case 'Отмены':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.7 4.7L9.3 9.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M9.3 4.7L4.7 9.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
case 'Неявки':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.5 7h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
case 'Гостей в рейтинге':
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="4.5" r="2.4" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M2 12c0-2.45 2-4.4 4.5-4.4S11 9.55 11 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';
default:
return '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M4.2 9.2h5.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
}
}

function renderOwnerStatsCards(cards) {
const content = document.getElementById('ownerStatsPageContent');
if (!content) return;
content.innerHTML = '';
cards.forEach((item) => {
const card = document.createElement('div');
card.className = 'owner-stat-card stat-card';
card.innerHTML = `<div class="stat-card-icon">${getOwnerStatsIconSvg(item.label)}</div><div class="stat-card-value">${item.value}</div><div class="stat-card-label">${item.label}</div>`;
content.appendChild(card);
});
}

function buildOwnerBookingInsights() {
const allBookings = [
...(Array.isArray(bookings) ? bookings : []),
...(Array.isArray(done) ? done : [])
].filter((b) => b && b.pc && b.time && b.dateValue);

const parseBookingPrepaymentAmount = (value) => {
  if (value === null || value === undefined) return 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === 'нет' || normalized === '0' || normalized === 'false') return 0;
  const numeric = Number.parseFloat(normalized.replace(',', '.').replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
};

const formatDateShortRu = (dateValue) => {
  const raw = String(dateValue || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${m[3]}.${m[2]}`;
};

const formatLocalDateKey = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const guestRatingsList = Object.values(guestRatings || {});
const now = new Date();
const todayKey = formatLocalDateKey(now);

// Get current calendar week (Monday to Sunday)
const weekStart = new Date(now);
const dayOfWeek = now.getDay();
// dayOfWeek: 0=Sunday, 1=Monday, ..., 6=Saturday
// We want to start from Monday, so go back (dayOfWeek - 1) days, or -6 if Sunday
if (dayOfWeek === 0) {
  weekStart.setDate(now.getDate() - 6);
} else {
  weekStart.setDate(now.getDate() - (dayOfWeek - 1));
}
weekStart.setHours(0, 0, 0, 0);
const weekEnd = new Date(weekStart);
weekEnd.setDate(weekStart.getDate() + 6);
weekEnd.setHours(23, 59, 59, 999);

// Get current month (1st to last day)
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
monthStart.setHours(0, 0, 0, 0);

// Filter bookings by calendar periods
const weekPcBookings = allBookings.filter((b) => {
  const bDate = new Date(`${b.dateValue}T00:00:00`);
  return !Number.isNaN(bDate.getTime()) && bDate >= weekStart && bDate <= weekEnd;
});

const monthPcBookings = allBookings.filter((b) => {
  const bDate = new Date(`${b.dateValue}T00:00:00`);
  return !Number.isNaN(bDate.getTime()) && 
         bDate.getFullYear() === now.getFullYear() && 
         bDate.getMonth() === now.getMonth();
});

// Calculate PC counts for week, month and all-time
const calculatePcCounts = (bookingsArray) => {
const pcCounts = new Map();
bookingsArray.forEach((booking) => {
String(booking.pc)
.split(',')
.map((value) => String(value || '').trim())
.filter(Boolean)
.forEach((pc) => {
pcCounts.set(pc, (pcCounts.get(pc) || 0) + 1);
});
});
return Array.from(pcCounts.entries())
.sort((a, b) => {
if (b[1] !== a[1]) return b[1] - a[1];
const aNum = Number(a[0]);
const bNum = Number(b[0]);
if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
return String(a[0]).localeCompare(String(b[0]), 'ru-RU');
})
.slice(0, 10)
.map((entry) => ({ pc: entry[0], count: entry[1] }));
};

const topPcsLastWeek = calculatePcCounts(weekPcBookings);
const topPcsLastMonth = calculatePcCounts(monthPcBookings);
const topPcsAllTime = calculatePcCounts(allBookings);

// Calculate today's peak interval by 2-hour windows
const twoHourCounts = new Map();
allBookings.forEach((booking) => {
if (String(booking.dateValue || '').trim() !== todayKey) return;
const hourPart = Number.parseInt(String(booking.time).split(':')[0], 10);
if (!Number.isInteger(hourPart) || hourPart < 0 || hourPart > 23) return;
const slotStartHour = Math.floor(hourPart / 2) * 2;
twoHourCounts.set(slotStartHour, (twoHourCounts.get(slotStartHour) || 0) + 1);
});

const peakHourEntry = Array.from(twoHourCounts.entries()).sort((a, b) => {
if (b[1] !== a[1]) return b[1] - a[1];
return a[0] - b[0];
})[0] || null;

let peakInterval = '—';
let peakCount = 0;
if (peakHourEntry) {
const hour = Number(peakHourEntry[0]);
const toHour = Math.min(23, hour + 1);
const from = `${String(hour).padStart(2, '0')}:00`;
const to = `${String(toHour).padStart(2, '0')}:59`;
peakInterval = `${from} - ${to}`;
peakCount = peakHourEntry[1];
}

// Calculate weekly bookings for current calendar week (Monday -> Sunday)
const weekdaysRuMonFirst = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const weeklyBookings = weekdaysRuMonFirst.map((name, index) => {
  const date = new Date(weekStart);
  date.setDate(weekStart.getDate() + index);
  const dateStr = formatLocalDateKey(date);
  const isCurrent = dateStr === todayKey;
  return { name, count: 0, isCurrent, dateStr };
});

const weeklyBookingsByDate = new Map(weeklyBookings.map((item) => [item.dateStr, item]));

const weeklyPrepayments = weekdaysRuMonFirst.map((name, index) => {
  const date = new Date(weekStart);
  date.setDate(weekStart.getDate() + index);
  const dateStr = formatLocalDateKey(date);
  const isCurrent = dateStr === todayKey;
  return { name, amount: 0, isCurrent, dateStr, dateShort: formatDateShortRu(dateStr) };
});
const weeklyPrepaymentsByDate = new Map(weeklyPrepayments.map((item) => [item.dateStr, item]));

allBookings.forEach((booking) => {
  const bDate = new Date(`${booking.dateValue}T00:00:00`);
  if (Number.isNaN(bDate.getTime()) || bDate < weekStart || bDate > weekEnd) return;
  const dateStr = formatLocalDateKey(bDate);
  const dayEntry = weeklyBookingsByDate.get(dateStr);
  if (dayEntry) {
    dayEntry.count++;
  }

  const prepaymentAmount = parseBookingPrepaymentAmount(booking.prepay);
  if (prepaymentAmount > 0) {
    const prepayEntry = weeklyPrepaymentsByDate.get(dateStr);
    if (prepayEntry) {
      prepayEntry.amount += prepaymentAmount;
    }
  }
});

// Calculate client ratings
const latestBookingsByPhone = new Map();
allBookings
.slice()
.sort((a, b) => new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime())
.forEach((booking) => {
const phoneKey = cleanPhone(booking.phone || '');
if (!phoneKey) return;
if (!latestBookingsByPhone.has(phoneKey)) {
latestBookingsByPhone.set(phoneKey, booking);
}
});

const clientsByRating = guestRatingsList
.map((guest) => {
const phoneRaw = String(guest.phone || '').trim();
const phoneKey = cleanPhone(phoneRaw);
if (!phoneKey) return null;
const latestBooking = latestBookingsByPhone.get(phoneKey) || null;
const name = String((latestBooking && latestBooking.name) || 'Неизвестный').trim();
const ratingValue = Number(guest.rating || 0);
return {
phoneRaw,
phoneKey,
name: name || 'Неизвестный',
rating: Number.isFinite(ratingValue) ? ratingValue : 0
};
})
.filter(Boolean);

const topClients = clientsByRating
.slice()
.sort((a, b) => {
if (b.rating !== a.rating) return b.rating - a.rating;
return a.name.localeCompare(b.name, 'ru-RU');
})
.slice(0, 10);

const worstClients = clientsByRating
.slice()
.filter((item) => item.rating < 100)
.sort((a, b) => {
if (a.rating !== b.rating) return a.rating - b.rating;
return a.name.localeCompare(b.name, 'ru-RU');
})
.slice(0, 10);

return {
total: allBookings.length,
topPcsLastWeek,
topPcsLastMonth,
topPcsAllTime,
peakInterval,
peakCount,
weeklyBookings,
weeklyPrepayments,
topClients,
worstClients
};
}

function renderOwnerStatsInsights(insights) {
const card1 = document.getElementById('ownerAnalyticsCard1');
const card2 = document.getElementById('ownerAnalyticsCard2');
const card3 = document.getElementById('ownerAnalyticsCard3');
const card4 = document.getElementById('ownerAnalyticsCard4');

if (!card1 || !card2 || !card3 || !card4) return;

if (!insights || !insights.total) {
const emptyMsg = '<div class="owner-insight-empty">Недостаточно данных</div>';
card1.innerHTML = emptyMsg;
card2.innerHTML = emptyMsg;
card3.innerHTML = emptyMsg;
card4.innerHTML = emptyMsg;
return;
}

// Card 1: Top PCs
const topPcsWeekHtml = insights.topPcsLastWeek && insights.topPcsLastWeek.length > 0
? `<ol class="owner-top-list">${insights.topPcsLastWeek.map((item) => `<li><span>ПК ${escapeHtml(item.pc)}</span><strong>${item.count}</strong></li>`).join('')}</ol>`
: '<div class="owner-insight-empty">Нет данных</div>';

const topPcsHtml = insights.topPcsLastMonth && insights.topPcsLastMonth.length > 0
? `<ol class="owner-top-list">${insights.topPcsLastMonth.map((item) => `<li><span>ПК ${escapeHtml(item.pc)}</span><strong>${item.count}</strong></li>`).join('')}</ol>`
: '<div class="owner-insight-empty">Нет данных</div>';

const topPcsAllTimeHtml = insights.topPcsAllTime && insights.topPcsAllTime.length > 0
? `<ol class="owner-top-list">${insights.topPcsAllTime.map((item) => `<li><span>ПК ${escapeHtml(item.pc)}</span><strong>${item.count}</strong></li>`).join('')}</ol>`
: '<div class="owner-insight-empty">Нет данных</div>';

card1.innerHTML = `
<div class="owner-time-toggle-inline">
  <button type="button" class="owner-time-toggle-small ${ownerStatsUiState.pcRange === 'week' ? 'active' : ''}" onclick="togglePcTimeRangeInline(this, 'week', 'ownerAnalyticsCard1')">Неделя</button>
  <button type="button" class="owner-time-toggle-small ${ownerStatsUiState.pcRange === 'month' ? 'active' : ''}" onclick="togglePcTimeRangeInline(this, 'month', 'ownerAnalyticsCard1')">Месяц</button>
  <button type="button" class="owner-time-toggle-small ${ownerStatsUiState.pcRange === 'all-time' ? 'active' : ''}" onclick="togglePcTimeRangeInline(this, 'all-time', 'ownerAnalyticsCard1')">Всё время</button>
</div>
<div class="owner-pcs-week-inline" style="display:${ownerStatsUiState.pcRange === 'week' ? '' : 'none'};">
  ${topPcsWeekHtml}
</div>
<div class="owner-pcs-month-inline" style="display:${ownerStatsUiState.pcRange === 'month' ? '' : 'none'};">
  ${topPcsHtml}
</div>
<div class="owner-pcs-all-time-inline" style="display:${ownerStatsUiState.pcRange === 'all-time' ? '' : 'none'};">
  ${topPcsAllTimeHtml}
</div>
`;

// Card 2: Guest Ratings
const renderClientListItems = (items) => items.map((item) => {
const safePhoneArg = String(item.phoneRaw || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeNameArg = String(item.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
return `<li><button type="button" class="audit-booking-link" onclick="openCustomerHistoryByPhone('${safePhoneArg}', '${safeNameArg}')">${escapeHtml(item.name)}</button><strong>${Math.round(item.rating)}%</strong></li>`;
}).join('');

const buildCollapsibleClientList = (items, listKey, isExpanded) => {
if (!Array.isArray(items) || items.length === 0) {
return '<div class="owner-insight-empty">Нет данных</div>';
}
const initial = items.slice(0, 5);
const extra = items.slice(5);
const initialHtml = `<ol class="owner-clients-list">${renderClientListItems(initial)}</ol>`;
if (extra.length === 0) {
return initialHtml;
}
const extraHtml = `<div class="owner-clients-more" style="display:${isExpanded ? '' : 'none'};"><ol class="owner-clients-list">${renderClientListItems(extra)}</ol></div>`;
const expandBtn = `<button type="button" class="owner-clients-expand-btn ${isExpanded ? 'is-expanded' : ''}" onclick="toggleClientListExpand(this)" aria-expanded="${isExpanded ? 'true' : 'false'}" title="Показать еще"><span class="owner-clients-expand-arrow">▾</span></button>`;
return `<div class="owner-clients-collapsible" data-list-key="${listKey}">${initialHtml}${extraHtml}${expandBtn}</div>`;
};

const topClientsHtml = buildCollapsibleClientList(insights.topClients, 'top', !!ownerStatsUiState.topClientsExpanded);
const worstClientsHtml = buildCollapsibleClientList(insights.worstClients, 'worst', !!ownerStatsUiState.worstClientsExpanded);

card2.innerHTML = `
<div class="owner-rating-section">
  <div class="owner-rating-label">Лучшие:</div>
  ${topClientsHtml}
</div>
<div class="owner-rating-section">
  <div class="owner-rating-label">Проблемные:</div>
  ${worstClientsHtml}
</div>
`;

// Card 3: Weekly Bookings
const weeklyHtml = Array.isArray(insights.weeklyBookings) && insights.weeklyBookings.length > 0
? `<div class="owner-weekly-grid">${insights.weeklyBookings.map((day) => `
<div class="owner-weekly-day ${day.isCurrent ? 'is-current' : ''}">
  <div class="owner-weekly-name">${escapeHtml(day.name)}</div>
  <div class="owner-weekly-count">${day.count}</div>
</div>
`).join('')}</div>`
: '<div class="owner-insight-empty">Нет данных</div>';

const peakIntervalHtml = `
<div class="owner-peak-info">
  <div class="owner-peak-label">Максимум броней на сегодня в промежутке:</div>
  <div class="owner-peak-time">${escapeHtml(insights.peakInterval)}</div>
  <div class="owner-peak-count">Броней: ${insights.peakCount}</div>
</div>
`;

card3.innerHTML = `
${weeklyHtml}
${peakIntervalHtml}
`;

// Card 4: Weekly prepayments (vertical weekdays)
const weeklyPrepaymentsHtml = Array.isArray(insights.weeklyPrepayments) && insights.weeklyPrepayments.length > 0
? `<div class="owner-weekly-prepay-list">${insights.weeklyPrepayments.map((day) => `
<button type="button" class="owner-weekly-prepay-row ${day.isCurrent ? 'is-current' : ''}" onclick="openOwnerPrepayDayModal('${String(day.dateStr || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${String(day.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${String(day.dateShort || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">
  <span class="owner-weekly-prepay-name-wrap"><span class="owner-weekly-prepay-name">${escapeHtml(day.name)}</span><span class="owner-weekly-prepay-date">${escapeHtml(day.dateShort || '')}</span></span>
  <strong class="owner-weekly-prepay-count">${Math.round(day.amount || 0).toLocaleString('ru-RU')} ₸</strong>
</button>
`).join('')}</div>`
: '<div class="owner-insight-empty">Нет данных</div>';

card4.innerHTML = weeklyPrepaymentsHtml;
}

function toggleAccordionBox(headerElement) {
const box = headerElement.closest('.owner-accordion-box');
if (!box) return;

const isExpanded = box.classList.contains('is-expanded');
const icon = headerElement.querySelector('.owner-accordion-icon');
const content = box.querySelector('.owner-accordion-content');

if (isExpanded) {
box.classList.remove('is-expanded');
if (icon) icon.textContent = '▸';
if (content) {
content.style.maxHeight = '0';
}
} else {
box.classList.add('is-expanded');
if (icon) icon.textContent = '▾';
if (content) {
setTimeout(() => {
content.style.maxHeight = content.scrollHeight + 'px';
}, 0);
}
}
}

function togglePcTimeRangeInline(buttonElement, range, cardId) {
const card = document.getElementById(cardId);
if (!card) return;

const weekContainer = card.querySelector('.owner-pcs-week-inline');
const monthContainer = card.querySelector('.owner-pcs-month-inline');
const allTimeContainer = card.querySelector('.owner-pcs-all-time-inline');
const buttons = card.querySelectorAll('.owner-time-toggle-small');

buttons.forEach((btn) => btn.classList.remove('active'));
buttonElement.classList.add('active');

if (weekContainer) weekContainer.style.display = 'none';
if (monthContainer) monthContainer.style.display = 'none';
if (allTimeContainer) allTimeContainer.style.display = 'none';

if (range === 'week') {
if (weekContainer) weekContainer.style.display = '';
} else if (range === 'month') {
if (monthContainer) monthContainer.style.display = '';
} else if (range === 'all-time') {
if (allTimeContainer) allTimeContainer.style.display = '';
}

ownerStatsUiState.pcRange = range;
saveOwnerStatsUiState();
}

function toggleClientListExpand(buttonElement) {
const wrap = buttonElement.closest('.owner-clients-collapsible');
if (!wrap) return;
const more = wrap.querySelector('.owner-clients-more');
if (!more) return;
const listKey = wrap.getAttribute('data-list-key');

const isExpanded = buttonElement.getAttribute('aria-expanded') === 'true';
if (isExpanded) {
more.style.display = 'none';
buttonElement.setAttribute('aria-expanded', 'false');
buttonElement.classList.remove('is-expanded');
if (listKey === 'top') ownerStatsUiState.topClientsExpanded = false;
if (listKey === 'worst') ownerStatsUiState.worstClientsExpanded = false;
} else {
more.style.display = '';
buttonElement.setAttribute('aria-expanded', 'true');
buttonElement.classList.add('is-expanded');
if (listKey === 'top') ownerStatsUiState.topClientsExpanded = true;
if (listKey === 'worst') ownerStatsUiState.worstClientsExpanded = true;
}
saveOwnerStatsUiState();
}

function collectOwnerPrepaymentsByDate(dateStr) {
const normalizedDate = String(dateStr || '').trim();
if (!normalizedDate) return [];

const parseAmount = (value) => {
  if (value === null || value === undefined) return 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === 'нет' || normalized === '0' || normalized === 'false') return 0;
  const numeric = Number.parseFloat(normalized.replace(',', '.').replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
};

const allBookings = [
...(Array.isArray(bookings) ? bookings : []),
...(Array.isArray(done) ? done : [])
].filter((item) => item && String(item.dateValue || '').trim() === normalizedDate);

return allBookings
  .map((item) => ({
    uid: String(item.uid || item.booking_uid || item.id || '').trim(),
    name: String(item.name || '—').trim() || '—',
    phone: String(item.phone || '—').trim() || '—',
    pc: String(item.pc || '—').trim() || '—',
    time: String(item.time || '—').trim() || '—',
    status: String(item.status || '—').trim() || '—',
    prepayAmount: parseAmount(item.prepay)
  }))
  .filter((item) => item.prepayAmount > 0)
  .sort((a, b) => {
    const tA = String(a.time || '');
    const tB = String(b.time || '');
    return tA.localeCompare(tB, 'ru-RU');
  });
}

function openOwnerPrepayDayModal(dateStr, dayName, dayShort) {
const modal = document.getElementById('ownerPrepayDayModal');
const title = document.getElementById('ownerPrepayDayTitle');
const summary = document.getElementById('ownerPrepayDaySummary');
const tbody = document.getElementById('ownerPrepayDayTableBody');
if (!modal || !title || !summary || !tbody) return;

const toRuStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized || normalized === '—') return '—';
  if (normalized === 'arrived') return 'Пришел';
  if (normalized === 'late') return 'Опоздал';
  if (normalized === 'cancelled') return 'Отмена';
  if (normalized === 'deleted') return 'Удален';
  if (normalized === 'pending') return 'Ожидает';
  if (normalized === 'no-show' || normalized === 'noshow') return 'Не пришел';
  if (normalized === 'booked' || normalized === 'active') return 'Забронирован';
  return status;
};

const rows = collectOwnerPrepaymentsByDate(dateStr);
const totalAmount = rows.reduce((sum, row) => sum + Number(row.prepayAmount || 0), 0);

title.textContent = `Предоплаты: ${String(dayName || '').toUpperCase()} ${String(dayShort || '')}`;
summary.textContent = `Броней с предоплатой: ${rows.length} • Сумма: ${Math.round(totalAmount).toLocaleString('ru-RU')} ₸`;

tbody.innerHTML = rows.length > 0
? rows.map((row) => `
<tr>
  <td>${row.uid ? `<button type="button" class="audit-booking-link" onclick="closeOwnerPrepayDayModal(); openBookingHistoryByUid('${String(row.uid).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">${escapeHtml(row.uid)}</button>` : '—'}</td>
  <td>${escapeHtml(row.time)}</td>
  <td>${row.phone && row.phone !== '—' ? `<button type="button" class="audit-booking-link" onclick="closeOwnerPrepayDayModal(); openCustomerHistoryByPhone('${String(row.phone).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${String(row.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">${escapeHtml(row.name)}</button>` : escapeHtml(row.name)}</td>
  <td>${escapeHtml(row.phone)}</td>
  <td>${escapeHtml(row.pc)}</td>
  <td>${escapeHtml(toRuStatus(row.status))}</td>
  <td>${Math.round(row.prepayAmount).toLocaleString('ru-RU')} ₸</td>
</tr>
`).join('')
: '<tr><td colspan="7" class="owner-prepay-modal-empty">Нет предоплат за этот день</td></tr>';

modal.style.display = 'flex';
}

function closeOwnerPrepayDayModal() {
const modal = document.getElementById('ownerPrepayDayModal');
if (!modal) return;
modal.style.display = 'none';
}

function togglePcTimeRange(buttonElement, range) {
const box = buttonElement.closest('.owner-accordion-box');
if (!box) return;

const monthContainer = box.querySelector('.owner-pcs-month');
const allTimeContainer = box.querySelector('.owner-pcs-all-time');
const contentEl = box.querySelector('.owner-accordion-content');
const buttons = box.querySelectorAll('.owner-time-toggle');

buttons.forEach((btn) => btn.classList.remove('active'));
buttonElement.classList.add('active');

if (range === 'month') {
if (monthContainer) monthContainer.style.display = '';
if (allTimeContainer) allTimeContainer.style.display = 'none';
} else if (range === 'all-time') {
if (monthContainer) monthContainer.style.display = 'none';
if (allTimeContainer) allTimeContainer.style.display = '';
}

// Recalculate content height
if (contentEl && box.classList.contains('is-expanded')) {
setTimeout(() => {
contentEl.style.maxHeight = contentEl.scrollHeight + 'px';
}, 0);
}
}

async function refreshOwnerStatsPageContent() {
const content = document.getElementById('ownerStatsPageContent');
if (content) {
content.innerHTML = '<div class="owner-stat-card stat-card"><div class="stat-card-icon"></div><div class="stat-card-value">...</div><div class="stat-card-label">Загрузка статистики</div></div>';
}
try {
const stats = await apiRequest('/club/stats');
const statsCards = mapServerStatsToCards(stats || {});
if (Array.isArray(statsCards) && statsCards.length > 0) {
renderOwnerStatsCards(statsCards);
renderOwnerStatsInsights(buildOwnerBookingInsights());
return;
}
renderOwnerStatsCards(mapServerStatsToCards(buildLocalOwnerStatsSnapshot()));
renderOwnerStatsInsights(buildOwnerBookingInsights());
} catch (_) {
renderOwnerStatsCards(mapServerStatsToCards(buildLocalOwnerStatsSnapshot()));
renderOwnerStatsInsights(buildOwnerBookingInsights());
}
}

async function showOwnerStats() {
if (!canViewHistoryAndStats()) {
notify('❌ Недостаточно прав для просмотра статистики', 'Ошибка');
return;
}
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('statsBtn').classList.add('active');

await refreshOwnerStatsPageContent();
}
function closeOwnerStatsModal() {
document.getElementById('ownerStatsModal').style.display = 'none';
}

function formatTaskDate(value) {
const date = new Date(value || 0);
if (Number.isNaN(date.getTime())) return '—';
return date.toLocaleString('ru-RU', {
day: '2-digit',
month: '2-digit',
year: 'numeric',
hour: '2-digit',
minute: '2-digit'
});
}

function renderTasksList(tasks) {
const list = document.getElementById('tasksList');
if (!list) return;

if (!Array.isArray(tasks) || tasks.length === 0) {
list.innerHTML = '<div class="audit-empty">Задач пока нет</div>';
return;
}

list.innerHTML = tasks.map((task) => {
const id = Number(task.id);
const safeTitle = escapeHtml(task.title || 'Без названия');
const safeDesc = escapeHtml(task.description || '');
const author = escapeHtml(task.created_by_name || task.created_by_login || 'Неизвестно');
const createdAt = escapeHtml(formatTaskDate(task.created_at));
const done = !!task.is_done;
const urgentBadge = task.is_urgent ? '<span class="task-urgent-badge">Срочно</span>' : '';
const doneButton = done
? `<button type="button" class="ghost" onclick="toggleClubTaskDone(${id}, false)">Вернуть в работу</button>`
: `<button type="button" class="ghost" onclick="toggleClubTaskDone(${id}, true)">Выполнено</button>`;

return `
<div class="task-card ${done ? 'is-done' : ''}">
<div class="task-card-top">
<div class="task-title">${safeTitle}</div>
${urgentBadge}
</div>
${safeDesc ? `<div class="task-desc">${safeDesc}</div>` : ''}
<div class="task-meta">Добавил: ${author} • ${createdAt}</div>
<div class="task-actions">
${doneButton}
<button type="button" class="danger" onclick="deleteClubTask(${id})">Удалить</button>
</div>
</div>`;
}).join('');
}

async function loadClubTasks() {
if (!canViewHistoryAndStats()) return;
const list = document.getElementById('tasksList');
const filter = document.getElementById('tasksStatusFilter');
const status = filter ? String(filter.value || 'all') : 'all';
if (list) {
list.innerHTML = '<div class="audit-empty">Загрузка задач...</div>';
}
try {
const data = await apiRequest('/tasks?status=' + encodeURIComponent(status));
renderTasksList((data && data.tasks) ? data.tasks : []);
} catch (error) {
if (list) {
list.innerHTML = '<div class="audit-empty">Не удалось загрузить задачи</div>';
}
notify(error.message || 'Ошибка загрузки задач', 'Ошибка');
}
}

async function createClubTask() {
if (!canViewHistoryAndStats()) return;
const titleInput = document.getElementById('taskTitleInput');
const descriptionInput = document.getElementById('taskDescriptionInput');
const urgentInput = document.getElementById('taskUrgentInput');
const title = titleInput ? String(titleInput.value || '').trim() : '';
const description = descriptionInput ? String(descriptionInput.value || '').trim() : '';
const isUrgent = urgentInput ? !!urgentInput.checked : false;

if (!title) {
notify('Введите краткое описание задачи', 'Ошибка');
return;
}

try {
await apiRequest('/tasks', {
method: 'POST',
body: JSON.stringify({
title,
description,
is_urgent: isUrgent
})
});
if (titleInput) titleInput.value = '';
if (descriptionInput) descriptionInput.value = '';
if (urgentInput) urgentInput.checked = false;
await loadClubTasks();
notify('✅ Задача добавлена', 'Успешно');
} catch (error) {
notify(error.message || 'Ошибка создания задачи', 'Ошибка');
}
}

async function toggleClubTaskDone(taskId, done) {
if (!canViewHistoryAndStats()) return;
try {
await apiRequest('/tasks/' + encodeURIComponent(String(taskId)), {
method: 'PATCH',
body: JSON.stringify({ is_done: !!done })
});
await loadClubTasks();
} catch (error) {
notify(error.message || 'Ошибка обновления задачи', 'Ошибка');
}
}

function deleteClubTask(taskId) {
if (!canViewHistoryAndStats()) return;
confirmAction('Удалить эту задачу?', async () => {
try {
await apiRequest('/tasks/' + encodeURIComponent(String(taskId)), { method: 'DELETE' });
await loadClubTasks();
} catch (error) {
notify(error.message || 'Ошибка удаления задачи', 'Ошибка');
}
}, 'Удаление задачи');
}

async function loadDashboardTasksWidget() {
const card = document.getElementById('dashTasksCard');
const list = document.getElementById('dashTasksList');
if (!card || !list) return;
if (!canViewHistoryAndStats()) {
card.style.display = 'none';
return;
}
card.style.display = '';
try {
const data = await apiRequest('/tasks?status=open');
const tasks = (data && data.tasks) ? data.tasks : [];
if (tasks.length === 0) {
list.innerHTML = '<div class="activity-item"><span class="activity-dot gray"></span><div class="activity-content"><div class="activity-text">Активных задач нет</div></div></div>';
return;
}
list.innerHTML = tasks.map(task => {
const safeTitle = escapeHtml(task.title || 'Без названия');
const urgentDot = task.is_urgent ? 'red' : 'gray';
return `<div class="activity-item" style="cursor:pointer;" onclick="showTasksPage()">
<span class="activity-dot ${urgentDot}"></span>
<div class="activity-content"><div class="activity-text">${safeTitle}</div></div>
</div>`;
}).join('');
} catch (_) {
list.innerHTML = '<div class="activity-item"><span class="activity-dot gray"></span><div class="activity-content"><div class="activity-text">Не удалось загрузить задачи</div></div></div>';
}
}

async function showTasksPage() {
if (!canViewHistoryAndStats()) {
notify('❌ Недостаточно прав для просмотра задач', 'Ошибка');
return;
}
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('tasksBtn').classList.add('active');
await loadClubTasks();
}
const ACTION_LABELS = {
LOGIN: 'Вход в систему',
LOGOUT: 'Выход',
CREATE_BOOKING_PC: 'Создание брони ПК',
UPDATE_BOOKING_PC: 'Изменение брони ПК',
DELETE_BOOKING_PC: 'Удаление брони ПК',
MARK_ARRIVED: 'Клиент пришёл',
MARK_LATE: 'Клиент опаздывает',
MARK_CANCELLED: 'Бронь отменена',
MARK_NO_SHOW: 'Клиент не пришёл',
CREATE_BOOKING_PS: 'Создание брони PS',
UPDATE_BOOKING_PS: 'Изменение брони PS',
DELETE_BOOKING_PS: 'Удаление брони PS',
PS_SESSION_START: 'Старт PS-сессии',
PS_SESSION_END: 'Завершение PS-сессии',
PS_ADD_TIME: 'Добавление времени PS',
CREATE_ADMIN: 'Добавление админа',
DELETE_ADMIN: 'Удаление админа',
PASSWORD_CHANGE: 'Смена пароля'
};
const ACTION_CATEGORY = {
LOGIN: 'neutral', LOGOUT: 'neutral',
CREATE_BOOKING_PC: 'create', UPDATE_BOOKING_PC: 'update', DELETE_BOOKING_PC: 'delete',
MARK_ARRIVED: 'success', MARK_LATE: 'warning', MARK_CANCELLED: 'warning', MARK_NO_SHOW: 'danger',
CREATE_BOOKING_PS: 'create', UPDATE_BOOKING_PS: 'update', DELETE_BOOKING_PS: 'delete',
PS_SESSION_START: 'create', PS_SESSION_END: 'success', PS_ADD_TIME: 'update',
CREATE_ADMIN: 'create', DELETE_ADMIN: 'delete', PASSWORD_CHANGE: 'warning'
};
const AUDIT_LOGS_LIMIT = 50;
let auditLogsOffset = 0;
let auditAccountsLoaded = false;
let bookingHistoryCurrentUid = '';
let customerHistoryCurrentPhone = '';
let customerHistoryCurrentName = '';
function escapeHtml(str) {
return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function showLogsPage() {
if (!isClubOwner()) {
notify('❌ Только владелец клуба может просматривать логи', 'Ошибка');
return;
}
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('logsBtn').classList.add('active');
auditLogsOffset = 0;
if (!auditAccountsLoaded) {
await loadAuditAccountsFilter();
}
loadAuditLogs();
}

async function showBookingHistoryPage(options) {
if (!canViewHistoryAndStats()) {
notify('❌ Недостаточно прав для просмотра истории броней', 'Ошибка');
return;
}
const preserveFilters = !!(options && options.preserveFilters);
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('bookingHistoryBtn').classList.add('active');
if (!auditAccountsLoaded) {
await loadAuditAccountsFilter();
}
if (!preserveFilters) {
resetBookingHistory();
return;
}
if (bookingHistoryCurrentUid) {
const input = document.getElementById('bookingHistoryUidInput');
if (input) input.value = bookingHistoryCurrentUid;
}
loadBookingHistory();
}

function openBookingHistoryByUid(bookingUid) {
const uid = String(bookingUid || '').trim().toUpperCase();
if (!uid) return;
bookingHistoryCurrentUid = uid;
const auditInput = document.getElementById('auditFilterBookingUid');
if (auditInput) auditInput.value = uid;
const historyInput = document.getElementById('bookingHistoryUidInput');
if (historyInput) historyInput.value = uid;
showBookingHistoryPage({ preserveFilters: true });
}

async function showCustomerHistoryPage(options) {
if (!canViewHistoryAndStats()) {
notify('❌ Недостаточно прав для просмотра истории клиентов', 'Ошибка');
return;
}
const preserveFilters = !!(options && options.preserveFilters);
document.getElementById('dashboardSection').style.display = 'none';
document.getElementById('bookingsSection').style.display = 'none';
document.getElementById('logsSection').style.display = 'none';
document.getElementById('bookingHistorySection').style.display = 'none';
document.getElementById('ownerStatsSection').style.display = 'none';
document.getElementById('adminsSection').style.display = 'none';
document.getElementById('tasksSection').style.display = 'none';
document.getElementById('customerHistorySection').style.display = 'flex';
document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
document.getElementById('customerHistoryBtn').classList.add('active');
if (!preserveFilters) {
resetCustomerHistory();
return;
}
const phoneInput = document.getElementById('customerHistoryPhoneInput');
const nameInput = document.getElementById('customerHistoryNameInput');
if (phoneInput) phoneInput.value = customerHistoryCurrentPhone;
if (nameInput) nameInput.value = customerHistoryCurrentName;
loadCustomerHistory();
}

function openCustomerHistoryByPhone(phone, name) {
const normalizedPhone = String(phone || '').trim();
if (!normalizedPhone) return;
customerHistoryCurrentPhone = normalizedPhone;
customerHistoryCurrentName = String(name || '').trim();
const phoneInput = document.getElementById('customerHistoryPhoneInput');
const nameInput = document.getElementById('customerHistoryNameInput');
if (phoneInput) phoneInput.value = normalizedPhone;
if (nameInput) nameInput.value = customerHistoryCurrentName;
showCustomerHistoryPage({ preserveFilters: true });
}

async function loadAuditAccountsFilter() {
if (!isClubOwner()) return;
const select = document.getElementById('auditFilterAccount');
if (!select) return;
try {
	const listFromApi = await apiRequest('/admins');
	const currentValue = select.value || '';
	select.innerHTML = '<option value="">Все аккаунты</option>';
	listFromApi.forEach(function(admin) {
		const option = document.createElement('option');
		option.value = String(admin.id);
		option.textContent = admin.name || admin.login || ('ID ' + admin.id);
		select.appendChild(option);
	});
	select.value = currentValue;
	auditAccountsLoaded = true;
} catch (error) {
	auditAccountsLoaded = false;
}
}

function formatAuditDateTriggerValue(value) {
if (!value) return '';
const parsed = new Date(value);
if (Number.isNaN(parsed.getTime())) return '';
return parsed.toLocaleString('ru-RU', {
	day: '2-digit',
	month: '2-digit',
	hour: '2-digit',
	minute: '2-digit'
}).replace(',', '');
}

function syncAuditDateRangeTrigger() {
const trigger = document.getElementById('auditDateRangeTrigger');
const fromInput = document.getElementById('auditFilterFrom');
const toInput = document.getElementById('auditFilterTo');
if (!trigger || !fromInput || !toInput) return;
const fromText = formatAuditDateTriggerValue(fromInput.value);
const toText = formatAuditDateTriggerValue(toInput.value);
let label = 'Выбрать период';
if (fromText && toText) {
	label = `${fromText} - ${toText}`;
	trigger.textContent = label;
	trigger.title = label;
	return;
}
if (fromText) {
	label = `С ${fromText}`;
	trigger.textContent = label;
	trigger.title = label;
	return;
}
if (toText) {
	label = `До ${toText}`;
	trigger.textContent = label;
	trigger.title = label;
	return;
}
	trigger.textContent = label;
	trigger.title = label;
}

function openAuditDateRangePopover() {
const popover = document.getElementById('auditDateRangePopover');
if (!popover) return;
popover.classList.add('is-open');
}

function closeAuditDateRangePopover() {
const popover = document.getElementById('auditDateRangePopover');
if (!popover) return;
popover.classList.remove('is-open');
}

function toggleAuditDateRangePopover() {
const popover = document.getElementById('auditDateRangePopover');
if (!popover) return;
popover.classList.toggle('is-open');
}

function handleAuditDateRangeChange() {
	syncAuditDateRangeTrigger();
}

function toAuditIso(value) {
if (!value) return '';
const parsed = new Date(value);
if (Number.isNaN(parsed.getTime())) return '';
return parsed.toISOString();
}

function getAuditFilters() {
const action = document.getElementById('auditFilterAction').value;
const account = document.getElementById('auditFilterAccount').value;
const from = document.getElementById('auditFilterFrom').value;
const to = document.getElementById('auditFilterTo').value;
const bookingUidInput = document.getElementById('auditFilterBookingUid');
const bookingUid = bookingUidInput ? String(bookingUidInput.value || '').trim().toUpperCase() : '';
const params = new URLSearchParams();
if (action) params.set('action', action);
if (account) params.set('admin_id', account);
const fromIso = toAuditIso(from);
const toIso = toAuditIso(to);
if (fromIso) params.set('from', fromIso);
if (toIso) params.set('to', toIso);
if (bookingUid) params.set('booking_uid', bookingUid);
params.set('limit', String(AUDIT_LOGS_LIMIT));
params.set('offset', String(auditLogsOffset));
return params;
}

function getAuditFiltersPayload() {
const action = document.getElementById('auditFilterAction').value;
const account = document.getElementById('auditFilterAccount').value;
const from = document.getElementById('auditFilterFrom').value;
const to = document.getElementById('auditFilterTo').value;
const bookingUidInput = document.getElementById('auditFilterBookingUid');
const bookingUid = bookingUidInput ? String(bookingUidInput.value || '').trim().toUpperCase() : '';
const payload = {};
if (action) payload.action = action;
if (account) payload.admin_id = account;
const fromIso = toAuditIso(from);
const toIso = toAuditIso(to);
if (fromIso) payload.from = fromIso;
if (toIso) payload.to = toIso;
if (bookingUid) payload.booking_uid = bookingUid;
return payload;
}
function formatAuditDetails(action, before, after, forcedBookingUid) {
const data = after || before;
if (!data) return '—';
const hasPrepay = function(value) {
if (value === null || value === undefined) return false;
const normalized = String(value).trim().toLowerCase();
return normalized !== '' && normalized !== 'нет' && normalized !== '0' && normalized !== 'false';
};
switch (action) {
case 'CREATE_BOOKING_PC':
case 'UPDATE_BOOKING_PC':
case 'DELETE_BOOKING_PC':
case 'MARK_ARRIVED':
case 'MARK_LATE':
case 'MARK_CANCELLED':
case 'MARK_NO_SHOW': {
const name = data.name || data.guest_name || '';
const pc = data.pc || '';
const dateLabel = data.date_display || data.date_value || '';
const time = data.time || '';
const bookingUid = forcedBookingUid || data.booking_uid || '';
const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
const parts = [];
if (bookingUid) parts.push('ID ' + bookingUid);
if (name) parts.push(name);
if (pc) parts.push('ПК ' + pc);
if (dateLabel) parts.push(dateLabel);
if (time) parts.push(time);
if (hasPrepay(prepay)) parts.push('Предоплата: ' + prepay + ' ₸');
if (action.startsWith('MARK_') && before && after && before.status && after.status) {
parts.push(before.status + ' → ' + after.status);
}
return parts.join(' · ') || '—';
}
case 'CREATE_BOOKING_PS':
case 'UPDATE_BOOKING_PS':
case 'DELETE_BOOKING_PS': {
const name = data.name || data.client_name || '';
const ps = data.ps_id || data.console_id || '';
const dateLabel = data.date_display || data.date_value || '';
const time = data.time || '';
const bookingUid = forcedBookingUid || data.booking_uid || '';
const prepay = data.prepay || data.prepayment || data.prepaid_amount || '';
const parts = [];
if (bookingUid) parts.push('ID ' + bookingUid);
if (name) parts.push(name);
if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
if (dateLabel) parts.push(dateLabel);
if (time) parts.push(time);
if (hasPrepay(prepay)) parts.push('Предоплата: ' + prepay + ' ₸');
return parts.join(' · ') || '—';
}
case 'PS_SESSION_START': {
const ps = data.ps_id || '';
const pkg = data.selected_package || '';
const parts = [];
if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
if (pkg) parts.push(pkg);
return parts.join(' · ') || '—';
}
case 'PS_SESSION_END': {
const ps = data.ps_id || '';
const cost = data.total_paid;
const parts = [];
if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
if (cost !== undefined && cost !== null) parts.push(cost + ' ₸');
return parts.join(' · ') || '—';
}
case 'PS_ADD_TIME': {
const ps = data.ps_id || '';
const added = data.added_time || data.added_minutes || '';
const parts = [];
if (ps) parts.push('PS-' + String(ps).padStart(2, '0'));
if (added) parts.push('+' + added + ' мин');
return parts.join(' · ') || '—';
}
case 'CREATE_ADMIN':
case 'DELETE_ADMIN': {
const login = data.login || '';
const name2 = data.name || '';
return [name2, login ? '(' + login + ')' : ''].filter(Boolean).join(' ') || '—';
}
case 'PASSWORD_CHANGE':
return data.login ? 'Логин: ' + data.login : '—';
default:
return '—';
}
}

function getAuditCustomerMeta(log) {
const data = log.after || log.before || null;
if (!data) return null;
const phone = String(data.phone || data.client_phone || '').trim();
const name = String(data.name || data.guest_name || data.client_name || '').trim();
if (!phone || !name) return null;
if (!/^CREATE_BOOKING_|^UPDATE_BOOKING_|^DELETE_BOOKING_|^MARK_/.test(String(log.action || ''))) {
return null;
}
return { phone: phone, name: name };
}

function formatAuditDetailsHtml(log) {
const details = formatAuditDetails(log.action, log.before, log.after, log.booking_uid);
const safeDetails = escapeHtml(details);
const bookingUid = String(log.booking_uid || '').trim().toUpperCase();
const customerMeta = getAuditCustomerMeta(log);
let html = safeDetails;
if (bookingUid) {
const prefix = escapeHtml('ID ' + bookingUid);
if (html.startsWith(prefix)) {
const rest = html.slice(prefix.length);
html = '<button type="button" class="audit-booking-link" onclick="openBookingHistoryByUid(\'' + bookingUid + '\')">' + prefix + '</button>' + rest;
}
}
if (customerMeta) {
const safeName = escapeHtml(customerMeta.name);
const safePhone = String(customerMeta.phone).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const safeNameArg = String(customerMeta.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
html = html.replace(
safeName,
'<button type="button" class="audit-booking-link" onclick="openCustomerHistoryByPhone(\'' + safePhone + '\', \'' + safeNameArg + '\')">' + safeName + '</button>'
);
}
return html;
}

async function loadAuditLogs(loadMore) {
if (!isClubOwner()) return;
if (!loadMore) auditLogsOffset = 0;
const tbody = document.getElementById('auditTableBody');
const emptyState = document.getElementById('auditEmptyState');
const loadMoreBtn = document.getElementById('auditLoadMore');
if (!loadMore) {
tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;opacity:0.5;">Загрузка…</td></tr>';
emptyState.style.display = 'none';
loadMoreBtn.style.display = 'none';
}
try {
const params = getAuditFilters();
const data = await apiRequest('/audit/logs?' + params.toString());
const logs = data.logs || [];
if (!loadMore) tbody.innerHTML = '';
if (logs.length === 0 && !loadMore) {
emptyState.style.display = 'block';
loadMoreBtn.style.display = 'none';
return;
}
logs.forEach(function(log) {
const tr = document.createElement('tr');
const category = ACTION_CATEGORY[log.action] || 'neutral';
const label = ACTION_LABELS[log.action] || log.action;
const detailsHtml = formatAuditDetailsHtml(log);
const date = new Date(log.timestamp);
const dateStr = date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
tr.innerHTML =
'<td class="audit-cell-time">' + escapeHtml(dateStr) + '</td>' +
'<td class="audit-cell-who">' + escapeHtml(log.admin_name || log.admin_login || '—') + '</td>' +
'<td><span class="audit-badge audit-badge--' + category + '">' + escapeHtml(label) + '</span></td>' +
'<td class="audit-cell-details">' + detailsHtml + '</td>';
tbody.appendChild(tr);
});
auditLogsOffset += logs.length;
loadMoreBtn.style.display = logs.length === AUDIT_LOGS_LIMIT ? 'block' : 'none';
} catch (err) {
if (!loadMore) {
tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#f87171;">' + escapeHtml(err.message || 'Ошибка загрузки') + '</td></tr>';
}
notify(err.message || 'Ошибка загрузки логов', 'Ошибка');
}
}

async function loadBookingHistory() {
if (!canViewHistoryAndStats()) return;
const tbody = document.getElementById('bookingHistoryTableBody');
const emptyState = document.getElementById('bookingHistoryEmptyState');
if (!tbody || !emptyState) return;
const input = document.getElementById('bookingHistoryUidInput');
const uid = input ? String(input.value || '').trim().toUpperCase() : '';
bookingHistoryCurrentUid = uid;
if (!uid) {
tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;opacity:0.6;">Введите ID брони</td></tr>';
emptyState.style.display = 'none';
return;
}

tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;opacity:0.5;">Загрузка…</td></tr>';
emptyState.style.display = 'none';

try {
const data = await apiRequest('/audit/booking-history/' + encodeURIComponent(uid));
const logs = data.logs || [];
tbody.innerHTML = '';
if (logs.length === 0) {
emptyState.style.display = 'block';
return;
}
logs.forEach(function(log) {
const tr = document.createElement('tr');
const category = ACTION_CATEGORY[log.action] || 'neutral';
const label = ACTION_LABELS[log.action] || log.action;
const details = formatAuditDetails(log.action, log.before, log.after, uid);
const date = new Date(log.timestamp);
const dateStr = date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
tr.innerHTML =
'<td class="audit-cell-time">' + escapeHtml(dateStr) + '</td>' +
'<td class="audit-cell-who">' + escapeHtml(log.admin_name || log.admin_login || '—') + '</td>' +
'<td><span class="audit-badge audit-badge--' + category + '">' + escapeHtml(label) + '</span></td>' +
'<td class="audit-cell-details">' + escapeHtml(details) + '</td>';
tbody.appendChild(tr);
});
} catch (err) {
tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#f87171;">' + escapeHtml(err.message || 'Ошибка загрузки истории') + '</td></tr>';
notify(err.message || 'Ошибка загрузки истории брони', 'Ошибка');
}
}

function resetBookingHistory() {
bookingHistoryCurrentUid = '';
const input = document.getElementById('bookingHistoryUidInput');
if (input) input.value = '';
const tbody = document.getElementById('bookingHistoryTableBody');
if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;opacity:0.6;">Введите ID брони</td></tr>';
const emptyState = document.getElementById('bookingHistoryEmptyState');
if (emptyState) emptyState.style.display = 'none';
}

async function loadCustomerHistory() {
if (!canViewHistoryAndStats()) return;
const tbody = document.getElementById('customerHistoryTableBody');
const emptyState = document.getElementById('customerHistoryEmptyState');
const phoneInput = document.getElementById('customerHistoryPhoneInput');
const nameInput = document.getElementById('customerHistoryNameInput');
if (!tbody || !emptyState) return;
const phone = phoneInput ? String(phoneInput.value || '').trim() : '';
const name = nameInput ? String(nameInput.value || '').trim() : '';
customerHistoryCurrentPhone = phone;
customerHistoryCurrentName = name;
if (!phone) {
tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;opacity:0.6;">Выберите клиента из логов</td></tr>';
emptyState.style.display = 'none';
return;
}

tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;opacity:0.5;">Загрузка…</td></tr>';
emptyState.style.display = 'none';

try {
const data = await apiRequest('/audit/customer-history/' + encodeURIComponent(phone));
const bookings = data.bookings || [];
if (nameInput) nameInput.value = data.customer_name || name || '';
customerHistoryCurrentName = data.customer_name || name || '';
tbody.innerHTML = '';
if (bookings.length === 0) {
emptyState.style.display = 'block';
return;
}

// Отсортировать по времени создания (новые первыми)
bookings.sort((a, b) => {
const timeA = new Date(a.created_at || 0).getTime();
const timeB = new Date(b.created_at || 0).getTime();
return timeB - timeA;
});

bookings.forEach(function(item) {
const tr = document.createElement('tr');
const dateText = item.date_value || '—';
const statusText = item.deleted_at ? 'Удалена' : (item.status || '—');
const accountText = item.admin_name || item.admin_login || item.created_by_name || item.created_by_login || '—';
const bookingUid = String(item.booking_uid || '').trim().toUpperCase();
const createdAt = item.created_at || '';
const createdDate = createdAt ? createdAt.split('T')[0] : '—';
const createdTime = createdAt ? (createdAt.split('T')[1] ? createdAt.split('T')[1].substring(0, 5) : '—') : '—';
const createdDisplay = createdDate !== '—' && createdTime !== '—' ? createdDate + ' ' + createdTime : (createdDate !== '—' ? createdDate : '—');
const uidHtml = bookingUid
? '<button type="button" class="audit-booking-link" onclick="openBookingHistoryByUid(\'' + bookingUid + '\')">' + escapeHtml(bookingUid) + '</button>'
: '—';
const dateTimeDisplay = dateText !== '—' && item.time ? escapeHtml(dateText) + ' ' + escapeHtml(item.time) : (dateText !== '—' ? escapeHtml(dateText) : '—');
tr.innerHTML =
'<td class="audit-cell-details">' + uidHtml + '</td>' +
'<td class="audit-cell-who">' + escapeHtml(item.name || '—') + '</td>' +
'<td>' + escapeHtml(item.phone || '—') + '</td>' +
'<td class="audit-cell-time">' + escapeHtml(createdDisplay) + '</td>' +
'<td class="audit-cell-who">' + escapeHtml(accountText) + '</td>' +
'<td>' + escapeHtml(item.platform_label || '—') + '</td>' +
'<td class="audit-cell-time">' + dateTimeDisplay + '</td>' +
'<td>' + escapeHtml(statusText) + '</td>';
tbody.appendChild(tr);
});
} catch (err) {
tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:#f87171;">' + escapeHtml(err.message || 'Ошибка загрузки истории клиента') + '</td></tr>';
notify(err.message || 'Ошибка загрузки истории клиента', 'Ошибка');
}
}

function resetCustomerHistory() {
customerHistoryCurrentPhone = '';
customerHistoryCurrentName = '';
const phoneInput = document.getElementById('customerHistoryPhoneInput');
const nameInput = document.getElementById('customerHistoryNameInput');
if (phoneInput) phoneInput.value = '';
if (nameInput) nameInput.value = '';
const tbody = document.getElementById('customerHistoryTableBody');
if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;opacity:0.6;">Выберите клиента из логов</td></tr>';
const emptyState = document.getElementById('customerHistoryEmptyState');
if (emptyState) emptyState.style.display = 'none';
}

function resetAuditFilters() {
document.getElementById('auditFilterAction').value = '';
document.getElementById('auditFilterAccount').value = '';
document.getElementById('auditFilterFrom').value = '';
document.getElementById('auditFilterTo').value = '';
const bookingUidInput = document.getElementById('auditFilterBookingUid');
if (bookingUidInput) bookingUidInput.value = '';
	syncAuditDateRangeTrigger();
	closeAuditDateRangePopover();
auditLogsOffset = 0;
loadAuditLogs();
}
async function downloadAuditLogs() {
if (!isClubOwner()) {
notify('❌ Только владелец клуба может скачивать логи', 'Ошибка');
return;
}
try {
const response = await fetch(`${API_BASE}/audit/export`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
Authorization: `Bearer ${getAuthToken()}`,
'x-club-id': clubContext.id ? String(clubContext.id) : ''
},
body: JSON.stringify(getAuditFiltersPayload())
});
if (!response.ok) {
const text = await response.text();
const data = parseApiPayload(text);
throw createApiError(response, data);
}
const blob = await response.blob();
const url = window.URL.createObjectURL(blob);
const link = document.createElement('a');
link.href = url;
link.download = `${clubContext.slug || 'club'}-audit-${new Date().toISOString().slice(0, 10)}.xlsx`;
document.body.appendChild(link);
link.click();
link.remove();
window.URL.revokeObjectURL(url);
notify('Логи успешно скачаны', 'Успешно');
} catch (err) {
notify(err.message || 'Ошибка скачивания логов', 'Ошибка');
}
}
function openQuickBooking() {
document.getElementById('quickBookingModal').style.display = 'flex';
}
function closeQuickBooking() {
document.getElementById('quickBookingModal').style.display = 'none';
}
document.getElementById('quickBookingForm').addEventListener('submit', function(e) {
e.preventDefault();
const currentClientPC = document.getElementById('currentClientPC').value.trim();
const friendsPCsInput = document.getElementById('friendsPCs').value.trim();
const quickTimeRaw = document.getElementById('quickTime').value.trim();
const quickDateSelect = document.getElementById('quickDate');
const quickDateValue = quickDateSelect.value;
const quickDateDisplay = quickDateSelect.options[quickDateSelect.selectedIndex].textContent;
if (!currentClientPC || !friendsPCsInput) return showError('Заполните все поля');
const pcLimit = getCurrentPcCapacity();
if (!/^\d{1,2}$/.test(currentClientPC) || +currentClientPC < 1 || +currentClientPC > pcLimit) {
return showError(`ПК текущего клиента от 1 до ${pcLimit}`);
}
let friendsPCs = pcBookingsModule.parsePcList(friendsPCsInput);
if (!pcBookingsModule.isValidPcList(friendsPCs, pcLimit)) {
return showError(`ПК друзей от 1 до ${pcLimit}`);
}
const pc = friendsPCs.join(',');
const time = pcBookingsModule.parseTimeHHMM(quickTimeRaw);
if (!time) return showError('Время в формате HHMM');
if (!isBookingTimeValid(quickDateValue, time)) return showError('Нельзя забронировать на прошлое время');
let conflict = false;
friendsPCs.forEach(p => {
if (bookings.some(b => b.dateValue === quickDateValue && b.pc.split(',').map(x=>x.trim()).includes(p))) {
conflict = true;
}
});
if (conflict) {
return showError('Один или несколько ПК уже заняты на эту дату');
}
const name = `Клиент за ПК ${currentClientPC}`;
const phone = '';
const prepay = 'Нет';
bookings.push({
name, pc, time, dateValue: quickDateValue, dateDisplay: quickDateDisplay, phone, prepay, arrived: false, shift: 0,
pcStatuses: createPendingPCStatuses(pc),
addedBy: currentAdmin ? currentAdmin.name : 'Неизвестно', 
addedAt: new Date().toISOString()
});
const createdBooking = bookings[bookings.length - 1];
saveAll();
syncCreateBooking(createdBooking).catch(() => {
bookings = bookings.filter((b) => b !== createdBooking);
saveAll();
notify('Ошибка синхронизации с сервером. Бронь отменена.', 'Ошибка');
});
this.reset();
closeQuickBooking();
});
function initPSConsoles() {
const count = Math.max(0, getCurrentPsCapacity());
psConsoles = [];
for (let i = 1; i <= count; i += 1) {
psConsoles.push({
id: i,
status: 'idle',
remaining: 0,
startTime: 0,
prepaid: 0,
totalPaid: 0,
selectedPackage: null,
addedTime: 0,
clientName: null,
clientPhone: null,
booking: null,
isFreeTime: false
});
}
startPSTimer();
}
function savePSState() {
storage.savePSState(state);
if (currentPlatform === 'ps') {
updatePSCounter();
}
}
function getPSGroup(psID) {
return psRuntimeConfig.consoleToGroup.get(Number(psID)) || null;
}
function getPSTariff(psID) {
const byConsole = psRuntimeConfig.consolePricingById.get(Number(psID));
if (byConsole) {
const directHourly = Number(byConsole.hourly_price);
if (Number.isFinite(directHourly) && directHourly > 0) return directHourly;
}

const groupName = getPSGroup(psID);
if (!groupName) return 0;
const group = psRuntimeConfig.groupsByName.get(groupName);
if (!group) return 0;
const hourlyPrice = Number(group.hourly_price);
return Number.isFinite(hourlyPrice) && hourlyPrice > 0 ? hourlyPrice : 0;
}
function roundCostToNearestFive(value) {
const amount = Number(value || 0);
if (!Number.isFinite(amount) || amount <= 0) return 0;
return Math.round(amount / 5) * 5;
}
async function refreshPSRuntimeConfig() {
const clubConfig = await apiRequest('/club/config');
if (!clubConfig || !Array.isArray(clubConfig.ps_consoles)) {
throw new Error('CLUB_CONFIG_NOT_FOUND');
}
applyPsRuntimeConfig(clubConfig);
}
function formatPSTime(minutes) {
if (minutes <= 0) return '0:00';
const h = Math.floor(minutes / 60);
const m = Math.floor(minutes % 60);
const s = Math.floor((minutes % 1) * 60);
return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function getPSStatusView(ps) {
const view = {
className: 'ps-status',
text: '○ Свободна',
tooltip: null
};

if (ps.status === 'idle') {
view.className += ' ps-idle';
view.text = '○ Свободна';
} else if (ps.status === 'active') {
view.className += ' ps-active';
view.text = '● Активна';
} else if (ps.status === 'warning') {
view.className += ' ps-warning';
view.text = `● ≤${config.ps.warningMinutes} мин`;
} else if (ps.status === 'booked') {
view.className += ' ps-booked';
if (ps.booking) {
view.text = `◐ Бронь: ${ps.booking.name} ${ps.booking.phone} ${ps.booking.time}`;
const bookedDate = new Date(ps.booking.bookedAt);
const time = bookedDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateStr = bookedDate.toLocaleDateString('ru-RU');
view.tooltip = `${ps.booking.adminName}\n${time}\n${dateStr}`;
} else {
view.text = '◐ Забронирована';
}
} else {
view.className += ' ps-idle';
view.text = '○ Истекло';
}

return view;
}
function buildPSActionButtons(ps, actionDiv) {
actionDiv.innerHTML = '';
if (ps.status === 'idle') {
const startBtn = document.createElement('button');
startBtn.className = 'ps-btn';
startBtn.textContent = 'Начать';
startBtn.onclick = () => openPSChoice(ps.id);
const bookBtn = document.createElement('button');
bookBtn.className = 'ps-btn';
bookBtn.textContent = 'Забронировать';
bookBtn.onclick = () => openPSBooking(ps.id);
actionDiv.appendChild(startBtn);
actionDiv.appendChild(bookBtn);
} else if (ps.status === 'booked') {
const overdue = ps.booking ? isBookingOverdue(ps.booking) : false;
if (overdue && ps.booking && ps.booking.phone) {
const remindBtn = document.createElement('button');
remindBtn.className = 'ps-btn';
remindBtn.textContent = 'Напомнить';
remindBtn.onclick = () => sendWhatsAppPSReminder(ps.booking, ps.id);
actionDiv.appendChild(remindBtn);
}
const editBtn = document.createElement('button');
editBtn.className = 'ps-btn';
editBtn.textContent = 'Редактировать бронь';
editBtn.onclick = () => openEditPSBooking(ps.id);
const deleteBtn = document.createElement('button');
deleteBtn.className = 'ps-btn ps-btn-danger';
deleteBtn.textContent = 'Удалить бронь';
deleteBtn.onclick = () => deletePSBooking(ps.id);
const startBtn = document.createElement('button');
startBtn.className = 'ps-btn';
startBtn.textContent = 'Начать';
startBtn.onclick = () => openPSChoice(ps.id);
actionDiv.appendChild(editBtn);
actionDiv.appendChild(deleteBtn);
actionDiv.appendChild(startBtn);
} else if (ps.status === 'active' || ps.status === 'warning') {
const endBtn = document.createElement('button');
endBtn.className = 'ps-btn ps-btn-danger';
endBtn.textContent = 'Завершить';
endBtn.onclick = () => openPSEndSession(ps.id);
if (!ps.isFreeTime) {
const addBtn = document.createElement('button');
addBtn.className = 'ps-btn';
addBtn.textContent = '+Время';
addBtn.onclick = () => openPSAddTime(ps.id);
actionDiv.appendChild(addBtn);
}
actionDiv.appendChild(endBtn);
} else if (ps.status === 'expired') {
const openTimeBtn = document.createElement('button');
openTimeBtn.className = 'ps-btn';
openTimeBtn.textContent = 'Открыть время';
openTimeBtn.onclick = () => openPSFreeTime(ps.id);
const addBtn = document.createElement('button');
addBtn.className = 'ps-btn';
addBtn.textContent = '+Время';
addBtn.onclick = () => openPSAddTime(ps.id);
const endBtn = document.createElement('button');
endBtn.className = 'ps-btn ps-btn-danger';
endBtn.textContent = 'Завершить';
endBtn.onclick = () => openPSEndSession(ps.id);
actionDiv.appendChild(openTimeBtn);
actionDiv.appendChild(addBtn);
actionDiv.appendChild(endBtn);
} else {
const startBtn = document.createElement('button');
startBtn.className = 'ps-btn';
startBtn.textContent = 'Начать';
startBtn.onclick = () => openPSChoice(ps.id);
const endBtn = document.createElement('button');
endBtn.className = 'ps-btn ps-btn-danger';
endBtn.textContent = 'Завершить';
endBtn.onclick = () => openPSEndSession(ps.id);
actionDiv.appendChild(startBtn);
actionDiv.appendChild(endBtn);
}
}
function getPSActionKey(ps) {
return `${ps.status}|${ps.booking ? `${ps.booking.name}|${ps.booking.time}` : 'nobooking'}`;
}
function updatePSConsoleRow(ps) {
const row = document.querySelector(`#psConsolesTable tr[data-ps-id="${ps.id}"]`);
if (!row) return;

const statusSpan = row.querySelector('.ps-status');
const timeTd = row.querySelector('.ps-time');
const packageTd = row.querySelector('.ps-package');
const actionsDiv = row.querySelector('.ps-actions');
const statusView = getPSStatusView(ps);

if (statusSpan) {
statusSpan.className = statusView.className;
statusSpan.textContent = statusView.text;
if (statusView.tooltip) {
statusSpan.setAttribute('data-tooltip', statusView.tooltip);
} else {
statusSpan.removeAttribute('data-tooltip');
}
}

if (timeTd) {
timeTd.textContent = ps.remaining > 0 ? formatPSTime(ps.remaining) : '—';
}

if (packageTd) {
packageTd.textContent = ps.selectedPackage || '—';
}

if (actionsDiv) {
const nextActionKey = getPSActionKey(ps);
if (actionsDiv.dataset.actionKey !== nextActionKey) {
buildPSActionButtons(ps, actionsDiv);
actionsDiv.dataset.actionKey = nextActionKey;
}
}
}
function renderPSConsoles() {
const tbody = document.getElementById('psConsolesTable');
tbody.innerHTML = '';
psConsoles.forEach(ps => {
const tr = document.createElement('tr');
tr.setAttribute('data-ps-id', String(ps.id));
const numTd = document.createElement('td');
numTd.textContent = `PS ${ps.id}`;
const statusTd = document.createElement('td');
const statusSpan = document.createElement('span');
statusSpan.className = 'ps-status';
statusTd.appendChild(statusSpan);
const timeTd = document.createElement('td');
timeTd.className = 'ps-time';
const packageTd = document.createElement('td');
packageTd.className = 'ps-package';
const actionsTd = document.createElement('td');
const actionDiv = document.createElement('div');
actionDiv.className = 'ps-btn-group ps-actions';
actionsTd.appendChild(actionDiv);
tr.appendChild(numTd);
tr.appendChild(statusTd);
tr.appendChild(timeTd);
tr.appendChild(packageTd);
tr.appendChild(actionsTd);
tbody.appendChild(tr);
updatePSConsoleRow(ps);
});
}
function openPSChoice(psID) {
const ps = psConsoles[psID - 1];
if (ps.status !== 'idle' && ps.status !== 'booked') return notify('Консоль занята!', 'Ошибка');
currentPSID = psID;
document.getElementById('psChoiceNum').textContent = psID;
document.getElementById('psChoiceModal').style.display = 'flex';
}
function closePSChoiceModal() {
document.getElementById('psChoiceModal').style.display = 'none';
}
async function openPSFreeTime(psID) {
const ps = psConsoles[psID - 1];
if (ps.status !== 'expired') return notify('Консоль не имеет истекшего времени!', 'Ошибка');
currentPSID = psID;
const snapshot = JSON.parse(JSON.stringify(ps));
const endCost = ps.totalPaid || 0;
ps.status = 'active';
ps.startTime = Date.now();
ps.prepaid = 0;
ps.totalPaid = 0;
ps.selectedPackage = 'Поминутка';
ps.clientName = null;
ps.clientPhone = null;
ps.isFreeTime = true;
savePSState();
removeNotificationsByPsId(psID);
renderPSConsoles();
try {
// End the expired session in the DB before opening a new free-time session
await apiRequest(`/ps/consoles/${psID}/session/end`, {
method: 'POST',
body: JSON.stringify({ total_paid: endCost })
});
await apiRequest(`/ps/consoles/${psID}/session`, {
method: 'POST',
body: JSON.stringify({ prepaid_minutes: 0, total_paid: 0, selected_package: 'Поминутка', is_free_time: true })
});
await syncStateFromBackend();
} catch (error) {
Object.assign(ps, snapshot);
savePSState();
renderPSConsoles();
notify(error.message || 'Ошибка синхронизации PS с сервером', 'Ошибка');
}
}
async function openPSPackages() {
closePSChoiceModal();
try {
await refreshPSRuntimeConfig();
} catch (error) {
notify(error.message || 'Не удалось загрузить конфигурацию PS', 'Ошибка');
return;
}
document.getElementById('psPackagesNum').textContent = currentPSID;
const container = document.getElementById('psPackagesList');
container.innerHTML = '';
const byConsole = psRuntimeConfig.consolePricingById.get(Number(currentPSID));
const packageGroup = byConsole && Array.isArray(byConsole.packages)
? byConsole.packages
: [];

if (packageGroup.length === 0) {
notify('Для этой PS не настроены пакеты', 'Ошибка');
return;
}

packageGroup.forEach((pkg) => {
const btn = document.createElement('button');
btn.className = 'ps-package-btn';
btn.innerHTML = `<strong>${pkg.name}</strong><br>${pkg.duration_minutes} мин / ${pkg.price}тг`;
btn.onclick = () => applyPSPackage(pkg.duration_minutes, pkg.price, pkg.name);
container.appendChild(btn);
});
document.getElementById('psPackagesModal').style.display = 'flex';
}
function closePSPackagesModal() {
document.getElementById('psPackagesModal').style.display = 'none';
}
async function openPSManual() {
closePSChoiceModal();
try {
await refreshPSRuntimeConfig();
} catch (error) {
notify(error.message || 'Не удалось загрузить конфигурацию PS', 'Ошибка');
return;
}
document.getElementById('psManualNum').textContent = currentPSID;
document.getElementById('psHours').value = 1;
document.getElementById('psMinutes').value = 0;
updatePSManualCost();
document.getElementById('psHours').addEventListener('change', updatePSManualCost);
document.getElementById('psMinutes').addEventListener('change', updatePSManualCost);
document.getElementById('psHours').addEventListener('input', updatePSManualCost);
document.getElementById('psMinutes').addEventListener('input', updatePSManualCost);
document.getElementById('psManualModal').style.display = 'flex';
}
async function openPSMinuteBilling() {
closePSChoiceModal();

try {
await refreshPSRuntimeConfig();
} catch (error) {
notify(error.message || 'Не удалось загрузить конфигурацию PS', 'Ошибка');
return;
}

const ps = psConsoles[currentPSID - 1];
if (!ps) {
notify('PS не найдена', 'Ошибка');
return;
}

const tariff = getPSTariff(currentPSID);
if (tariff <= 0) {
notify('Для этой PS не настроен почасовой тариф', 'Ошибка');
return;
}

const bookingId = ps.booking && ps.booking.id ? ps.booking.id : null;
const snapshot = JSON.parse(JSON.stringify(ps));

ps.status = 'active';
ps.startTime = Date.now();
ps.prepaid = 0;
ps.remaining = 0;
ps.totalPaid = 0;
ps.selectedPackage = 'Поминутка';
ps.addedTime = 0;
ps.isFreeTime = true;
savePSState();
removeNotificationsByPsId(currentPSID);
renderPSConsoles();

apiRequest(`/ps/consoles/${currentPSID}/session`, {
method: 'POST',
body: JSON.stringify({
booking_id: bookingId,
prepaid_minutes: 0,
total_paid: 0,
selected_package: 'Поминутка',
is_free_time: true
})
}).then(() => syncStateFromBackend()).catch((error) => {
Object.assign(ps, snapshot);
savePSState();
renderPSConsoles();
notify(error.message || 'Ошибка синхронизации PS с сервером', 'Ошибка');
});
}
function closePSManualModal() {
document.getElementById('psManualModal').style.display = 'none';
}
function updatePSManualCost() {
const hours = parseInt(document.getElementById('psHours').value) || 0;
const minutes = parseInt(document.getElementById('psMinutes').value) || 0;
const totalMin = hours * 60 + minutes;
const tariff = getPSTariff(currentPSID);
const cost = roundCostToNearestFive((totalMin / 60) * tariff);
document.getElementById('psCostDisplay').textContent = cost;
}
function confirmPSManual() {
const hours = parseInt(document.getElementById('psHours').value) || 0;
const minutes = parseInt(document.getElementById('psMinutes').value) || 0;
const totalMin = hours * 60 + minutes;
if (totalMin === 0) {
notify('Укажите время', 'Ошибка');
return;
}
const tariff = getPSTariff(currentPSID);
if (tariff <= 0) {
notify('Для этой PS не настроен почасовой тариф', 'Ошибка');
return;
}
const cost = roundCostToNearestFive((totalMin / 60) * tariff);
const label = hours > 0 ? `${hours}ч${minutes > 0 ? ' ' + minutes + 'м' : ''}` : `${minutes}м`;
applyPSPackage(totalMin, cost, label);
closePSManualModal();
}
function applyPSPackage(minutes, cost, label) {
const ps = psConsoles[currentPSID - 1];
const bookingId = ps.booking && ps.booking.id ? ps.booking.id : null;
const snapshot = JSON.parse(JSON.stringify(ps));
ps.prepaid = minutes;
ps.startTime = Date.now();
ps.totalPaid = cost;
ps.status = 'active';
ps.remaining = minutes;
ps.selectedPackage = label;
ps.addedTime = 0;
ps.booking = null;
savePSState();
removeNotificationsByPsId(currentPSID);
closePSPackagesModal();
renderPSConsoles();
apiRequest(`/ps/consoles/${currentPSID}/session`, {
method: 'POST',
body: JSON.stringify({
booking_id: bookingId,
prepaid_minutes: minutes,
total_paid: cost,
selected_package: label,
is_free_time: false
})
}).then(() => syncStateFromBackend()).catch((error) => {
Object.assign(ps, snapshot);
savePSState();
renderPSConsoles();
notify(error.message || 'Ошибка синхронизации PS с сервером', 'Ошибка');
});
}
function openPSAddTime(psID) {
currentPSID = psID;
document.getElementById('psAddNum').textContent = psID;
document.getElementById('psAddMinutes').value = 5;
updatePSAddCost();
document.getElementById('psAddTimeModal').style.display = 'flex';
}
function closePSAddTimeModal() {
document.getElementById('psAddTimeModal').style.display = 'none';
}
function psAddQuick(minutes) {
document.getElementById('psAddMinutes').value = minutes;
updatePSAddCost();
}
function updatePSAddCost() {
const minutes = parseInt(document.getElementById('psAddMinutes').value) || 0;
const tariff = getPSTariff(currentPSID);
const cost = roundCostToNearestFive((minutes / 60) * tariff);
document.getElementById('psAddCostDisplay').textContent = cost;
}
function confirmPSAdd() {
const minutes = parseInt(document.getElementById('psAddMinutes').value) || 0;
if (minutes < 5) {
notify('Минимум 5 минут', 'Ошибка');
return;
}
const ps = psConsoles[currentPSID - 1];
const tariff = getPSTariff(currentPSID);
if (tariff <= 0) {
notify('Для этой PS не настроен почасовой тариф', 'Ошибка');
return;
}
const cost = roundCostToNearestFive((minutes / 60) * tariff);
ps.totalPaid += cost;
ps.prepaid += minutes;
ps.remaining += minutes;
ps.addedTime += minutes;
if (ps.status === 'expired') {
ps.startTime = Date.now();
ps.status = 'active';
removeNotificationsByPsId(currentPSID);
}
savePSState();
closePSAddTimeModal();
renderPSConsoles();
apiRequest(`/ps/consoles/${currentPSID}/session`, {
method: 'PUT',
body: JSON.stringify({ minutes, cost })
}).then(() => syncStateFromBackend()).catch((error) => notify(error.message || 'Ошибка синхронизации PS с сервером', 'Ошибка'));
}
function openPSBooking(psID) {
currentPSID = psID;
document.getElementById('psBookingNum').textContent = psID;
document.getElementById('psBookingName').value = '';
document.getElementById('psBookingPhone').value = '+7 ';
document.getElementById('psBookingTime').value = '';
document.getElementById('psBookingDate').value = getLocalDateString(getCurrentLocalDate());
document.getElementById('psBookingModal').style.display = 'flex';
}
function closePSBookingModal() {
document.getElementById('psBookingModal').style.display = 'none';
}
function closeEditPCBookingModal() {
document.getElementById('editPCBookingModal').style.display = 'none';
}
function closeEditPSBookingModal() {
document.getElementById('editPSBookingModal').style.display = 'none';
}
function openEditPCBooking(index) {
currentEditPCBookingIndex = index;
const booking = bookings[index];
document.getElementById('editPCName').value = booking.name;
document.getElementById('editPCNumbers').value = booking.pc;
document.getElementById('editPCTime').value = booking.time;
document.getElementById('editPCDate').value = booking.dateValue;
document.getElementById('editPCPhone').value = booking.phone;
document.getElementById('editPCPrepay').value = booking.prepay;
document.getElementById('editPCBookingModal').style.display = 'flex';
}
function deletePSBooking(psID) {
const ps = psConsoles[psID - 1];
if (!ps.booking) return;
const bookingName = ps.booking.name;
uiModule.showConfirm(
`Удалить бронь для ${bookingName}?`,
() => {
const bookingId = ps.booking.id;
ps.status = 'idle';
ps.booking = null;
savePSState();
renderPSConsoles();
notify('✅ Бронь удалена', 'Успешно');
if (bookingId) {
apiRequest(`/bookings/ps/${bookingId}`, { method: 'DELETE' })
.then(() => syncStateFromBackend())
.catch(() => notify('Ошибка синхронизации PS с сервером', 'Ошибка'));
}
},
'Удаление брони'
);
}
function openEditPSBooking(psID) {
currentEditPSID = psID;
const ps = psConsoles[psID - 1];
if (!ps.booking) return;
document.getElementById('editPSNum').textContent = psID;
document.getElementById('editPSBookingName').value = ps.booking.name;
document.getElementById('editPSBookingPhone').value = ps.booking.phone;
document.getElementById('editPSBookingTime').value = ps.booking.time.replace(':', '');
document.getElementById('editPSBookingDate').value = ps.booking.dateValue;
document.getElementById('editPSBookingModal').style.display = 'flex';
}
document.addEventListener('DOMContentLoaded', () => {
const psBookingPhone = document.getElementById('psBookingPhone');
if (psBookingPhone) {
psBookingPhone.addEventListener('focus', () => {
if (!psBookingPhone.value.startsWith('+7')) psBookingPhone.value = '+7 ';
setTimeout(() => psBookingPhone.setSelectionRange(psBookingPhone.value.length, psBookingPhone.value.length), 0);
});
psBookingPhone.addEventListener('input', function () {
const digits = cleanPhone(this.value);
this.value = formatPhone(digits);
});
}
const editPCPhone = document.getElementById('editPCPhone');
if (editPCPhone) {
editPCPhone.addEventListener('focus', () => {
if (!editPCPhone.value.startsWith('+7')) editPCPhone.value = '+7 ';
setTimeout(() => editPCPhone.setSelectionRange(editPCPhone.value.length, editPCPhone.value.length), 0);
});
editPCPhone.addEventListener('input', function () {
const digits = cleanPhone(this.value);
this.value = formatPhone(digits);
});
}
const editPSBookingPhone = document.getElementById('editPSBookingPhone');
if (editPSBookingPhone) {
editPSBookingPhone.addEventListener('focus', () => {
if (!editPSBookingPhone.value.startsWith('+7')) editPSBookingPhone.value = '+7 ';
setTimeout(() => editPSBookingPhone.setSelectionRange(editPSBookingPhone.value.length, editPSBookingPhone.value.length), 0);
});
editPSBookingPhone.addEventListener('input', function () {
const digits = cleanPhone(this.value);
this.value = formatPhone(digits);
});
}
});
document.getElementById('psBookingForm').addEventListener('submit', function(e) {
e.preventDefault();
const name = document.getElementById('psBookingName').value.trim();
const phone = document.getElementById('psBookingPhone').value.trim();
const timeRaw = document.getElementById('psBookingTime').value.trim();
const dateSelect = document.getElementById('psBookingDate');
const dateValue = dateSelect.value;
const dateDisplay = dateSelect.options[dateSelect.selectedIndex].textContent;
if (!name) return notify('Введите имя', 'Ошибка');
if (!/^\d{4}$/.test(timeRaw)) return notify('Время в формате HHMM', 'Ошибка');
const hours = parseInt(timeRaw.slice(0,2));
const minutes = parseInt(timeRaw.slice(2));
if (hours > 23 || minutes > 59) return notify('Некорректное время', 'Ошибка');
const time = timeRaw.slice(0,2) + ':' + timeRaw.slice(2);
if (!isBookingTimeValid(dateValue, time)) return notify('Нельзя забронировать на прошлое время', 'Ошибка');
const phoneDigits = cleanPhone(phone);
if (phoneDigits.length !== 10) return notify('Телефон — 10 цифр', 'Ошибка');
const formattedPhone = formatPhone(phoneDigits);
const ps = psConsoles[currentPSID - 1];
ps.status = 'booked';
ps.booking = {
name: name.charAt(0).toUpperCase() + name.slice(1),
phone: formattedPhone,
time: time,
dateValue: dateValue,
dateDisplay: dateDisplay,
adminName: currentAdmin ? currentAdmin.name : 'Неизвестно',
bookedAt: new Date().toISOString()
};
savePSState();
closePSBookingModal();
renderPSConsoles();
notify('✅ ПС забронирована', 'Успешно');
sendWhatsAppPSBooking(ps.booking.name, currentPSID, ps.booking.time, ps.booking.dateDisplay, ps.booking.phone);
apiRequest('/bookings/ps', {
method: 'POST',
body: JSON.stringify({
ps_id: currentPSID,
name: ps.booking.name,
phone: ps.booking.phone,
time: ps.booking.time,
date_value: ps.booking.dateValue,
date_display: ps.booking.dateDisplay
})
}).then((created) => {
ps.booking.id = created.id;
savePSState();
}).catch(() => {
ps.status = 'idle';
ps.booking = null;
savePSState();
renderPSConsoles();
notify('Ошибка синхронизации PS с сервером. Бронь отменена.', 'Ошибка');
});
});
document.getElementById('editPCBookingForm').addEventListener('submit', function(e) {
e.preventDefault();
if (currentEditPCBookingIndex === null) return;
let name = document.getElementById('editPCName').value.trim();
if (!name) return showError('Введите имя');
name = pcBookingsModule.normalizeName(name);
let pcInput = document.getElementById('editPCNumbers').value.trim();
let pcs = pcBookingsModule.parsePcList(pcInput);
const pcLimit = getCurrentPcCapacity();
if (!pcBookingsModule.isValidPcList(pcs, pcLimit)) {
return showError(`ПК от 1 до ${pcLimit}`);
}
const pc = pcs.join(',');
let timeRaw = document.getElementById('editPCTime').value.trim();
let time;
if (/^\d{4}$/.test(timeRaw)) {
const h = timeRaw.slice(0, 2);
const m = timeRaw.slice(2);
if (+h > 23 || +m > 59) return showError('Некорректное время');
time = h + ':' + m;
} else if (/^\d{2}:\d{2}$/.test(timeRaw)) {
const [h, m] = timeRaw.split(':');
if (+h > 23 || +m > 59) return showError('Некорректное время');
time = timeRaw;
} else {
return showError('Время в формате HHMM или HH:MM');
}
const dateSelect = document.getElementById('editPCDate');
const dateValue = dateSelect.value;
const dateDisplay = dateSelect.options[dateSelect.selectedIndex].textContent;
if (!isBookingTimeValid(dateValue, time)) return showError('Нельзя забронировать на прошлое время');
let conflict = false;
pcs.forEach(p => {
if (bookings.some((b, idx) => idx !== currentEditPCBookingIndex && b.dateValue === dateValue && b.pc.split(',').map(x => x.trim()).includes(p))) {
conflict = true;
}
});
if (conflict) return showError('Один или несколько ПК уже заняты на эту дату');
let phone = document.getElementById('editPCPhone').value.trim();
const phoneDigits = cleanPhone(phone);
if (phoneDigits.length !== 10) return showError('Телефон — 10 цифр');
phone = formatPhone(phoneDigits);
const prepay = document.getElementById('editPCPrepay').value.trim();
const booking = bookings[currentEditPCBookingIndex];
const snapshot = JSON.parse(JSON.stringify(booking));
booking.name = name;
booking.pc = pc;
booking.time = time;
booking.dateValue = dateValue;
booking.dateDisplay = dateDisplay;
booking.phone = phone;
booking.prepay = prepay;
saveAll();
syncUpdateBooking(booking).catch(() => {
Object.assign(booking, snapshot);
saveAll();
notify('Ошибка синхронизации с сервером. Изменения отменены.', 'Ошибка');
});
closeEditPCBookingModal();
notify('✅ Бронь обновлена', 'Успешно');
});
document.getElementById('editPSBookingForm').addEventListener('submit', function(e) {
e.preventDefault();
if (currentEditPSID === null) return;
const name = document.getElementById('editPSBookingName').value.trim();
const phone = document.getElementById('editPSBookingPhone').value.trim();
const timeRaw = document.getElementById('editPSBookingTime').value.trim();
const dateSelect = document.getElementById('editPSBookingDate');
const dateValue = dateSelect.value;
const dateDisplay = dateSelect.options[dateSelect.selectedIndex].textContent;
if (!name) return notify('Введите имя', 'Ошибка');
if (!/^\d{4}$/.test(timeRaw)) return notify('Время в формате HHMM', 'Ошибка');
const hours = parseInt(timeRaw.slice(0,2));
const minutes = parseInt(timeRaw.slice(2));
if (hours > 23 || minutes > 59) return notify('Некорректное время', 'Ошибка');
const time = timeRaw.slice(0,2) + ':' + timeRaw.slice(2);
if (!isBookingTimeValid(dateValue, time)) return notify('Нельзя забронировать на прошлое время', 'Ошибка');
const phoneDigits = cleanPhone(phone);
if (phoneDigits.length !== 10) return notify('Телефон — 10 цифр', 'Ошибка');
const formattedPhone = formatPhone(phoneDigits);
const ps = psConsoles[currentEditPSID - 1];
const snapshot = ps.booking ? JSON.parse(JSON.stringify(ps.booking)) : null;
ps.booking = {
name: name.charAt(0).toUpperCase() + name.slice(1),
phone: formattedPhone,
time: time,
dateValue: dateValue,
dateDisplay: dateDisplay,
adminName: ps.booking ? ps.booking.adminName : (currentAdmin ? currentAdmin.name : 'Неизвестно'),
bookedAt: ps.booking ? ps.booking.bookedAt : new Date().toISOString()
};
savePSState();
closeEditPSBookingModal();
renderPSConsoles();
notify('✅ Бронь изменена', 'Успешно');
if (ps.booking.id) {
apiRequest(`/bookings/ps/${ps.booking.id}`, {
method: 'PUT',
body: JSON.stringify({
ps_id: currentEditPSID,
name: ps.booking.name,
phone: ps.booking.phone,
time: ps.booking.time,
date_value: ps.booking.dateValue,
date_display: ps.booking.dateDisplay,
status: 'booked'
})
}).catch(() => {
ps.booking = snapshot;
savePSState();
renderPSConsoles();
notify('Ошибка синхронизации PS с сервером. Изменения отменены.', 'Ошибка');
});
}
});
function openPSEndSession(psID) {
currentPSID = psID;
const ps = psConsoles[psID - 1];
document.getElementById('psEndNum').textContent = psID;
if (ps.isFreeTime) {
const elapsed = (Date.now() - ps.startTime) / 60000;
const tariff = getPSTariff(psID);
const cost = roundCostToNearestFive((elapsed / 60) * tariff);
ps.totalPaid = cost;
}
document.getElementById('psTotalCost').textContent = ps.totalPaid;
document.getElementById('psEndSessionModal').style.display = 'flex';
}
function closePSEndSessionModal() {
document.getElementById('psEndSessionModal').style.display = 'none';
}
function confirmPSEnd() {
const ps = psConsoles[currentPSID - 1];
let finalCost = ps.totalPaid;
if (ps.isFreeTime) {
const elapsed = (Date.now() - ps.startTime) / 60000;
const tariff = getPSTariff(currentPSID);
finalCost = roundCostToNearestFive((elapsed / 60) * tariff);
}
ps.status = 'idle';
ps.prepaid = 0;
ps.remaining = 0;
ps.totalPaid = 0;
ps.addedTime = 0;
ps.selectedPackage = null;
ps.clientName = null;
ps.clientPhone = null;
ps.booking = null;
ps.isFreeTime = false; 
savePSState();
removeNotificationsByPsId(currentPSID);
closePSEndSessionModal();
renderPSConsoles();
apiRequest(`/ps/consoles/${currentPSID}/session/end`, {
method: 'POST',
body: JSON.stringify({ total_paid: finalCost })
}).then(() => syncStateFromBackend()).catch(() => notify('Ошибка синхронизации PS с сервером', 'Ошибка'));
}
function startPSTimer() {
if (psTimerInterval) clearInterval(psTimerInterval);
psTimerInterval = setInterval(() => {
let needsUpdate = false;
psConsoles.forEach(ps => {
if (ps.status === 'active' || ps.status === 'warning') {
const elapsed = (Date.now() - ps.startTime) / 60000;
if (ps.isFreeTime) {
ps.remaining = elapsed; 
} else {
ps.remaining = Math.max(0, ps.prepaid - elapsed);
if (ps.remaining === 0 && ps.status !== 'expired') {
ps.status = 'expired';
if ('speechSynthesis' in window) {
const msg = new SpeechSynthesisUtterance(`У PlayStation ${ps.id} закончилось время`);
msg.lang = 'ru-RU';
window.speechSynthesis.speak(msg);
}
// Add text notification to dashboard
addNotification(
  notificationTypes.PS_TIME_EXPIRED,
  `PlayStation ${ps.id} - время сессии истекло`,
  null,
  ps
);
needsUpdate = true;
} else if (ps.remaining <= config.ps.warningMinutes && ps.remaining > 0 && ps.status !== 'warning') {
ps.status = 'warning';
needsUpdate = true;
}
}
}
});
if (needsUpdate) {
savePSState();
renderPSConsoles();
} else {
psConsoles.forEach(ps => {
if (ps.status === 'active' || ps.status === 'warning') {
updatePSConsoleRow(ps);
}
});
}
}, 1000);
}
(async () => {
inviteContext.mode = getInviteModeFromPath();
inviteContext.token = getInviteTokenFromQuery();
setupAuthModeByContext();

if (isInviteFlow()) {
try {
await resolveInviteContext();
} catch (error) {
notify(error.message || 'Invite-ссылка недействительна', 'Ошибка');
}
}

try {
await loadClubContext();
} catch (error) {
reportClientError('Ошибка загрузки конфигурации клуба по slug', error);
return;
}
initPSConsoles();

if (currentAdmin && getAuthToken()) {
try {
const refreshed = await apiRequest('/auth/refresh', { method: 'POST' });
if (refreshed && refreshed.token) {
setAuthToken(refreshed.token);
}
const admin = refreshed && refreshed.admin ? refreshed.admin : null;
if (admin) {
const isClubScoped = admin.role === CLUB_ADMIN_ROLE || admin.role === CLUB_OWNER_ROLE;
if (isClubScoped && clubContext.id && Number(admin.club_id) !== Number(clubContext.id)) {
await logout();
notify('Сессия принадлежит другому клубу. Войдите заново.', 'Ошибка');
return;
}
currentAdmin = {
id: admin.id,
login: admin.login,
name: admin.name,
isRoot: !!admin.is_root,
isClubOwner: !!admin.is_club_owner,
clubId: admin.club_id,
role: admin.role
};
if (refreshed && refreshed.subscription) {
clubContext.subscription = resolveSubscriptionState(refreshed.subscription);
}
saveSessionAdmin(currentAdmin);
syncSidebarDrawerForViewport();
updateManagementNavVisibility();
}
renderSubscriptionState();
await syncStateFromBackend();
enforceSubscriptionLock();
ensurePreferredPlatform();
if (currentPlatform === 'ps') renderPSConsoles();
else renderTable();
startBookingNotificationMonitoring();
loadDashboardTasksWidget();
} catch (_) {
}
}
})();

function redirectToLoginScreen() {
const currentUrl = new URL(window.location.href);
currentUrl.hash = '';
window.location.replace(`${currentUrl.pathname}${currentUrl.search}`);
}

