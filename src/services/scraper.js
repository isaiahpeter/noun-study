import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL     = 'https://psalmedu.com';
const SEARCH_URL   = `${BASE_URL}/noun-past-questions`;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const LOG_DIR      = process.env.LOG_DIR      || './logs';

const sleep       = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = ()   => sleep(2000 + Math.random() * 2000);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
  'Accept'    : 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Referer'   : BASE_URL,
};

// ─── Ensure dirs ────────────────────────────────────────────────────────
const ensureDirs = () => {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR,      { recursive: true });
};

// ─── Parse meta from title ───────────────────────────────────────────────
// Handles both compact "CIT30120251" and spaced "CIT301 2023_1" formats
export const parseMeta = (title, fallbackCode = '') => {
  const t = title.replace(/\s/g, '');

  const compact = t.match(/^([A-Z]{3}\d{3})(\d{4})(\d)$/i);
  if (compact) {
    return { code: compact[1].toUpperCase(), year: compact[2], sem: compact[3] };
  }

  const spaced = title.match(/([A-Z]{3}\d{3})[\s_-](\d{4})[\s_-](\d)/i);
  if (spaced) {
    return { code: spaced[1].toUpperCase(), year: spaced[2], sem: spaced[3] };
  }

  const yearMatch = title.match(/20\d{2}/);
  return { code: fallbackCode.toUpperCase(), year: yearMatch?.[0] || 'UNKNOWN', sem: '' };
};

// ─── Build clean filename ─────────────────────────────────────────────────
const buildFilename = (meta, courseCode) => {
  const code   = meta.code || courseCode;
  const suffix = meta.sem ? `${meta.year}_${meta.sem}` : meta.year;
  return `${code}_${suffix}.pdf`;
};

// ─── Parse HTML with cheerio ──────────────────────────────────────────────
const extractLinks = (html) => {
  const $ = cheerio.load(html);
  const links = [];

  $('.pq-item').each((_, el) => {
    const title    = $(el).find('h4').text().trim();
    const a        = $(el).find('a.pq-dl');
    const href     = a.attr('href');
    const download = a.attr('download') || '';

    if (!href || !href.includes('/past_questions/')) return;

    const fullUrl  = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const filename = download || path.basename(href);
    links.push({ url: fullUrl, filename, title });
  });

  return links;
};

const hasNextPage = (html) => {
  const $ = cheerio.load(html);
  return $('a.page-link[rel="next"]').length > 0;
};

// ─── Search psalmedu for a course code (pagination) ───────────────────────
const searchCourse = async (courseCode) => {
  const allLinks = [];
  let page = 1;

  while (true) {
    const url = `${SEARCH_URL}?search=${encodeURIComponent(courseCode)}&page=${page}`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Search HTTP ${res.status} for ${courseCode}`);

    const html  = await res.text();
    const links = extractLinks(html);

    allLinks.push(...links);

    if (!hasNextPage(html) || links.length === 0) break;

    page++;
    await randomDelay();
  }

  // Deduplicate by URL
  const seen = new Set();
  return allLinks.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
};

// ─── Download a single PDF ────────────────────────────────────────────────
const downloadFile = async (url, filepath) => {
  const res = await fetch(url, {
    headers: { ...HEADERS, 'Accept': 'application/pdf,application/octet-stream,*/*' },
  });

  if (!res.ok) throw new Error(`Download HTTP ${res.status}`);

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    throw new Error('Got HTML instead of PDF — file may require login');
  }

  const buffer = await res.arrayBuffer();
  fs.writeFileSync(filepath, Buffer.from(buffer));
  return Math.round(buffer.byteLength / 1024);
};

// ─── Main export: scrape one course code ──────────────────────────────────
export const scrapeCourse = async (courseCode) => {
  ensureDirs();

  courseCode = courseCode.toUpperCase().trim();

  const logPath    = path.join(LOG_DIR, 'downloaded.json');
  const downloaded = fs.existsSync(logPath)
    ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
    : [];
  const downloadedUrls = new Set(downloaded.map(d => d.url));

  console.log(`🔍 Searching psalmedu for ${courseCode}...`);

  let links;
  try {
    links = await searchCourse(courseCode);
  } catch (err) {
    throw new Error(`Search failed for ${courseCode}: ${err.message}`);
  }

  if (!links.length) {
    console.log(`  No results found for ${courseCode}`);
    return [];
  }

  const newLinks = links.filter(l => !downloadedUrls.has(l.url));
  console.log(`  Found ${links.length} files, ${newLinks.length} new`);

  const results = [];

  for (const { url, filename: originalFilename, title } of newLinks) {
    const meta     = parseMeta(title, courseCode);
    const filename = buildFilename(meta, courseCode);
    const filepath = path.join(DOWNLOAD_DIR, filename);

    process.stdout.write(`  ⬇  ${filename} ... `);

    try {
      const sizeKB = await downloadFile(url, filepath);

      const entry = {
        url,
        courseCode,
        title,
        year    : meta.year,
        sem     : meta.sem,
        filename,
        sizeKB,
        downloadedAt: new Date().toISOString(),
      };

      downloaded.push(entry);
      downloadedUrls.add(url);
      results.push(entry);

      fs.writeFileSync(logPath, JSON.stringify(downloaded, null, 2));

      console.log(`✅ ${sizeKB}KB`);
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }

    await randomDelay();
  }

  return results;
};

// ─── CLI usage: node scraper.js CIT301 ───────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('scraper.js')) {
  const code = process.argv[2];
  if (!code) {
    console.error('Usage: node src/services/scraper.js <COURSE_CODE>');
    process.exit(1);
  }

  scrapeCourse(code)
    .then(results => {
      console.log(`\n✅ Done. ${results.length} new files downloaded.`);
    })
    .catch(err => {
      console.error(`\n💥 ${err.message}`);
      process.exit(1);
    });
}
