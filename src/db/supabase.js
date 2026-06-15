import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

// ─── Base headers ─────────────────────────────────────────────────────────────

const serviceHeaders = {
  'Content-Type' : 'application/json',
  'apikey'       : SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Prefer'       : 'return=minimal', // prevents empty JSON parse on insert/update
};

const anonHeaders = (token) => ({
  'Content-Type' : 'application/json',
  'apikey'       : ANON_KEY,
  'Authorization': `Bearer ${token || ANON_KEY}`,
});

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

const rest = async (method, path, { body, params, token, admin = true } = {}) => {
  let url = `${SUPABASE_URL}/rest/v1${path}`;

  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: admin ? serviceHeaders : anonHeaders(token),
    body   : body ? JSON.stringify(body) : undefined,
  });

  // Read body as text first — avoids crashing on empty responses
  const text = await res.text();

  // Empty body — success for insert/update/delete (Prefer: return=minimal)
  if (!text || text.trim() === '') {
    if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: (empty response)`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }

  if (!res.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${msg}`);
  }

  return data;
};

// ─── RPC (for pgvector similarity search) ────────────────────────────────────

const rpc = async (fn, args, { admin = true, token } = {}) => {
  const headers = admin
    ? { ...serviceHeaders, Prefer: undefined }  // strip Prefer for RPC
    : anonHeaders(token);

  // remove undefined keys
  Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method : 'POST',
    headers,
    body   : JSON.stringify(args),
  });

  const text = await res.text();
  if (!text || text.trim() === '') return null;

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Supabase RPC ${fn} → ${res.status}: invalid JSON`); }

  if (!res.ok) {
    throw new Error(`Supabase RPC ${fn} → ${res.status}: ${data?.message || JSON.stringify(data)}`);
  }

  return data;
};

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export const verifyToken = async (token) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: anonHeaders(token),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data?.id ? data : null;
  } catch {
    return null;
  }
};

// ─── Query builders ───────────────────────────────────────────────────────────

export const db = {

  from: (table) => ({

    select: (columns = '*', filters = {}, { limit, offset, order, admin = true, token } = {}) => {
      const params = { select: columns, ...filters };
      if (limit)  params.limit  = limit;
      if (offset) params.offset = offset;
      if (order)  params.order  = order;
      return rest('GET', `/${table}`, { params, admin, token });
    },

    single: (columns = '*', filters = {}, opts = {}) =>
      db.from(table)
        .select(columns, filters, { ...opts, limit: 1 })
        .then(rows => rows?.[0] || null),

    insert: (body, opts = {}) =>
      rest('POST', `/${table}`, {
        body,
        admin: opts.admin ?? true,
        token: opts.token,
      }),

    upsert: (body, opts = {}) =>
      rest('POST', `/${table}`, {
        body,
        params  : { on_conflict: opts.onConflict },
        admin   : opts.admin ?? true,
        token   : opts.token,
      }),

    update: (body, filters = {}, opts = {}) =>
      rest('PATCH', `/${table}`, {
        body,
        params: filters,
        admin : opts.admin ?? true,
        token : opts.token,
      }),

    delete: (filters = {}, opts = {}) =>
      rest('DELETE', `/${table}`, {
        params: filters,
        admin : opts.admin ?? true,
        token : opts.token,
      }),
  }),

  rpc : (fn, args, opts = {}) => rpc(fn, args, opts),
  ping: () => db.from('courses').select('id', {}, { limit: 1 }),
};

