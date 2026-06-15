import { Router } from 'express';
import { db }     from '../db/supabase.js';

const router = Router();

// ─── GET /api/courses ─────────────────────────────────────────────────────────
// List all available courses with question counts

router.get('/', async (_req, res) => {
  try {
    const courses = await db.from('courses').select(
      'code,title,department,faculty,is_available',
      { is_available: 'eq.true' },
      { order: 'code.asc' }
    );

    res.json({ courses: courses || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/courses/:code ───────────────────────────────────────────────────
// Get one course + its available years/semesters + question count

router.get('/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const course = await db.from('courses').single(
      'code,title,department,faculty,is_available',
      { code: `eq.${code}` }
    );

    if (!course) return res.status(404).json({ error: 'Course not found' });

    // Get distinct years and semesters available
    const questions = await db.from('questions').select(
      'year,sem',
      { course_code: `eq.${code}` },
      { order: 'year.desc' }
    );

    // Deduplicate year+sem combos
    const seen    = new Set();
    const periods = (questions || []).reduce((acc, q) => {
      const key = `${q.year}-${q.sem}`;
      if (!seen.has(key)) {
        seen.add(key);
        acc.push({ year: q.year, sem: q.sem });
      }
      return acc;
    }, []);

    // Get pricing
    const pricing = await db.from('pricing').select(
      'access_type,amount_kobo,label,description',
      { is_active: 'eq.true' }
    );

    res.json({
      course,
      periods,
      questionCount: questions?.length || 0,
      pricing      : pricing || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/courses/:code/questions ────────────────────────────────────────
// Get questions for a course — free users get 5, paid users get all
// Optionally filter by year and sem

router.get('/:code/questions', async (req, res) => {
  try {
    const code  = req.params.code.toUpperCase();
    const { year, sem, page = 1, limit = 20 } = req.query;

    const filters = { course_code: `eq.${code}` };
    if (year) filters.year = `eq.${year}`;
    if (sem)  filters.sem  = `eq.${sem}`;

    // Determine access — check Authorization header if present
    let hasAccess = false;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const { verifyToken } = await import('../db/supabase.js');
      const token = authHeader.split(' ')[1];
      const user  = await verifyToken(token);

      if (user) {
        const now  = new Date();
        const rows = await db.from('user_access').select(
          'access_type,expires_at,course_code',
          { user_id: `eq.${user.id}` }
        ) || [];

        hasAccess = rows.some(row => {
          if (row.expires_at && new Date(row.expires_at) < now) return false;
          if (row.access_type === 'semester_pass') return true;
          if (row.access_type === 'course' && row.course_code === code) return true;
          return false;
        });
      }
    }

    const pageSize = hasAccess ? parseInt(limit) : 5;
    const offset   = hasAccess ? (parseInt(page) - 1) * pageSize : 0;

    const questions = await db.from('questions').select(
      hasAccess
        ? 'id,question_number,question_text,question_latex,question_type,year,sem'
        : 'id,question_number,question_text,question_latex,question_type,year,sem',
      filters,
      { limit: pageSize, offset, order: 'year.desc,question_number.asc' }
    );

    // For free users, mask options — only show question text
    res.json({
      courseCode: code,
      hasAccess,
      page      : parseInt(page),
      limit     : pageSize,
      questions : questions || [],
      locked    : !hasAccess,
      message   : !hasAccess
        ? 'Showing 5 free questions. Unlock full access for ₦500.'
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

