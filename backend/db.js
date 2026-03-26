import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import bcryptjs from 'bcryptjs';
import { nowIso } from './utils/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'cyber_stack.db');
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const CLUB_ADMIN_ROLE = 'CLUB_ADMIN';
const CLUB_OWNER_ROLE = 'CLUB_OWNER';
let clubOwnerSchemaEnsured = false;
let clubOwnerSchemaPromise = null;

/**
 * Initialize SQLite database with schema
 */
export function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }

      console.log(`📦 Database connected: ${DB_PATH}`);

      // Enable foreign keys
      db.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Create tables
        createTables(db)
          .then(() => runMigrations(db))
          .then(() => ensureDefaultRootAdmin(db))
          .then(() => {
            console.log('✅ Database schema initialized');
            resolve(db);
          })
          .catch(reject);
      });
    });
  });
}

/**
 * Create all tables if they don't exist
 */
async function createTables(db) {
  return new Promise((resolve, reject) => {
    const queries = [
      // CLUBS table
      `CREATE TABLE IF NOT EXISTS clubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        club_type TEXT,
        is_enabled BOOLEAN NOT NULL DEFAULT 1,
        subscription_status TEXT NOT NULL DEFAULT 'trial' CHECK(subscription_status IN ('trial', 'active', 'expired', 'blocked')),
        subscription_type TEXT NOT NULL DEFAULT 'trial',
        subscription_started_at TEXT,
        subscription_expires_at TEXT,
        trial_ends_at TEXT,
        subscription_ends_at TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Almaty',
        is_configured BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`,

      // ADMINS table
      `CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'root')),
        is_root BOOLEAN DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT
      )`,

      // CLUB DEVICES table
      `CREATE TABLE IF NOT EXISTS club_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        device_type TEXT NOT NULL CHECK(device_type IN ('PC', 'PS')),
        device_code TEXT NOT NULL,
        display_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        tariff_group TEXT,
        is_active BOOLEAN NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(club_id) REFERENCES clubs(id)
      )`,

      // CLUB TARIFFS table
      `CREATE TABLE IF NOT EXISTS club_tariffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        device_type TEXT NOT NULL CHECK(device_type IN ('PC', 'PS')),
        tariff_name TEXT NOT NULL,
        billing_type TEXT NOT NULL CHECK(billing_type IN ('hourly', 'package')),
        price INTEGER NOT NULL,
        duration_minutes INTEGER,
        applies_to_type TEXT NOT NULL DEFAULT 'ALL' CHECK(applies_to_type IN ('ALL', 'GROUP', 'DEVICE')),
        applies_to_value TEXT,
        is_active BOOLEAN NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(club_id) REFERENCES clubs(id)
      )`,

      // CLUB CONFIG VERSIONS table
      `CREATE TABLE IF NOT EXISTS club_config_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_by_admin_id INTEGER,
        created_at TEXT NOT NULL,
        is_applied BOOLEAN NOT NULL DEFAULT 1,
        FOREIGN KEY(club_id) REFERENCES clubs(id),
        FOREIGN KEY(created_by_admin_id) REFERENCES admins(id)
      )`,

      // PC BOOKINGS table
      `CREATE TABLE IF NOT EXISTS bookings_pc (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        booking_uid TEXT,
        name TEXT NOT NULL,
        pc TEXT NOT NULL,
        time TEXT NOT NULL,
        date_value TEXT NOT NULL,
        date_display TEXT,
        phone TEXT,
        prepay TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'arrived', 'late', 'cancelled', 'no-show')),
        pc_statuses TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(admin_id) REFERENCES admins(id)
      )`,

      // PS BOOKINGS table
      `CREATE TABLE IF NOT EXISTS bookings_ps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        booking_uid TEXT,
        ps_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        time TEXT NOT NULL,
        date_value TEXT NOT NULL,
        date_display TEXT,
        status TEXT DEFAULT 'booked' CHECK(status IN ('booked', 'started', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(admin_id) REFERENCES admins(id)
      )`,

      // PS SESSIONS table
      `CREATE TABLE IF NOT EXISTS ps_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ps_id INTEGER NOT NULL,
        booking_id INTEGER,
        start_time TEXT NOT NULL,
        prepaid_minutes REAL,
        total_paid INTEGER,
        added_time REAL,
        selected_package TEXT,
        client_name TEXT,
        client_phone TEXT,
        is_free_time BOOLEAN DEFAULT 0,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(booking_id) REFERENCES bookings_ps(id)
      )`,

      // GUEST RATINGS table
      `CREATE TABLE IF NOT EXISTS guest_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE NOT NULL,
        rating REAL DEFAULT 100,
        total_bookings INTEGER DEFAULT 0,
        arrived INTEGER DEFAULT 0,
        late INTEGER DEFAULT 0,
        cancelled INTEGER DEFAULT 0,
        no_show INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

      // AUDIT LOGS table
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        admin_login TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN (
          'LOGIN', 'LOGOUT',
          'CREATE_BOOKING_PC', 'UPDATE_BOOKING_PC', 'DELETE_BOOKING_PC',
          'MARK_ARRIVED', 'MARK_LATE', 'MARK_CANCELLED', 'MARK_NO_SHOW',
          'CREATE_BOOKING_PS', 'UPDATE_BOOKING_PS', 'DELETE_BOOKING_PS',
          'PS_SESSION_START', 'PS_SESSION_END', 'PS_ADD_TIME',
          'CREATE_ADMIN', 'DELETE_ADMIN',
          'PASSWORD_CHANGE'
        )),
        entity TEXT CHECK(entity IN ('user', 'booking_pc', 'booking_ps', 'ps_session', 'guest_rating', 'admin')),
        entity_id INTEGER,
        before_state TEXT,
        after_state TEXT,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source TEXT DEFAULT 'web' CHECK(source IN ('web', 'api', 'system')),
        ip_address TEXT,
        FOREIGN KEY(admin_id) REFERENCES admins(id)
      )`,

      // TOKEN BLACKLIST table (для logout)
      `CREATE TABLE IF NOT EXISTS token_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        admin_id INTEGER NOT NULL,
        blacklisted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(admin_id) REFERENCES admins(id)
      )`,

      // INVITE TOKENS table (owner/admin registration only by token)
      `CREATE TABLE IF NOT EXISTS invite_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        created_by_admin_id INTEGER,
        invite_type TEXT NOT NULL CHECK(invite_type IN ('OWNER', 'ADMIN')),
        token_value TEXT,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_by_admin_id INTEGER,
        FOREIGN KEY(club_id) REFERENCES clubs(id),
        FOREIGN KEY(created_by_admin_id) REFERENCES admins(id),
        FOREIGN KEY(used_by_admin_id) REFERENCES admins(id)
      )`,

      // Active admin sessions (single CLUB_ADMIN slot per club)
      `CREATE TABLE IF NOT EXISTS admin_active_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL UNIQUE,
        admin_id INTEGER NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(club_id) REFERENCES clubs(id),
        FOREIGN KEY(admin_id) REFERENCES admins(id)
      )`,

      // CLUB TASKS table
      `CREATE TABLE IF NOT EXISTS club_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        is_done INTEGER NOT NULL DEFAULT 0,
        is_urgent INTEGER NOT NULL DEFAULT 0,
        created_by_admin_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        deleted_at TEXT,
        FOREIGN KEY(club_id) REFERENCES clubs(id),
        FOREIGN KEY(created_by_admin_id) REFERENCES admins(id)
      )`,

      // Create indices
      `CREATE INDEX IF NOT EXISTS idx_bookings_pc_date ON bookings_pc(date_value)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_pc_phone ON bookings_pc(phone)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_pc_status ON bookings_pc(status)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_ps_ps_id ON bookings_ps(ps_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ps_sessions_ps_id ON ps_sessions(ps_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_guest_ratings_phone ON guest_ratings(phone)`,
      `CREATE INDEX IF NOT EXISTS idx_token_blacklist_admin ON token_blacklist(admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_invite_tokens_club_type ON invite_tokens(club_id, invite_type, used_at, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_invite_tokens_expires_at ON invite_tokens(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_admin_active_sessions_admin ON admin_active_sessions(admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_admin_active_sessions_expires_at ON admin_active_sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_club_tasks_club_id ON club_tasks(club_id)`,
      `CREATE INDEX IF NOT EXISTS idx_club_tasks_done_urgent ON club_tasks(club_id, is_done, is_urgent)`,
      `CREATE INDEX IF NOT EXISTS idx_club_tasks_created_at ON club_tasks(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_clubs_slug ON clubs(slug)`,
      `CREATE INDEX IF NOT EXISTS idx_clubs_status ON clubs(subscription_status, is_enabled)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_club_devices_unique ON club_devices(club_id, device_type, device_code)`,
      `CREATE INDEX IF NOT EXISTS idx_club_devices_scope ON club_devices(club_id, device_type, is_active)`,
      `CREATE INDEX IF NOT EXISTS idx_club_tariffs_scope ON club_tariffs(club_id, device_type, is_active)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_club_config_versions_unique ON club_config_versions(club_id, version)`
    ];

    let completed = 0;

    function runNextQuery(index) {
      if (index >= queries.length) {
        resolve();
        return;
      }

      db.run(queries[index], (err) => {
        if (err) {
          // Ignore "already exists" errors
          if (!err.message.includes('already exists')) {
            reject(err);
            return;
          }
        }
        runNextQuery(index + 1);
      });
    }

    runNextQuery(0);
  });
}

async function runMigrations(db) {
  await ensureDefaultClub(db);
  await ensureColumn(db, 'admins', 'saas_role', `TEXT CHECK(saas_role IN ('${SUPER_ADMIN_ROLE}', '${CLUB_ADMIN_ROLE}'))`);
  await ensureClubOwnerSchema(db);
  await ensureColumn(db, 'admins', 'club_id', 'INTEGER');
  await ensureColumn(db, 'bookings_pc', 'club_id', 'INTEGER');
  await ensureColumn(db, 'bookings_ps', 'club_id', 'INTEGER');
  await ensureColumn(db, 'bookings_pc', 'booking_uid', 'TEXT');
  await ensureColumn(db, 'bookings_ps', 'booking_uid', 'TEXT');
  await ensureColumn(db, 'ps_sessions', 'club_id', 'INTEGER');
  await ensureColumn(db, 'guest_ratings', 'club_id', 'INTEGER');
  await ensureColumn(db, 'audit_logs', 'club_id', 'INTEGER');
  await ensureColumn(db, 'token_blacklist', 'club_id', 'INTEGER');
  await ensureColumn(
    db,
    'club_tariffs',
    'applies_to_type',
    `TEXT NOT NULL DEFAULT 'ALL' CHECK(applies_to_type IN ('ALL', 'GROUP', 'DEVICE'))`
  );
  await ensureColumn(db, 'club_tariffs', 'applies_to_value', 'TEXT');
  await ensureColumn(db, 'clubs', 'club_type', 'TEXT');
  await ensureColumn(db, 'clubs', 'subscription_type', `TEXT NOT NULL DEFAULT 'trial'`);
  await ensureColumn(db, 'clubs', 'subscription_started_at', 'TEXT');
  await ensureColumn(db, 'clubs', 'subscription_expires_at', 'TEXT');
  await ensureColumn(db, 'invite_tokens', 'token_value', 'TEXT');
  await ensureColumn(db, 'club_devices', 'tariff_group', 'TEXT');

  await dbRun(
    db,
    `UPDATE clubs
     SET subscription_type = CASE
       WHEN subscription_type IS NULL OR subscription_type = ''
         THEN CASE WHEN subscription_status = 'trial' THEN 'trial' ELSE 'monthly' END
       ELSE subscription_type
     END`
  );

  await dbRun(
    db,
    `UPDATE clubs
     SET subscription_started_at = COALESCE(subscription_started_at, created_at, ?)` ,
    [nowIso()]
  );

  await dbRun(
    db,
    `UPDATE clubs
     SET subscription_expires_at = COALESCE(subscription_expires_at, subscription_ends_at, trial_ends_at)`
  );

  await dbRun(
    db,
    `UPDATE clubs
     SET subscription_expires_at = datetime(subscription_started_at, '+30 day')
     WHERE subscription_expires_at IS NULL
       AND subscription_type = 'monthly'`
  );

  await dbRun(
    db,
    `UPDATE clubs
     SET subscription_expires_at = datetime(subscription_started_at, '+7 day')
     WHERE subscription_expires_at IS NULL
       AND subscription_type = 'trial'`
  );

  await repairAdminForeignKeyTargets(db);
  await migrateAdminsToScopedLogin(db);

  await migrateGuestRatingsForMultiTenant(db);

  const defaultClub = await dbGet(
    db,
    'SELECT id FROM clubs WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
    ['default-club']
  );

  if (!defaultClub) {
    throw new Error('Default club is required for migrations');
  }

  await dbRun(
    db,
    `UPDATE admins
     SET saas_role = CASE WHEN is_root = 1 THEN ? ELSE ? END
     WHERE saas_role IS NULL`,
    [SUPER_ADMIN_ROLE, CLUB_ADMIN_ROLE]
  );

  await dbRun(
    db,
    `UPDATE admins
     SET club_id = ?
     WHERE (club_id IS NULL OR club_id = 0)
       AND (saas_role = ? OR is_root = 0)`,
    [defaultClub.id, CLUB_ADMIN_ROLE]
  );

  await dbRun(
    db,
    `UPDATE admins
     SET club_id = NULL
     WHERE saas_role = ? OR is_root = 1`,
    [SUPER_ADMIN_ROLE]
  );

  await dbRun(db, 'UPDATE bookings_pc SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);
  await dbRun(db, 'UPDATE bookings_ps SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);
  await dbRun(
    db,
    `UPDATE bookings_pc
      SET booking_uid = 'PC-' || LOWER(HEX(RANDOMBLOB(2))) || '@' || LOWER(HEX(RANDOMBLOB(2)))
      WHERE booking_uid IS NULL
        OR TRIM(booking_uid) = ''
        OR (booking_uid GLOB 'PC-[0-9]*' AND booking_uid NOT LIKE '%@%')`
  );
  await dbRun(
    db,
    `UPDATE bookings_ps
      SET booking_uid = 'PS-' || LOWER(HEX(RANDOMBLOB(2))) || '@' || LOWER(HEX(RANDOMBLOB(2)))
      WHERE booking_uid IS NULL
        OR TRIM(booking_uid) = ''
        OR (booking_uid GLOB 'PS-[0-9]*' AND booking_uid NOT LIKE '%@%')`
  );
  await dbRun(db, 'UPDATE ps_sessions SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);
  await dbRun(db, 'UPDATE guest_ratings SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);
  await dbRun(db, 'UPDATE audit_logs SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);
  await dbRun(db, 'UPDATE token_blacklist SET club_id = ? WHERE club_id IS NULL OR club_id = 0', [defaultClub.id]);

  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_admins_club_id ON admins(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_bookings_pc_club_id ON bookings_pc(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_bookings_ps_club_id ON bookings_ps(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_bookings_pc_booking_uid ON bookings_pc(booking_uid)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_bookings_ps_booking_uid ON bookings_ps(booking_uid)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_ps_sessions_club_id ON ps_sessions(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_guest_ratings_club_id ON guest_ratings(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_audit_logs_club_id ON audit_logs(club_id)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_audit_logs_club_timestamp ON audit_logs(club_id, timestamp)');
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_token_blacklist_club_id ON token_blacklist(club_id)');
  await ensureColumn(db, 'admins', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * Clean up old audit logs (keep last 6 months)
 */
async function cleanupOldAuditLogs(db) {
  try {
    const result = await dbRun(
      db,
      `DELETE FROM audit_logs WHERE timestamp < datetime('now', '-6 months')`
    );
    if (result.changes > 0) {
      console.log(`🧹 Cleaned up ${result.changes} old audit logs (older than 6 months)`);
    }
  } catch (err) {
    console.error('Error cleaning up audit logs:', err.message);
  }
}

/**
 * Schedule daily audit log cleanup (runs at midnight every day)
 */
export function scheduleAuditLogCleanup(db) {
  // Calculate milliseconds until next midnight
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const msUntilMidnight = tomorrow - now;

  // Run cleanup at midnight
  setTimeout(() => {
    cleanupOldAuditLogs(db);
    // Then repeat every 24 hours
    setInterval(() => cleanupOldAuditLogs(db), 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log(`⏰ Audit log cleanup scheduled for 00:00 daily`);
}

async function tableReferencesAdminsOld(db, tableName) {
  const rows = await dbAll(db, `PRAGMA foreign_key_list(${tableName})`);
  return rows.some((row) => String(row.table || '').toLowerCase() === 'admins_old');
}

async function recreateTableWithSql(db, tableName, createSql, insertSql, indexSqlList) {
  const newName = `${tableName}_new`;
  await dbRun(db, createSql.replace(/__NEW_TABLE__/g, newName));
  await dbRun(db, insertSql.replace(/__NEW_TABLE__/g, newName).replace(/__OLD_TABLE__/g, tableName));
  await dbRun(db, `DROP TABLE ${tableName}`);
  await dbRun(db, `ALTER TABLE ${newName} RENAME TO ${tableName}`);
  for (const sql of indexSqlList) {
    await dbRun(db, sql);
  }
}

async function repairAdminForeignKeyTargets(db) {
  const targets = ['bookings_pc', 'bookings_ps', 'audit_logs', 'token_blacklist', 'club_config_versions'];
  const affected = [];
  for (const tableName of targets) {
    if (await tableReferencesAdminsOld(db, tableName)) {
      affected.push(tableName);
    }
  }
  if (affected.length === 0) return;

  await dbRun(db, 'PRAGMA foreign_keys = OFF');
  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    if (affected.includes('bookings_pc')) {
      await recreateTableWithSql(
        db,
        'bookings_pc',
        `CREATE TABLE __NEW_TABLE__ (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          pc TEXT NOT NULL,
          time TEXT NOT NULL,
          date_value TEXT NOT NULL,
          date_display TEXT,
          phone TEXT,
          prepay TEXT,
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'arrived', 'late', 'cancelled', 'no-show')),
          pc_statuses TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          club_id INTEGER,
          FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`,
        `INSERT INTO __NEW_TABLE__ (
          id, admin_id, name, pc, time, date_value, date_display, phone, prepay, status, pc_statuses,
          created_at, updated_at, deleted_at, club_id
        )
        SELECT
          id, admin_id, name, pc, time, date_value, date_display, phone, prepay, status, pc_statuses,
          created_at, updated_at, deleted_at, club_id
        FROM __OLD_TABLE__`,
        [
          'CREATE INDEX IF NOT EXISTS idx_bookings_pc_date ON bookings_pc(date_value)',
          'CREATE INDEX IF NOT EXISTS idx_bookings_pc_phone ON bookings_pc(phone)',
          'CREATE INDEX IF NOT EXISTS idx_bookings_pc_status ON bookings_pc(status)',
          'CREATE INDEX IF NOT EXISTS idx_bookings_pc_club_id ON bookings_pc(club_id)'
        ]
      );
    }

    if (affected.includes('bookings_ps')) {
      await recreateTableWithSql(
        db,
        'bookings_ps',
        `CREATE TABLE __NEW_TABLE__ (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER NOT NULL,
          ps_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          phone TEXT,
          time TEXT NOT NULL,
          date_value TEXT NOT NULL,
          date_display TEXT,
          status TEXT DEFAULT 'booked' CHECK(status IN ('booked', 'started', 'completed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          club_id INTEGER,
          FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`,
        `INSERT INTO __NEW_TABLE__ (
          id, admin_id, ps_id, name, phone, time, date_value, date_display, status,
          created_at, updated_at, deleted_at, club_id
        )
        SELECT
          id, admin_id, ps_id, name, phone, time, date_value, date_display, status,
          created_at, updated_at, deleted_at, club_id
        FROM __OLD_TABLE__`,
        [
          'CREATE INDEX IF NOT EXISTS idx_bookings_ps_ps_id ON bookings_ps(ps_id)',
          'CREATE INDEX IF NOT EXISTS idx_bookings_ps_club_id ON bookings_ps(club_id)'
        ]
      );
    }

    if (affected.includes('audit_logs')) {
      await recreateTableWithSql(
        db,
        'audit_logs',
        `CREATE TABLE __NEW_TABLE__ (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER NOT NULL,
          admin_login TEXT NOT NULL,
          action TEXT NOT NULL,
          entity TEXT,
          entity_id INTEGER,
          before_state TEXT,
          after_state TEXT,
          timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          source TEXT DEFAULT 'web' CHECK(source IN ('web', 'api', 'system')),
          ip_address TEXT,
          club_id INTEGER,
          FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`,
        `INSERT INTO __NEW_TABLE__ (
          id, admin_id, admin_login, action, entity, entity_id, before_state, after_state,
          timestamp, source, ip_address, club_id
        )
        SELECT
          id, admin_id, admin_login, action, entity, entity_id, before_state, after_state,
          timestamp, source, ip_address, club_id
        FROM __OLD_TABLE__`,
        [
          'CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(admin_id)',
          'CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)',
          'CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)',
          'CREATE INDEX IF NOT EXISTS idx_audit_logs_club_id ON audit_logs(club_id)'
        ]
      );
    }

    if (affected.includes('token_blacklist')) {
      await recreateTableWithSql(
        db,
        'token_blacklist',
        `CREATE TABLE __NEW_TABLE__ (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT UNIQUE NOT NULL,
          admin_id INTEGER NOT NULL,
          blacklisted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT NOT NULL,
          club_id INTEGER,
          FOREIGN KEY(admin_id) REFERENCES admins(id)
        )`,
        `INSERT INTO __NEW_TABLE__ (
          id, token_hash, admin_id, blacklisted_at, expires_at, club_id
        )
        SELECT
          id, token_hash, admin_id, blacklisted_at, expires_at, club_id
        FROM __OLD_TABLE__`,
        [
          'CREATE INDEX IF NOT EXISTS idx_token_blacklist_admin ON token_blacklist(admin_id)',
          'CREATE INDEX IF NOT EXISTS idx_token_blacklist_club_id ON token_blacklist(club_id)'
        ]
      );
    }

    if (affected.includes('club_config_versions')) {
      await recreateTableWithSql(
        db,
        'club_config_versions',
        `CREATE TABLE __NEW_TABLE__ (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          club_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          config_json TEXT NOT NULL,
          created_by_admin_id INTEGER,
          created_at TEXT NOT NULL,
          is_applied BOOLEAN NOT NULL DEFAULT 1,
          FOREIGN KEY(club_id) REFERENCES clubs(id),
          FOREIGN KEY(created_by_admin_id) REFERENCES admins(id)
        )`,
        `INSERT INTO __NEW_TABLE__ (
          id, club_id, version, config_json, created_by_admin_id, created_at, is_applied
        )
        SELECT
          id, club_id, version, config_json, created_by_admin_id, created_at, is_applied
        FROM __OLD_TABLE__`,
        [
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_club_config_versions_unique ON club_config_versions(club_id, version)'
        ]
      );
    }

    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK');
    throw error;
  } finally {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
  }
}

async function migrateAdminsToScopedLogin(db) {
  const indices = await dbAll(db, 'PRAGMA index_list(admins)');
  const hasScopedIndex = indices.some((index) => index.name === 'uniq_admins_active_scoped_login');
  const hasNullScopeIndex = indices.some((index) => index.name === 'uniq_admins_active_global_login');
  if (hasScopedIndex && hasNullScopeIndex) return;

  await dbRun(db, 'PRAGMA foreign_keys = OFF');
  await dbRun(db, 'BEGIN TRANSACTION');
  try {
    await dbRun(
      db,
      `CREATE TABLE admins_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'root')),
        is_root BOOLEAN DEFAULT 0,
        saas_role TEXT CHECK(saas_role IN ('SUPER_ADMIN', 'CLUB_ADMIN')),
        is_club_owner INTEGER NOT NULL DEFAULT 0,
        club_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT,
        FOREIGN KEY(club_id) REFERENCES clubs(id)
      )`
    );

    await dbRun(
      db,
      `INSERT INTO admins_new (
        id, login, password_hash, name, role, is_root, saas_role, is_club_owner, club_id, created_at, deleted_at
      )
      SELECT
        id,
        login,
        password_hash,
        name,
        role,
        COALESCE(is_root, 0),
        saas_role,
        COALESCE(is_club_owner, 0),
        club_id,
        created_at,
        deleted_at
      FROM admins`
    );

    await dbRun(db, 'DROP TABLE admins');
    await dbRun(db, 'ALTER TABLE admins_new RENAME TO admins');

    await dbRun(
      db,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_admins_active_scoped_login
       ON admins(club_id, login)
       WHERE deleted_at IS NULL AND club_id IS NOT NULL`
    );

    await dbRun(
      db,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_admins_active_global_login
       ON admins(login)
       WHERE deleted_at IS NULL AND club_id IS NULL`
    );

    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_admins_login ON admins(login)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_admins_club_id ON admins(club_id)');

    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK');
    throw error;
  } finally {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
  }
}

async function ensureDefaultClub(db) {
  const existing = await dbGet(
    db,
    'SELECT id FROM clubs WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
    ['default-club']
  );

  if (existing) return existing.id;

  const timestamp = nowIso();
  const created = await dbRun(
    db,
    `INSERT INTO clubs (
      slug, name, is_enabled, subscription_status, timezone, is_configured, created_at, updated_at
    ) VALUES (?, ?, 1, 'active', 'Asia/Almaty', 1, ?, ?)`,
    ['default-club', 'Default Club', timestamp, timestamp]
  );

  return created.id;
}

async function ensureColumn(db, tableName, columnName, definition) {
  const columns = await dbAll(db, `PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);
  if (exists) return;
  try {
    await dbRun(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    // In concurrent startup/request scenarios another flow may add the same column first.
    if (String(error?.message || '').toLowerCase().includes('duplicate column name')) {
      return;
    }
    throw error;
  }
}

export async function ensureClubOwnerSchema(db) {
  if (clubOwnerSchemaEnsured) return;
  if (clubOwnerSchemaPromise) {
    await clubOwnerSchemaPromise;
    return;
  }

  clubOwnerSchemaPromise = (async () => {
    await ensureColumn(db, 'admins', 'is_club_owner', 'INTEGER NOT NULL DEFAULT 0');
    await dbRun(
      db,
      `UPDATE admins
       SET is_club_owner = 0
       WHERE is_club_owner IS NULL`
    );
    clubOwnerSchemaEnsured = true;
  })();

  try {
    await clubOwnerSchemaPromise;
  } finally {
    clubOwnerSchemaPromise = null;
  }
}

async function migrateGuestRatingsForMultiTenant(db) {
  const columns = await dbAll(db, 'PRAGMA table_info(guest_ratings)');
  const hasClubId = columns.some((column) => column.name === 'club_id');
  if (!hasClubId) return;

  const indices = await dbAll(db, 'PRAGMA index_list(guest_ratings)');
  const hasCompositeUnique = indices.some((index) => index.name === 'uniq_guest_ratings_club_phone');
  if (hasCompositeUnique) return;

  const timestamp = nowIso();
  await dbRun(db, 'BEGIN TRANSACTION');

  try {
    await dbRun(
      db,
      `CREATE TABLE IF NOT EXISTS guest_ratings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        rating REAL DEFAULT 100,
        total_bookings INTEGER DEFAULT 0,
        arrived INTEGER DEFAULT 0,
        late INTEGER DEFAULT 0,
        cancelled INTEGER DEFAULT 0,
        no_show INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(club_id, phone),
        FOREIGN KEY(club_id) REFERENCES clubs(id)
      )`
    );

    await dbRun(
      db,
      `INSERT INTO guest_ratings_new (
        id, club_id, phone, rating, total_bookings, arrived, late, cancelled, no_show, created_at, updated_at
      )
      SELECT
        id,
        COALESCE(club_id, 1),
        phone,
        rating,
        total_bookings,
        arrived,
        late,
        cancelled,
        no_show,
        COALESCE(created_at, ?),
        COALESCE(updated_at, ?)
      FROM guest_ratings`,
      [timestamp, timestamp]
    );

    await dbRun(db, 'DROP TABLE guest_ratings');
    await dbRun(db, 'ALTER TABLE guest_ratings_new RENAME TO guest_ratings');
    await dbRun(db, 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_guest_ratings_club_phone ON guest_ratings(club_id, phone)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_guest_ratings_phone ON guest_ratings(phone)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_guest_ratings_club_id ON guest_ratings(club_id)');

    await dbRun(db, 'COMMIT');
  } catch (error) {
    await dbRun(db, 'ROLLBACK');
    throw error;
  }
}

async function ensureDefaultRootAdmin(db) {
  const rootLogin = 'Algaib';
  const rootPassword = '61659398';
  const rootName = 'Султан';
  const defaultClub = await dbGet(
    db,
    'SELECT id FROM clubs WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
    ['default-club']
  );

  const existingRoot = await dbGet(
    db,
    'SELECT id FROM admins WHERE login = ? AND deleted_at IS NULL LIMIT 1',
    [rootLogin]
  );

  if (existingRoot) return;

  const passwordHash = await bcryptjs.hash(rootPassword, 10);
  const createdAt = new Date().toISOString();

  const created = await dbRun(
    db,
    `INSERT INTO admins (login, password_hash, name, role, is_root, saas_role, club_id, created_at)
     VALUES (?, ?, ?, 'root', 1, ?, NULL, ?)`,
    [rootLogin, passwordHash, rootName, SUPER_ADMIN_ROLE, createdAt]
  );

  await dbRun(
    db,
    `INSERT INTO audit_logs (
      club_id, admin_id, admin_login, action, entity, entity_id,
      before_state, after_state, timestamp, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      defaultClub ? defaultClub.id : null,
      created.id,
      rootLogin,
      'CREATE_ADMIN',
      'admin',
      created.id,
      null,
      JSON.stringify({
        id: created.id,
        login: rootLogin,
        name: rootName,
        role: 'root',
        is_root: 1
      }),
      createdAt,
      'system'
    ]
  );
}

/**
 * Get database connection
 */
export function getDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
      } else {
        db.run('PRAGMA foreign_keys = ON', (err) => {
          if (err) reject(err);
          else resolve(db);
        });
      }
    });
  });
}

/**
 * Run a query and return all results
 */
export function dbAll(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Run a query and return first result
 */
export function dbGet(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Run a query (INSERT, UPDATE, DELETE) and return changes info
 */
export function dbRun(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Close database connection
 */
export function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else {
        console.log('🔌 Database connection closed');
        resolve();
      }
    });
  });
}
