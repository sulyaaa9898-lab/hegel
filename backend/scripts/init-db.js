import bcryptjs from 'bcryptjs';
import { initializeDatabase, dbGet, dbRun, closeDatabase } from '../db.js';

/**
 * Initialize database with root admin
 * This script should be run once to set up the database
 */
async function initDatabase() {
  try {
    const db = await initializeDatabase();
    console.log('📦 Database initialized');

    // Create root admin
    const rootLogin = 'Algaib';
    const rootPassword = '61659398';
    const rootName = 'Султан';

    // Check if root admin exists
    const existingRoot = await dbGet(
      db,
      'SELECT id FROM admins WHERE login = ?',
      [rootLogin]
    );

    if (existingRoot) {
      console.log('✅ Root admin already exists (ID:', existingRoot.id, ')');
      await closeDatabase(db);
      return;
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcryptjs.hash(rootPassword, saltRounds);

    // Insert root admin
    const result = await dbRun(
      db,
      `INSERT INTO admins (login, password_hash, name, role, is_root, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rootLogin, passwordHash, rootName, 'root', 1, new Date().toISOString()]
    );

    console.log('✅ Root admin created:');
    console.log(`   ID: ${result.id}`);
    console.log(`   Login: ${rootLogin}`);
    console.log(`   Name: ${rootName}`);
    console.log(`   Password hash: ${passwordHash.substring(0, 20)}...`);

    // Log the creation
    await dbRun(
      db,
      `INSERT INTO audit_logs (admin_id, admin_login, action, entity, entity_id, before_state, after_state, timestamp, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.id,
        rootLogin,
        'CREATE_ADMIN',
        'admin',
        result.id,
        null,
        JSON.stringify({ id: result.id, login: rootLogin, name: rootName, role: 'root' }),
        new Date().toISOString(),
        'system'
      ]
    );

    console.log('✅ Audit log created for root admin creation');

    await closeDatabase(db);
    console.log('\n✨ Database initialization complete!');

  } catch (err) {
    console.error('❌ Error initializing database:', err);
    process.exit(1);
  }
}

initDatabase();
