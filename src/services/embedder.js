import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { db } from '../db/supabase.js';

dotenv.config();

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const LOG_DIR           = process.env.LOG_DIR    || './logs';
const OUTPUT_DIR        = process.env.OUTPUT_DIR || './extracted';

// Routes through Supabase Edge Function to bypass local network restrictions
// Edge Function proxies to HuggingFace all-MiniLM-L6-v2 (384 dimensions)
const EMBED_URL  = `${SUPABASE_URL}/functions/v1/embed-`;
const DIMENSIONS = 384;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
}

const sleep       = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = ()   => sleep(1000 + Math.random() * 1000);

// ─── Embed a batch of texts ───────────────────────────────────────────────────
// Sends to Supabase Edge Function → HuggingFace all-MiniLM-L6-v2
// Returns float[][] — one embedding per input text

const embedBatch = async (texts, attempt = 1) => {
  const truncated = texts.map(t => t.slice(0, 512));

  const res = await fetch(EMBED_URL, {
    method : 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type' : 'application/json',
    },
    body: JSON.stringify({ inputs: truncated }),
  });

  // HuggingFace model still cold-starting
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    const wait = Math.ceil((body.estimated_time || 20) * 1000);
    console.log(`\n    ⏳ Model loading, waiting ${Math.ceil(wait / 1000)}s...`);
    await sleep(wait);
    if (attempt < 4) return embedBatch(texts, attempt + 1);
    throw new Error('HuggingFace model still loading after 3 retries');
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();

  // HF returns float[] for single input, float[][] for batch
  const embeddings = Array.isArray(data[0]) ? data : [data];

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: sent ${texts.length}, got ${embeddings.length}`
    );
  }

  return embeddings; // float[][]
};

// ─── Embed a single text → float[] ───────────────────────────────────────────

export const embedText = async (text) => {
  const results = await embedBatch([text]);
  return results[0];
};

// ─── Store question rows in Supabase in chunks ────────────────────────────────

const storeQuestions = async (rows) => {
  const CHUNK = 50;
  let stored  = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.from('questions').insert(rows.slice(i, i + CHUNK));
    stored += rows.slice(i, i + CHUNK).length;
  }

  return stored;
};

// ─── Store question options in Supabase ───────────────────────────────────────

const storeOptions = async (rows) => {
  if (!rows.length) return;
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.from('question_options').insert(rows.slice(i, i + CHUNK));
  }
};

// ─── Embed and store all extracted questions for a course ─────────────────────

export const embedCourse = async (courseCode) => {
  courseCode = courseCode.toUpperCase();
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Find extracted JSON files for this course
  if (!fs.existsSync(OUTPUT_DIR)) {
    throw new Error(`Output dir not found: ${OUTPUT_DIR} — run ocr.js first`);
  }

  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith(courseCode) && f.endsWith('.json'));

  if (!files.length) {
    throw new Error(`No extracted JSON for ${courseCode} in ${OUTPUT_DIR} — run ocr.js first`);
  }

  // Skip already-embedded files
  const embedLogPath  = path.join(LOG_DIR, 'embedded.json');
  const embedLog      = fs.existsSync(embedLogPath)
    ? JSON.parse(fs.readFileSync(embedLogPath, 'utf8'))
    : [];
  const embeddedFiles = new Set(embedLog.map(e => e.filename));
  const pending       = files.filter(f => !embeddedFiles.has(f));

  console.log(`🧠 ${courseCode}: ${files.length} file(s), ${pending.length} pending embedding`);

  if (!pending.length) {
    console.log('  ✅ All files already embedded');
    return 0;
  }

  let totalStored = 0;

  for (const filename of pending) {
    const filepath  = path.join(OUTPUT_DIR, filename);
    const questions = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    if (!questions.length) {
      console.log(`  ⏭  ${filename} — no questions, skipping`);
      embedLog.push({ filename, courseCode, questionCount: 0, embeddedAt: new Date().toISOString() });
      fs.writeFileSync(embedLogPath, JSON.stringify(embedLog, null, 2));
      continue;
    }

    console.log(`\n  📄 ${filename} — ${questions.length} question(s)`);

    const BATCH   = 32; // safe batch size for HF free tier
    const toStore = [];
    const optRows = [];
    let   failed  = 0;

    for (let i = 0; i < questions.length; i += BATCH) {
      const batch      = questions.slice(i, i + BATCH);
      const texts      = batch.map(q => q.question_text || '');
      const batchNum   = Math.floor(i / BATCH) + 1;
      const totalBatch = Math.ceil(questions.length / BATCH);

      process.stdout.write(
        `    Batch ${batchNum}/${totalBatch} (${batch.length} texts) ... `
      );

      let embeddings;
      try {
        embeddings = await embedBatch(texts);
        console.log('✅');
      } catch (err) {
        console.log(`❌ ${err.message}`);
        failed += batch.length;
        await randomDelay();
        continue;
      }

      for (let j = 0; j < batch.length; j++) {
        const q         = batch[j];
        const embedding = embeddings[j];

        if (!embedding || embedding.length !== DIMENSIONS) {
          console.warn(`    ⚠  Bad embedding for question ${i + j + 1}, skipping`);
          continue;
        }

        const row = {
          course_code    : (q.course_code || courseCode).toUpperCase(),
          question_number: String(q.question_number || i + j + 1),
          question_text  : q.question_text  || '',
          question_latex : q.question_latex || q.question_text || '',
          question_type  : q.question_type  || 'theory',
          year           : q.year || '',
          sem            : q.sem  || '',
          embedding      : `[${embedding.join(',')}]`, // pgvector literal format
        };

        toStore.push(row);

        // Collect options for objective questions
        if (q.question_type === 'objective' && Array.isArray(q.options)) {
          q.options.forEach(opt => {
            optRows.push({
              _store_idx  : toStore.length - 1, // position in toStore — used after insert
              label       : opt.label       || '',
              option_text : opt.text        || '',
              option_latex: opt.latex       || opt.text || '',
            });
          });
        }
      }

      await randomDelay(); // be kind to free tier rate limits
    }

    // Store questions
    if (toStore.length) {
      try {
        process.stdout.write(`  💾 Storing ${toStore.length} questions ... `);
        const stored = await storeQuestions(toStore);
        totalStored += stored;
        console.log('✅');
      } catch (err) {
        console.log(`❌ Store failed: ${err.message}`);
      }
    }

    if (failed) {
      console.log(`  ⚠  ${failed} question(s) failed embedding in ${filename}`);
    }

    // Log file as embedded
    embedLog.push({
      filename,
      courseCode,
      questionCount: toStore.length,
      failedCount  : failed,
      embeddedAt   : new Date().toISOString(),
    });
    fs.writeFileSync(embedLogPath, JSON.stringify(embedLog, null, 2));
  }

  return totalStored;
};

// ─── Semantic search ──────────────────────────────────────────────────────────
// Embeds the query text then calls the Supabase match_questions RPC

export const semanticSearch = async (queryText, {
  courseCode = null,
  limit      = 10,
} = {}) => {
  if (!queryText?.trim()) throw new Error('Query text is required');

  const embedding = await embedText(queryText.trim());

  const results = await db.rpc('match_questions', {
    query_embedding: `[${embedding.join(',')}]`,
    match_count    : limit,
    course_filter  : courseCode ? courseCode.toUpperCase() : null,
  });

  return results || [];
};

// ─── CLI: node embedder.js <COURSE_CODE> ─────────────────────────────────────

if (process.argv[1]?.endsWith('embedder.js')) {
  const code = process.argv[2];
  if (!code) {
    console.error('Usage: node embedder.js <COURSE_CODE>');
    console.error('Example: node embedder.js CIT301');
    process.exit(1);
  }

  embedCourse(code)
    .then(count => {
      console.log(`\n✅ Done. ${count} questions stored with embeddings.`);
    })
    .catch(err => {
      console.error(`\n💥 ${err.message}`);
      process.exit(1);
    });
}

