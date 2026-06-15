import { Router }      from 'express';
import { db }          from '../db/supabase.js';
import { requireAuth } from './auth.js';
import crypto          from 'crypto';

const router = Router();

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE   = 'https://api.paystack.co';

// ─── Paystack helper ──────────────────────────────────────────────────────────

const paystack = async (method, path, body) => {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type' : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Paystack error');
  return data.data;
};

// ─── GET /api/payments/pricing ────────────────────────────────────────────────

router.get('/pricing', async (_req, res) => {
  try {
    const pricing = await db.from('pricing').select(
      'access_type,amount_kobo,label,description',
      { is_active: 'eq.true' }
    );
    res.json({ pricing: pricing || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/initialize ───────────────────────────────────────────
// Body: { accessType: 'course' | 'semester_pass', courseCode? }
// Returns: { authorizationUrl, reference }

router.post('/initialize', requireAuth, async (req, res) => {
  try {
    const { accessType, courseCode } = req.body;

    if (!accessType) {
      return res.status(400).json({ error: 'accessType is required' });
    }

    if (accessType === 'course' && !courseCode) {
      return res.status(400).json({ error: 'courseCode is required for course access' });
    }

    // Get pricing
    const pricing = await db.from('pricing').single(
      'amount_kobo,label',
      { access_type: `eq.${accessType}`, is_active: 'eq.true' }
    );

    if (!pricing) {
      return res.status(404).json({ error: 'Pricing not found' });
    }

    // Check if user already has access
    if (accessType === 'course' && courseCode) {
      const existing = await db.from('user_access').single(
        'id,expires_at',
        {
          user_id    : `eq.${req.user.id}`,
          course_code: `eq.${courseCode.toUpperCase()}`,
          access_type: `eq.course`,
        }
      );

      if (existing) {
        const expired = existing.expires_at && new Date(existing.expires_at) < new Date();
        if (!expired) {
          return res.status(409).json({ error: 'You already have access to this course' });
        }
      }
    }

    // Get user email
    const user = await db.from('users').single('email', { id: `eq.${req.user.id}` });

    // Generate unique reference
    const reference = `NOUN_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // Initialize Paystack transaction
    const transaction = await paystack('POST', '/transaction/initialize', {
      email    : user.email,
      amount   : pricing.amount_kobo,
      reference,
      metadata : {
        user_id    : req.user.id,
        access_type: accessType,
        course_code: courseCode?.toUpperCase() || null,
      },
      callback_url: `${process.env.FRONTEND_URL}/payment/verify?ref=${reference}`,
    });

    // Store pending transaction
    await db.from('transactions').insert({
      user_id    : req.user.id,
      course_code: courseCode?.toUpperCase() || null,
      access_type: accessType,
      amount_kobo: pricing.amount_kobo,
      reference,
      status     : 'pending',
    });

    res.json({
      reference,
      authorizationUrl: transaction.authorization_url,
      amount          : pricing.amount_kobo,
      label           : pricing.label,
    });

  } catch (err) {
    console.error('Payment init error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/payments/verify/:reference ─────────────────────────────────────
// Called by frontend after Paystack redirect

router.get('/verify/:reference', requireAuth, async (req, res) => {
  try {
    const { reference } = req.params;

    // Get transaction from DB
    const transaction = await db.from('transactions').single(
      'id,user_id,course_code,access_type,amount_kobo,status',
      { reference: `eq.${reference}` }
    );

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (transaction.status === 'success') {
      return res.json({ status: 'success', alreadyProcessed: true });
    }

    // Verify with Paystack
    const data = await paystack('GET', `/transaction/verify/${reference}`);

    if (data.status !== 'success') {
      await db.from('transactions').update(
        { status: 'failed' },
        { reference: `eq.${reference}` }
      );
      return res.status(400).json({ error: 'Payment not successful', status: data.status });
    }

    // Grant access
    await grantAccess(transaction);

    res.json({ status: 'success', courseCode: transaction.course_code });

  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────────
// Paystack calls this on payment events
// Body is raw — signature verified with HMAC

router.post('/webhook', async (req, res) => {
  try {
    // Verify Paystack signature
    const signature = req.headers['x-paystack-signature'];
    const hash      = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== signature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body);

    // Only handle successful charges
    if (event.event !== 'charge.success') {
      return res.sendStatus(200);
    }

    const { reference, metadata } = event.data;

    // Get transaction
    const transaction = await db.from('transactions').single(
      'id,user_id,course_code,access_type,status',
      { reference: `eq.${reference}` }
    );

    if (!transaction || transaction.status === 'success') {
      return res.sendStatus(200); // already processed
    }

    // Save raw Paystack payload
    await db.from('transactions').update(
      { paystack_data: event.data },
      { reference: `eq.${reference}` }
    );

    // Grant access
    await grantAccess(transaction);

    res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200); // always 200 to Paystack
  }
});

// ─── Grant access helper ──────────────────────────────────────────────────────

const grantAccess = async (transaction) => {
  const { user_id, course_code, access_type, id: transactionId } = transaction;

  // semester_pass expires in 6 months, course access is permanent
  const expires_at = access_type === 'semester_pass'
    ? new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // Insert or update user_access
  await db.from('user_access').insert({
    user_id,
    course_code: course_code || null,
    access_type,
    expires_at,
  }).catch(async () => {
    // Already exists — update expires_at if semester pass renewal
    if (access_type === 'semester_pass') {
      await db.from('user_access').update(
        { expires_at },
        { user_id: `eq.${user_id}`, access_type: `eq.semester_pass` }
      );
    }
  });

  // Mark transaction success
  await db.from('transactions').update(
    { status: 'success' },
    { id: `eq.${transactionId}` }
  );
};

// ─── GET /api/payments/history ────────────────────────────────────────────────

router.get('/history', requireAuth, async (req, res) => {
  try {
    const transactions = await db.from('transactions').select(
      'id,course_code,access_type,amount_kobo,reference,status,created_at',
      { user_id: `eq.${req.user.id}` },
      { order: 'created_at.desc', limit: 20 }
    );

    res.json({ transactions: transactions || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

