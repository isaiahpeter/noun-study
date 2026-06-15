import express        from 'express';
import cors           from 'cors';
import dotenv         from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync }  from 'fs';
import { db }         from './db/supabase.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
}));

app.use(express.json());

// ─── Logger ───────────────────────────────────────────────────────────────────

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}`);
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(join(__dirname, '../public')));

// ─── HTML pages ───────────────────────────────────────────────────────────────

const servePage = (file, replacements = {}) => (_req, res) => {
  let html = readFileSync(join(__dirname, '../public', file), 'utf8');
  // Inject runtime config into HTML (Supabase URL etc.)
  Object.entries(replacements).forEach(([k, v]) => {
    html = html.replace(new RegExp(k, 'g'), v);
  });
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

const supaVars = {
  '__SUPABASE_URL__' : process.env.SUPABASE_URL  || '',
  '__SUPABASE_ANON__': process.env.SUPABASE_ANON_KEY || '',
};

app.get('/',       (_req, res) => res.redirect('/study'));
app.get('/study',  servePage('study-ui.html',  supaVars));
app.get('/login',  servePage('auth-ui.html',   supaVars));
app.get('/admin',  servePage('admin-ui.html',  supaVars));

// ─── API Routes ───────────────────────────────────────────────────────────────

import coursesRouter  from './routes/courses.js';
import searchRouter   from './routes/search.js';
import ingestRouter   from './routes/ingest.js';
import paymentsRouter from './routes/payments.js';
import authRouter     from './routes/auth.js';
import studyRouter    from './routes/study.js';

app.use('/api/courses',  coursesRouter);
app.use('/api/search',   searchRouter);
app.use('/api/ingest',   ingestRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/auth',     authRouter);
app.use('/api/study',    studyRouter);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    await db.ping();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ─── 404 / Error ──────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 NOUN Study API — port ${PORT}`);
  console.log(`   Study  → http://localhost:${PORT}/study`);
  console.log(`   Login  → http://localhost:${PORT}/login`);
  console.log(`   Admin  → http://localhost:${PORT}/admin\n`);
});

export default app;

