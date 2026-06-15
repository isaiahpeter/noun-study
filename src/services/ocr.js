import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'nvidia/nemotron-nano-12b-v2-vl:free';

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const OUTPUT_DIR   = process.env.OUTPUT_DIR   || './extracted';
const LOG_DIR      = process.env.LOG_DIR      || './logs';
const EXTRACTED_LOG = path.join(LOG_DIR, 'extracted.json');
const FAILED_LOG    = path.join(LOG_DIR, 'extract_failed.json');
const TEMP_DIR      = './temp_pages';            // Termux‑safe temp folder

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(3000 + Math.random() * 3000);

// ─── Dependency check ────────────────────────────────────────────────────────
export const checkDependencies = () => {
  for (const bin of ['pdfinfo', 'pdftoppm']) {
    try { execSync(`which ${bin}`, { stdio: 'pipe' }); }
    catch { throw new Error(`${bin} not found. Install: pkg install poppler`); }
  }
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
};

// ─── Page count ──────────────────────────────────────────────────────────────
const getPDFPageCount = (pdfPath) => {
  const out = execSync(`pdfinfo "${pdfPath}"`, { stdio: 'pipe' }).toString();
  const m = out.match(/Pages:\s+(\d+)/);
  if (!m) throw new Error('Could not read page count');
  return parseInt(m[1], 10);
};

// ─── PDF page → base64 JPEG (temp dir inside project) ────────────────────────
const pdfPageToBase64 = (pdfPath, pageNum) => {
  const prefix = path.join(TEMP_DIR, `page_${pageNum}`);
  execSync(
    `pdftoppm -f ${pageNum} -l ${pageNum} -r 200 -jpeg "${pdfPath}" "${prefix}"`,
    { stdio: 'pipe' }
  );
  const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(path.basename(prefix)));
  if (!files.length) throw new Error(`No image for page ${pageNum}`);
  const imgPath = path.join(TEMP_DIR, files[0]);
  const buffer = fs.readFileSync(imgPath);
  fs.unlinkSync(imgPath);
  return buffer.toString('base64');
};

// ─── OCR one page ─────────────────────────────────────────────────────────────
export const ocrPage = async (base64Image, pageNum, courseCode = '') => {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/isaiahpeter',
      'X-Title': 'NOUN Past Questions Extractor',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          {
            type: 'text',
            text: `You are extracting exam questions from a NOUN (National Open University of Nigeria) past question paper.

Extract every question visible on this page. For each question:
- question_number: the number as shown (e.g. 1, 2a, 3i)
- question_text: plain English text, no LaTeX — used for semantic search
- question_latex: same text but with ALL mathematical expressions in LaTeX. Use $...$ for inline math and $$...$$ for display/block math. If no math, same as question_text.
- question_type: "objective" if it has options A B C D, otherwise "theory"
- options: array of {label, text, latex} for objective questions, empty array for theory

Return ONLY a valid JSON array. No markdown, no explanation, no preamble.`
          }
        ]
      }],
      reasoning: { enabled: true }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OCR HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const clean = content.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    fs.writeFileSync(path.join(LOG_DIR, `debug_page${pageNum}.txt`), `RAW:\n${content}`);
    throw new Error(`JSON parse failed page ${pageNum} – saved debug`);
  }
};

// ─── Process one PDF ─────────────────────────────────────────────────────────
export const processPDF = async (filename, meta = {}) => {
  const pdfPath = path.resolve(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(pdfPath)) throw new Error(`File not found: ${pdfPath}`);

  const pageCount = getPDFPageCount(pdfPath);
  const allQuestions = [];
  console.log(`📄 ${filename}  (${pageCount} pages)`);

  for (let page = 1; page <= pageCount; page++) {
    process.stdout.write(`  page ${page}/${pageCount} ... `);
    try {
      const b64 = pdfPageToBase64(pdfPath, page);
      const questions = await ocrPage(b64, page, meta.courseCode || '');
      const tagged = questions.map(q => ({
        ...q,
        source_page: page,
        source_file: filename,
        course_code: meta.courseCode || '',
        year: meta.year || '',
        sem: meta.sem || '',
      }));
      allQuestions.push(...tagged);
      console.log(`✅ ${questions.length} q`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
    await randomDelay();
  }

  return allQuestions;
};

// ─── Case‑insensitive find file ──────────────────────────────────────────────
const findFile = (dir, name) => {
  const files = fs.readdirSync(dir);
  return files.find(f => f.toLowerCase() === name.toLowerCase());
};

// ─── Main (batch or single) ──────────────────────────────────────────────────
const run = async () => {
  checkDependencies();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const extracted = fs.existsSync(EXTRACTED_LOG)
    ? JSON.parse(fs.readFileSync(EXTRACTED_LOG, 'utf8'))
    : [];
  const extractedFiles = new Set(extracted.map(e => e.filename.toLowerCase()));
  const failed = [];

  // Load metadata from scraper log
  const downloadLog = fs.existsSync(path.join(LOG_DIR, 'downloaded.json'))
    ? JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'downloaded.json'), 'utf8'))
    : [];

  // Determine which files to process
  const targetArg = process.argv[2]; // optional filename or course code
  let filesToProcess = [];

  if (targetArg) {
    // User gave a specific file or course code
    const exactFile = findFile(DOWNLOAD_DIR, targetArg);
    if (exactFile) {
      filesToProcess = [exactFile];
    } else {
      // Try as course code: pick all PDFs from download log that match
      const courseCode = targetArg.toUpperCase();
      const metaFiles = downloadLog
        .filter(d => d.courseCode === courseCode)
        .map(d => d.filename);
      // Also fallback to any PDF containing the code in name
      const allPDFs = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.pdf'));
      const extra = allPDFs.filter(f =>
        f.toUpperCase().includes(courseCode) && !metaFiles.includes(f)
      );
      filesToProcess = [...new Set([...metaFiles, ...extra])];
    }
  } else {
    // No argument: process all PDFs in downloads folder
    filesToProcess = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.pdf'));
  }

  if (!filesToProcess.length) {
    console.log('No PDFs to process.');
    return;
  }

  for (const filename of filesToProcess) {
    if (extractedFiles.has(filename.toLowerCase())) {
      console.log(`⏭  Already extracted: ${filename}`);
      continue;
    }

    const meta = downloadLog.find(d => d.filename === filename) || {};

    try {
      const questions = await processPDF(filename, meta);

      // Save per‑file JSON
      const outFile = path.join(OUTPUT_DIR, filename.replace('.pdf', '.json'));
      fs.writeFileSync(outFile, JSON.stringify(questions, null, 2));
      console.log(`   💾 Saved ${questions.length} questions → ${outFile}`);

      extracted.push({
        filename,
        courseCode: meta.courseCode || '',
        year: meta.year || '',
        sem: meta.sem || '',
        questionCount: questions.length,
        extractedAt: new Date().toISOString(),
      });
      extractedFiles.add(filename.toLowerCase());
      fs.writeFileSync(EXTRACTED_LOG, JSON.stringify(extracted, null, 2));
    } catch (err) {
      console.error(`\n❌ Failed: ${filename} — ${err.message}`);
      failed.push({ filename, error: err.message });
    }
  }

  fs.writeFileSync(FAILED_LOG, JSON.stringify(failed, null, 2));

  // Cleanup temp folder
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Extracted from : ${extracted.length} files`);
  console.log(`❌ Failed         : ${failed.length}`);
  console.log(`📁 Output in      : ${OUTPUT_DIR}/`);
};

run().catch(err => {
  console.error('\n💥', err.message);
  process.exit(1);
});
