import { Router }         from 'express';
import { embedText, semanticSearch } from '../services/embedder.js';
import { verifyToken, db } from '../db/supabase.js';

const router = Router();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ─── System prompt builder ────────────────────────────────────────────────────
const buildSystemPrompt = (courseCode, context) => {
  const contextBlock = context.length
    ? context.map((q, i) =>
        `[Q${i + 1} | ${q.year} Sem ${q.sem} | ${q.question_type}]\n${q.question_text}`
      ).join('\n\n')
    : 'No specific past questions found for this query.';

  return `You are an expert NOUN (National Open University of Nigeria) study assistant for ${courseCode}.

Your job is to help students understand concepts and prepare for exams using NOUN's actual past question patterns.

PAST EXAM QUESTIONS CONTEXT:
${contextBlock}

INSTRUCTIONS:
- Always explain concepts clearly in simple English first
- Reference the past questions above when relevant — say "As seen in ${courseCode} ${context[0]?.year || 'past exams'}..."
- If a concept appears across multiple years, highlight it — it's a recurring exam topic
- For theory questions: explain the concept, give examples, suggest how to structure an answer
- For objective questions: explain why each option is right or wrong
- Keep responses focused and exam-oriented
- End every response with a "📝 Exam Tip:" relevant to the topic
- Use LaTeX for ALL math expressions without exception: $...$ for inline, $$...$$ for display. Never use \\[ \\] or \\( \\) delimiters`;
};

// ─── POST /api/study/ask ─────────────────────────────────────────────────────
router.post('/ask', async (req, res) => {
  try {
    const { question, courseCode, history = [] } = req.body;

    if (!question?.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Retrieve relevant past questions via semantic search – no access restrictions
    const context = await semanticSearch(question, {
      courseCode: courseCode?.toUpperCase() || null,
      limit     : 8,          // give maximum context
    });

    const systemPrompt = buildSystemPrompt(courseCode, context);

    // Sanitize history – only keep role + content
    const safeHistory = history
      .filter(m => ['user', 'assistant'].includes(m.role) && m.content)
      .slice(-10); // keep last 10 turns

    const messages = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: question.trim() },
    ];

    // Call OpenRouter
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type' : 'application/json',
        'HTTP-Referer' : 'https://github.com/isaiahpeter',
        'X-Title'      : 'NOUN Study Assistant',
      },
      body: JSON.stringify({
        model: 'google/gemma-4-31b-it:free',
        messages,
        temperature: 0.7,
        max_tokens : 1500,
      }),
    });

    if (!orRes.ok) {
      const err = await orRes.text();
      throw new Error(`OpenRouter ${orRes.status}: ${err.slice(0, 200)}`);
    }

    const data    = await orRes.json();
    const answer  = data.choices?.[0]?.message?.content || '';

    res.json({
      answer,
      context: context.map(q => ({
        questionText: q.question_text,
        questionType: q.question_type,
        year        : q.year,
        sem         : q.sem,
        similarity  : q.similarity,
      })),
      courseCode: courseCode?.toUpperCase() || null,
    });

  } catch (err) {
    console.error('Study ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/study/topics/:code ────────────────────────────────────────────
router.get('/topics/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    const questions = await db.from('questions').select(
      'question_text,year,sem,question_type',
      { course_code: `eq.${code}` }
    ) || [];

    if (!questions.length) {
      return res.json({ topics: [], courseCode: code });
    }

    const sample = questions.slice(0, 50).map(q => q.question_text).join('\n');

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        model   : 'nvidia/llama-3.3-nemotron-super-49b-v1:free',
        messages: [
          {
            role   : 'system',
            content: 'You are a curriculum analyst. Extract the top 8 recurring topics from these exam questions. Return ONLY a JSON array of strings. No explanation.',
          },
          {
            role   : 'user',
            content: `Course: ${code}\n\nQuestions:\n${sample}`,
          },
        ],
        max_tokens: 300,
      }),
    });

    const data    = await orRes.json();
    const content = data.choices?.[0]?.message?.content || '[]';
    const clean   = content.replace(/```json|```/g, '').trim();

    let topics = [];
    try { topics = JSON.parse(clean); } catch { topics = []; }

    res.json({ topics, courseCode: code, totalQuestions: questions.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
