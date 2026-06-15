import { Router }      from 'express';
import { verifyToken } from '../db/supabase.js';

const router = Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────
// Attach to any route that needs a logged-in user

export const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = header.split(' ')[1];
  const user  = await verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
};

// ─── Access check middleware ──────────────────────────────────────────────────
// Check if user has paid access to a course
// Attaches req.hasAccess = true/false

export const checkAccess = async (req, _res, next) => {
  if (!req.user) { next(); return; }

  const courseCode = req.body?.courseCode || req.query?.courseCode || req.params?.code;
  if (!courseCode) { req.hasAccess = false; next(); return; }

  const { db } = await import('../db/supabase.js');

  // Check for semester pass (course_code is null) or specific course access
  const rows = await db.from('user_access').select('id,access_type,expires_at', {
    user_id    : `eq.${req.user.id}`,
  }).catch(() => []);

  const now = new Date();

  const hasAccess = (rows || []).some(row => {
    // Expired access
    if (row.expires_at && new Date(row.expires_at) < now) return false;
    // Semester pass — access to everything
    if (row.access_type === 'semester_pass') return true;
    // Per-course access — need to check course_code separately
    return false;
  });

  // Also check per-course access
  if (!hasAccess) {
    const courseRows = await db.from('user_access').select('id,expires_at', {
      user_id    : `eq.${req.user.id}`,
      course_code: `eq.${courseCode.toUpperCase()}`,
      access_type: `eq.course`,
    }).catch(() => []);

    req.hasAccess = (courseRows || []).some(row => {
      if (row.expires_at && new Date(row.expires_at) < now) return false;
      return true;
    });
  } else {
    req.hasAccess = true;
  }

  next();
};

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  const { db } = await import('../db/supabase.js');

  const user = await db.from('users').single('id,email,name,phone,created_at', {
    id: `eq.${req.user.id}`,
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get all access
  const access = await db.from('user_access').select(
    'id,course_code,access_type,expires_at,created_at',
    { user_id: `eq.${req.user.id}` }
  ) || [];

  res.json({ user, access });
});

// ─── GET /api/auth/access/:courseCode ────────────────────────────────────────
// Check if logged-in user has access to a specific course

router.get('/access/:code', requireAuth, async (req, res) => {
  req.params.code = req.params.code.toUpperCase();

  // Reuse checkAccess logic inline
  const { db } = await import('../db/supabase.js');
  const now     = new Date();

  const rows = await db.from('user_access').select('id,access_type,expires_at,course_code', {
    user_id: `eq.${req.user.id}`,
  }) || [];

  const hasAccess = rows.some(row => {
    if (row.expires_at && new Date(row.expires_at) < now) return false;
    if (row.access_type === 'semester_pass') return true;
    if (row.access_type === 'course' && row.course_code === req.params.code) return true;
    return false;
  });

  res.json({ courseCode: req.params.code, hasAccess });
});

export default router;

