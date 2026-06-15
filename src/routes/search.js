import { Router }        from 'express';
import { semanticSearch } from '../services/embedder.js';
import { verifyToken, db } from '../db/supabase.js';

const router = Router();

// ─── POST /api/search ─────────────────────────────────────────────────────────
// Body: { query, courseCode?, limit?, page? }
// Free tier  → 3 results, no options shown
// Paid tier  → up to 20 results, full question with options

router.post('/', async (req, res) => {
  try {
    const { query, courseCode, limit = 10 } = req.body;

    if (!query?.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    // ── Determine access tier ─────────────────────────────────────────────────
    let hasAccess  = false;
    let userId     = null;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const user  = await verifyToken(token);

      if (user) {
        userId = user.id;
        const now  = new Date();
        const code = courseCode?.toUpperCase();

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

    // ── Apply tier limits ─────────────────────────────────────────────────────
    const FREE_LIMIT = 3;
    const searchLimit = hasAccess
      ? Math.min(parseInt(limit), 20)
      : FREE_LIMIT;

    // ── Semantic search ───────────────────────────────────────────────────────
    const results = await semanticSearch(query.trim(), {
      courseCode: courseCode?.toUpperCase() || null,
      limit     : searchLimit,
    });

    // ── Fetch options for objective questions (paid only) ─────────────────────
    let enriched = results;

    if (hasAccess && results.length) {
      const ids = results.map(r => r.id);

      // Fetch options for all returned questions in one call
      const allOptions = await db.from('question_options').select(
        'question_id,label,option_text,option_latex',
        { question_id: `in.(${ids.join(',')})` }
      ) || [];

      // Group options by question_id
      const optionMap = allOptions.reduce((map, opt) => {
        if (!map[opt.question_id]) map[opt.question_id] = [];
        map[opt.question_id].push(opt);
        return map;
      }, {});

      enriched = results.map(r => ({
        ...r,
        options: optionMap[r.id] || [],
      }));
    }

    // ── Response ──────────────────────────────────────────────────────────────
    res.json({
      query,
      courseCode : courseCode?.toUpperCase() || null,
      hasAccess,
      count      : enriched.length,
      results    : enriched,
      locked     : !hasAccess,
      message    : !hasAccess
        ? `Showing ${FREE_LIMIT} free results. Unlock full search for ₦500 per course or ₦2,000 for semester pass.`
        : undefined,
    });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

