/**
 * Engagement Tracker – Backend Service
 * ─────────────────────────────────────────────────────────────────────
 * POST /analyze   → receives session event log, asks Claude for an
 *                   engagement verdict, and optionally triggers a
 *                   client-side modal.
 *
 * Constraints honoured:
 *   ✓ No hardcoded API keys (process.env only)
 *   ✓ Only structured event metadata sent to the LLM (no raw HTML)
 *   ✓ 5-second timeout on the Anthropic call
 * ─────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

/* ──────────────────────── VALIDATE ENV ──────────────────────────── */

const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`✖  Missing required env var: ${key}`);
    process.exit(1);
  }
}

/* ──────────────────────── INIT ──────────────────────────────────── */

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 5000, // hard 5-second timeout
});

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

/* ──────────────────────── MIDDLEWARE ────────────────────────────── */

// Security headers
app.use(helmet());

// CORS – restrict to your Shopify storefront(s)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0
    ? function (origin, cb) {
      // Allow requests with no origin (e.g. sendBeacon in some browsers)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS: origin not allowed'));
    }
    : true, // dev fallback: allow all
  methods: ['POST', 'GET'],
}));

// Body parsing – cap at 256 KB to prevent abuse
app.use(express.json({ limit: '256kb' }));

// Rate limiting per IP
app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

/* ──────────────────────── HELPERS ──────────────────────────────── */

/**
 * Extract relevant metadata from the raw event array.
 * This is the ONLY data we send to the LLM – never raw HTML.
 */
function buildSessionSummary(sessionId, events) {
  const pageViews = [];
  const clicks = [];
  let totalTime = 0;
  let currentUrl = null;
  let cartActions = 0;

  for (const evt of events) {
    switch (evt.type) {
      case 'page_view':
        pageViews.push({
          url: evt.url,
          pageType: evt.payload?.pageType || 'unknown',
          title: (evt.payload?.title || '').slice(0, 120),
          time: evt.timestamp,
        });
        currentUrl = evt.url;
        break;

      case 'click':
        clicks.push({
          selector: evt.payload?.selector || '',
          text: (evt.payload?.text || '').slice(0, 80),
          isAddToCart: !!evt.payload?.isAddToCart,
          url: evt.url,
          time: evt.timestamp,
        });
        if (evt.payload?.isAddToCart) cartActions++;
        break;

      case 'time_on_page':
        totalTime += evt.payload?.seconds || 0;
        break;

      default:
        break;
    }
  }

  return {
    sessionId,
    currentUrl,
    totalPageViews: pageViews.length,
    pageViews,
    totalClicks: clicks.length,
    clicks,
    cartActions,
    totalTimeSeconds: totalTime,
  };
}

/**
 * Build the CRO Specialist system prompt and user message for Claude.
 *
 * Constraints baked into the prompt:
 *   - No trigger if user < 60 s on site
 *   - No trigger if user is on checkout
 *   - No generic discounts unless 3+ views of same product or cart abandonment
 *   - Message must be < 15 words, raw JSON only
 */
function buildPrompt(summary) {
  const system = [
    'You are a "Conversion Rate Optimization" (CRO) Specialist.',
    'Your goal is to analyze a Shopify user session and decide if a proactive',
    'message will help them convert — without being annoying.',
    '',
    'INPUT you receive:',
    '  • events   – list of page views and clicks',
    '  • cart_status – number of Add-to-Cart actions in this session',
    '  • time_spent – total seconds on site',
    '',
    'OUTPUT: Return ONLY a raw JSON object (no markdown, no commentary):',
    '  {"trigger": boolean, "message": "string"}',
    '',
    'HARD RULES (violating any of these is a failure):',
    '1. DO NOT trigger if time_spent < 60 seconds.',
    '2. DO NOT trigger if the user is currently on a Checkout page.',
    '3. DO NOT offer generic discounts (e.g. "10% off") UNLESS the user has',
    '   viewed the same product 3+ times OR has abandoned a cart.',
    '4. The "message" MUST be under 15 words.',
    '5. NO conversational filler — return ONLY the raw JSON object.',
    '',
    'GOOD triggers:',
    '  • User lingering on a product page for a long time without acting.',
    '  • User has visited the same product multiple times.',
    '  • User added to cart but hasn\'t proceeded to checkout.',
    '  • User browsing many products — suggest a collection or best-seller.',
    '',
    'BAD triggers (avoid):',
    '  • User just arrived (< 60 s).',
    '  • User is mid-checkout — never distract them.',
    '  • Pressuring language or urgency spam.',
  ].join('\n');

  const userMessage = JSON.stringify({
    events: summary.pageViews.concat(summary.clicks),
    cart_status: {
      addToCartActions: summary.cartActions,
      hasItemsInCart: summary.cartActions > 0,
    },
    time_spent: summary.totalTimeSeconds,
    current_url: summary.currentUrl,
  }, null, 2);

  return { system, userMessage };
}

/**
 * Detect repeated product views (same product URL visited 3+ times).
 */
function hasRepeatedProductViews(summary) {
  const productCounts = {};
  for (const pv of summary.pageViews) {
    if (pv.pageType === 'product') {
      productCounts[pv.url] = (productCounts[pv.url] || 0) + 1;
    }
  }
  return Object.values(productCounts).some(c => c >= 3);
}

/**
 * Detect if the user is currently on a checkout page.
 */
function isOnCheckout(summary) {
  if (!summary.currentUrl) return false;
  return /\/checkouts?\//i.test(summary.currentUrl);
}

/**
 * Parse the LLM response, which should be raw JSON.
 * Gracefully handles markdown-fenced code blocks.
 */
function parseLlmResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned);
}

/* ──────────────────────── ROUTES ───────────────────────────────── */

/**
 * Health check.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * POST /analyze
 *
 * Expects: { sessionId: string, events: Event[] }
 * Returns: { trigger: boolean, message?: string }
 */
app.post('/analyze', async (req, res) => {
  try {
    const { sessionId, events } = req.body;

    /* ── Input validation ──────────────────────────────────────── */
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid sessionId.' });
    }
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array.' });
    }

    /* ── Build structured summary (never raw HTML) ─────────────── */
    const summary = buildSessionSummary(sessionId, events);

    /* ── Server-side pre-checks (skip LLM to save tokens) ──────── */
    if (summary.totalTimeSeconds < 60) {
      return res.json({ trigger: false });
    }
    if (isOnCheckout(summary)) {
      return res.json({ trigger: false });
    }

    /* ── Call Claude with a 5-second timeout ────────────────────── */
    const { system, userMessage } = buildPrompt(summary);

    // Enrich summary with repeat-view flag so the LLM can use it
    const enrichedMessage = JSON.parse(userMessage);
    enrichedMessage.repeated_product_views = hasRepeatedProductViews(summary);

    let completion;
    try {
      completion = await anthropic.messages.create({
        model: MODEL,
        system: system,
        messages: [
          { role: 'user', content: JSON.stringify(enrichedMessage, null, 2) },
        ],
        max_tokens: 256,
        temperature: 0.4,
      });
    } catch (err) {
      // Timeout or API failure → safe default: no trigger
      console.error('[Anthropic Error]', err.message || err);
      return res.json({ trigger: false });
    }

    /* ── Parse the model output ────────────────────────────────── */
    const rawContent = completion.content?.[0]?.text || '';
    let result;

    try {
      result = parseLlmResponse(rawContent);
    } catch {
      console.warn('[Parse Warning] LLM returned non-JSON:', rawContent);
      return res.json({ trigger: false });
    }

    /* ── Post-validation: enforce 15-word limit ────────────────── */
    if (result.trigger && result.message) {
      const wordCount = result.message.trim().split(/\s+/).length;
      if (wordCount > 15) {
        result.message = result.message.trim().split(/\s+/).slice(0, 15).join(' ') + '…';
      }
    }

    /* ── Return a safe, minimal response to the client ─────────── */
    return res.json({
      trigger: result.trigger === true,
      message: result.trigger === true ? (result.message || '') : undefined,
    });

  } catch (err) {
    console.error('[/analyze] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ──────────────────────── START ────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`✔  Engagement Tracker API listening on :${PORT}`);
  console.log(`   Model : ${MODEL}`);
  console.log(`   CORS  : ${allowedOrigins.length ? allowedOrigins.join(', ') : '* (dev mode)'}`);
});
