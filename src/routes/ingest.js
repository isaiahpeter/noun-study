import { Router }    from 'express';
import { db }        from '../db/supabase.js';
import { scrapeCourse } from '../services/scraper.js';
import { processPDF } from '../services/ocr.js';
import { embedCourse }   from '../services/embedder.js';

const router = Router();

// ─── Admin key middleware ─────────────────────────────────────────────────────
// Ingest routes are admin-only — protected by ADMIN_KEY in .env

const requireAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ─── In-memory job tracker ────────────────────────────────────────────────────
// For a production app, use a proper queue (BullMQ, etc.)
// For now, simple in-memory map is fine for single-server Termux use

const jobs = new Map();

const updateJob = async (jobId, patch) => {
  // Update in-memory
  const job = jobs.get(jobId) || {};
  Object.assign(job, patch);
  jobs.set(jobId, job);

  // Update in DB
  await db.from('ingest_jobs').update(patch, { id: `eq.${jobId}` }).catch(console.error);
};

// ─── Run full pipeline for a course (async, non-blocking) ────────────────────

const runPipeline = async (jobId, courseCode) => {
  try {
    // ── Step 1: Scrape PDFs ───────────────────────────────────────────────────
    await updateJob(jobId, { status: 'downloading', started_at: new Date().toISOString() });
    console.log(`[${jobId}] Scraping ${courseCode}...`);

    const files = await scrapeCourse(courseCode);
    await updateJob(jobId, { total_files: files.length });

    // Ensure course exists in DB
    await db.from('courses').insert({
      code        : courseCode,
      is_available: false,
    }).catch(() => {}); // ignore duplicate

    // Insert source_files
    for (const file of files) {
      await db.from('source_files').insert({
        course_code: courseCode,
        filename   : file.filename,
        year       : file.year,
        sem        : file.sem,
        size_kb    : file.sizeKB,
        source_url : file.url,
      }).catch(() => {}); // ignore duplicate
    }

    // ── Step 2: OCR ───────────────────────────────────────────────────────────
    await updateJob(jobId, { status: 'ocr' });
    console.log(`[${jobId}] Running OCR for ${courseCode}...`);

    const questions = await processPDF(courseCode);
    await updateJob(jobId, { processed_files: files.length });

    // ── Step 3: Embed + store ─────────────────────────────────────────────────
    await updateJob(jobId, { status: 'embedding' });
    console.log(`[${jobId}] Embedding ${courseCode}...`);

    const stored = await embedCourse(courseCode);
    await updateJob(jobId, { total_questions: stored });

    // ── Mark course available ─────────────────────────────────────────────────
    await db.from('courses').update(
      { is_available: true },
      { code: `eq.${courseCode}` }
    );

    await updateJob(jobId, {
      status      : 'done',
      completed_at: new Date().toISOString(),
    });

    console.log(`[${jobId}] ✅ ${courseCode} done — ${stored} questions stored`);

  } catch (err) {
    console.error(`[${jobId}] ❌ Pipeline failed:`, err.message);
    await updateJob(jobId, {
      status      : 'failed',
      error       : err.message,
      completed_at: new Date().toISOString(),
    });
  }
};

// ─── POST /api/ingest/:code ───────────────────────────────────────────────────
// Triggers full pipeline: scrape → OCR → embed
// Returns job ID immediately, runs async in background

router.post('/:code', requireAdmin, async (req, res) => {
  try {
    const courseCode = req.params.code.toUpperCase();

    // Check if already running
    for (const [, job] of jobs) {
      if (job.courseCode === courseCode && job.status === 'downloading' ||
          job.courseCode === courseCode && job.status === 'ocr' ||
          job.courseCode === courseCode && job.status === 'embedding') {
        return res.status(409).json({
          error: `Ingest already running for ${courseCode}`,
          jobId: job.id,
        });
      }
    }

    // Create job in DB
    const jobRows = await db.from('ingest_jobs').insert({
      course_code: courseCode,
      status     : 'pending',
    });

    // Fetch the created job to get its ID
    const job = await db.from('ingest_jobs').single('id,course_code,status', {
      course_code: `eq.${courseCode}`,
      status     : `eq.pending`,
    });

    const jobId = job?.id;
    if (!jobId) throw new Error('Failed to create ingest job');

    // Track in memory
    jobs.set(jobId, { id: jobId, courseCode, status: 'pending' });

    // Run pipeline async — don't await
    runPipeline(jobId, courseCode).catch(console.error);

    res.status(202).json({
      message   : `Ingest started for ${courseCode}`,
      jobId,
      courseCode,
      statusUrl : `/api/ingest/status/${jobId}`,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ingest/status/:jobId ───────────────────────────────────────────

router.get('/status/:jobId', requireAdmin, async (req, res) => {
  try {
    // Check in-memory first (most up-to-date)
    const memJob = jobs.get(req.params.jobId);
    if (memJob) return res.json(memJob);

    // Fall back to DB
    const job = await db.from('ingest_jobs').single('*', {
      id: `eq.${req.params.jobId}`,
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ingest/jobs ─────────────────────────────────────────────────────
// List recent ingest jobs

router.get('/jobs', requireAdmin, async (_req, res) => {
  try {
    const jobs = await db.from('ingest_jobs').select(
      'id,course_code,status,total_files,processed_files,total_questions,error,started_at,completed_at',
      {},
      { order: 'created_at.desc', limit: 20 }
    );
    res.json({ jobs: jobs || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;


// ─── POST /api/ingest/upload ──────────────────────────────────────────────────
// Accepts a PDF file upload, saves it, then runs the pipeline
// Uses multipart/form-data — install: npm install multer

import multer from 'multer';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = process.env.DOWNLOAD_DIR || './downloads';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const code = (req.body.courseCode || 'UNKNOWN').toUpperCase();
    const year = req.body.year || 'UNKNOWN';
    const sem  = req.body.sem  || '1';
    const name = `${code}_${year}_${sem}_${Date.now()}.pdf`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits   : { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  },
});

router.post('/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const courseCode = (req.body.courseCode || '').toUpperCase();
    const year       = req.body.year  || 'UNKNOWN';
    const sem        = req.body.sem   || '1';
    const title      = req.body.title || '';

    if (!courseCode) return res.status(400).json({ error: 'courseCode is required' });

    // Ensure course exists
    await db.from('courses').insert({
      code        : courseCode,
      title       : title || courseCode,
      is_available: false,
    }).catch(() => {});

    // Save to source_files
    await db.from('source_files').insert({
      course_code: courseCode,
      filename   : req.file.filename,
      year, sem,
      size_kb    : Math.round(req.file.size / 1024),
      source_url : 'upload',
    }).catch(() => {});

    // Create ingest job
    await db.from('ingest_jobs').insert({
      course_code: courseCode,
      status     : 'pending',
    });

    const job = await db.from('ingest_jobs').single('id', {
      course_code: `eq.${courseCode}`,
      status     : `eq.pending`,
    });

    const jobId = job?.id;
    if (!jobId) throw new Error('Failed to create job');

    jobs.set(jobId, { id: jobId, courseCode, status: 'pending' });

    // Run OCR + embed only (file already downloaded)
    runUploadPipeline(jobId, courseCode, req.file.filename, { year, sem }).catch(console.error);

    res.status(202).json({
      message  : `Processing ${req.file.filename}`,
      jobId,
      courseCode,
      filename : req.file.filename,
      statusUrl: `/api/ingest/status/${jobId}`,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Upload pipeline (OCR + embed only, skip scrape) ─────────────────────────

const runUploadPipeline = async (jobId, courseCode, filename, meta = {}) => {
  try {
    await updateJob(jobId, { status: 'ocr', started_at: new Date().toISOString(), total_files: 1 });
    console.log(`[${jobId}] OCR: ${filename}`);

    const questions = await processPDF(filename, {
      courseCode,
      year: meta.year,
      sem : meta.sem,
    });

    await updateJob(jobId, { status: 'embedding', processed_files: 1 });
    console.log(`[${jobId}] Embedding ${courseCode}…`);

    const stored = await embedCourse(courseCode);

    await db.from('courses').update(
      { is_available: true },
      { code: `eq.${courseCode}` }
    );

    await updateJob(jobId, {
      status        : 'done',
      total_questions: stored,
      completed_at  : new Date().toISOString(),
    });

    console.log(`[${jobId}] ✅ Done — ${stored} questions`);

  } catch (err) {
    console.error(`[${jobId}] ❌`, err.message);
    await updateJob(jobId, {
      status      : 'failed',
      error       : err.message,
      completed_at: new Date().toISOString(),
    });
  }
};

