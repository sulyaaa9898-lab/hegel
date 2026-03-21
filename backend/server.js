import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { initializeDatabase, closeDatabase, dbRun } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const [
  { default: authRoutes },
  { default: bookingsPcRoutes },
  { default: bookingsPsRoutes },
  { default: psConsolesRoutes },
  { default: guestsRoutes },
  { default: adminsRoutes },
  { default: auditRoutes },
  { default: ownerRoutes },
  { default: publicRoutes },
  { default: clubRoutes },
  { cleanupSecurityArtifacts },
  { BASE_URL }
] = await Promise.all([
  import('./routes/auth.js'),
  import('./routes/bookings-pc.js'),
  import('./routes/bookings-ps.js'),
  import('./routes/ps-consoles.js'),
  import('./routes/guests.js'),
  import('./routes/admins.js'),
  import('./routes/audit.js'),
  import('./routes/owner.js'),
  import('./routes/public.js'),
  import('./routes/club.js'),
  import('./utils/security.js'),
  import('./config/env.js')
]);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_DIR = path.join(__dirname, '..');

// Middleware
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-club-id']
}));

app.use(express.json());
app.use('/static', express.static(PUBLIC_DIR));
app.use('/club', express.static(ROOT_DIR, { index: false }));

const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.', code: 'RATE_LIMITED' }
});

const publicAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' }
});

app.use('/api/auth/login', authLoginLimiter);
app.use('/api/public/register', publicAuthLimiter);
app.use('/api/public/activate-owner', publicAuthLimiter);
app.use('/api/public/invites', publicAuthLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/club', clubRoutes);
app.use('/api/bookings/pc', bookingsPcRoutes);
app.use('/api/bookings/ps', bookingsPsRoutes);
app.use('/api/ps/consoles', psConsolesRoutes);
app.use('/api/guests', guestsRoutes);
app.use('/api/admins', adminsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/owner', ownerRoutes);

app.get('/owner', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'owner.html'));
});

app.get('/club/:slug', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/activate-owner', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// 404 handler
app.use(express.static(ROOT_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// Initialize database and start server
async function start() {
  try {
    const db = await initializeDatabase();

    app.locals.db = db;

    const server = app.listen(PORT, HOST);
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log('Base URL:', BASE_URL);

    const cleanupTimer = setInterval(async () => {
      try {
        await cleanupSecurityArtifacts(db, dbRun);
      } catch (error) {
        console.error('Security cleanup failed:', error.message);
      }
    }, 5 * 60 * 1000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down...');
      clearInterval(cleanupTimer);
      server.close();
      await closeDatabase(db);
      process.exit(0);
    });

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
