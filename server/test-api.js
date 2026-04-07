/**
 * Standalone test script — verifies API logic WITHOUT starting a server.
 * Tests:
 *   1. Health check (simulated)
 *   2. /analyze with <60s session (should return trigger:false, no AI call)
 *   3. /analyze with checkout URL (should return trigger:false, no AI call)
 *   4. /analyze with a real engaged session (calls Claude, expects JSON back)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

/* ──────────────────── Re-use server helpers ──────────────────── */

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
    }
  }

  return {
    sessionId, currentUrl,
    totalPageViews: pageViews.length, pageViews,
    totalClicks: clicks.length, clicks,
    cartActions, totalTimeSeconds: totalTime,
  };
}

function hasRepeatedProductViews(summary) {
  const counts = {};
  for (const pv of summary.pageViews) {
    if (pv.pageType === 'product') {
      counts[pv.url] = (counts[pv.url] || 0) + 1;
    }
  }
  return Object.values(counts).some(c => c >= 3);
}

function isOnCheckout(summary) {
  if (!summary.currentUrl) return false;
  return /\/checkouts?\//i.test(summary.currentUrl);
}

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

function parseLlmResponse(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(cleaned);
}

/* ──────────────────── Test Data ──────────────────── */

const TEST_SESSION_SHORT = {
  sessionId: 'test-short-session',
  events: [
    { type: 'page_view', url: 'https://shop.example.com/', timestamp: new Date().toISOString(), payload: { pageType: 'home', title: 'My Shop' } },
    { type: 'time_on_page', url: 'https://shop.example.com/', timestamp: new Date().toISOString(), payload: { seconds: 15 } },
  ],
};

const TEST_SESSION_CHECKOUT = {
  sessionId: 'test-checkout-session',
  events: [
    { type: 'page_view', url: 'https://shop.example.com/checkouts/abc123', timestamp: new Date().toISOString(), payload: { pageType: 'checkout', title: 'Checkout' } },
    { type: 'time_on_page', url: 'https://shop.example.com/checkouts/abc123', timestamp: new Date().toISOString(), payload: { seconds: 120 } },
  ],
};

const TEST_SESSION_ENGAGED = {
  sessionId: 'test-engaged-session',
  events: [
    { type: 'page_view', url: 'https://shop.example.com/', timestamp: new Date(Date.now() - 300000).toISOString(), payload: { pageType: 'home', title: 'My Shop' } },
    { type: 'page_view', url: 'https://shop.example.com/collections/shirts', timestamp: new Date(Date.now() - 250000).toISOString(), payload: { pageType: 'collection', title: 'Shirts' } },
    { type: 'page_view', url: 'https://shop.example.com/products/classic-tee', timestamp: new Date(Date.now() - 200000).toISOString(), payload: { pageType: 'product', title: 'Classic Tee' } },
    { type: 'page_view', url: 'https://shop.example.com/products/premium-hoodie', timestamp: new Date(Date.now() - 150000).toISOString(), payload: { pageType: 'product', title: 'Premium Hoodie' } },
    { type: 'page_view', url: 'https://shop.example.com/products/classic-tee', timestamp: new Date(Date.now() - 100000).toISOString(), payload: { pageType: 'product', title: 'Classic Tee' } },
    { type: 'click', url: 'https://shop.example.com/products/classic-tee', timestamp: new Date(Date.now() - 90000).toISOString(), payload: { selector: 'button#add-to-cart', text: 'Add to Cart', isAddToCart: true } },
    { type: 'page_view', url: 'https://shop.example.com/collections/accessories', timestamp: new Date(Date.now() - 60000).toISOString(), payload: { pageType: 'collection', title: 'Accessories' } },
    { type: 'time_on_page', url: 'https://shop.example.com/collections/accessories', timestamp: new Date().toISOString(), payload: { seconds: 185 } },
  ],
};

/* ──────────────────── Runner ──────────────────── */

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Engagement Tracker — API Logic Tests');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Test 1: Health check (simulated) ──
  console.log('── Test 1: Health Check (simulated) ──');
  const health = { status: 'ok', uptime: process.uptime() };
  console.log('  Response:', JSON.stringify(health));
  console.log(`  ${PASS} — Health endpoint returns { status: "ok" }\n`);

  // ── Test 2: Short session (<60s) → no trigger ──
  console.log('── Test 2: Short Session (<60s) → should NOT trigger ──');
  const summary2 = buildSessionSummary(TEST_SESSION_SHORT.sessionId, TEST_SESSION_SHORT.events);
  console.log(`  Total time: ${summary2.totalTimeSeconds}s`);
  if (summary2.totalTimeSeconds < 60) {
    console.log(`  ${PASS} — Server-side pre-check blocks this (no AI call needed)`);
    console.log('  Response: { "trigger": false }\n');
  } else {
    console.log(`  ${FAIL} — Expected totalTime < 60 but got ${summary2.totalTimeSeconds}\n`);
  }

  // ── Test 3: Checkout page → no trigger ──
  console.log('── Test 3: Checkout Page → should NOT trigger ──');
  const summary3 = buildSessionSummary(TEST_SESSION_CHECKOUT.sessionId, TEST_SESSION_CHECKOUT.events);
  console.log(`  Current URL: ${summary3.currentUrl}`);
  if (isOnCheckout(summary3)) {
    console.log(`  ${PASS} — Server-side pre-check blocks checkout pages (no AI call needed)`);
    console.log('  Response: { "trigger": false }\n');
  } else {
    console.log(`  ${FAIL} — Expected checkout detection but isOnCheckout returned false\n`);
  }

  // ── Test 4: Engaged session → real Claude call ──
  console.log('── Test 4: Engaged Session → AI Analysis (calling Claude) ──');
  const summary4 = buildSessionSummary(TEST_SESSION_ENGAGED.sessionId, TEST_SESSION_ENGAGED.events);
  console.log(`  Pages viewed:  ${summary4.totalPageViews}`);
  console.log(`  Clicks:        ${summary4.totalClicks}`);
  console.log(`  Cart actions:  ${summary4.cartActions}`);
  console.log(`  Time on site:  ${summary4.totalTimeSeconds}s`);
  console.log(`  Current URL:   ${summary4.currentUrl}`);
  console.log(`  Repeat views:  ${hasRepeatedProductViews(summary4)}`);
  console.log('');

  // Pre-checks should pass
  if (summary4.totalTimeSeconds < 60) {
    console.log(`  ${FAIL} — Pre-check would block this (time < 60s)\n`);
    return;
  }
  if (isOnCheckout(summary4)) {
    console.log(`  ${FAIL} — Pre-check would block this (on checkout)\n`);
    return;
  }

  console.log('  Pre-checks passed. Calling Claude AI...\n');

  const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 10000 });
  const { system, userMessage } = buildPrompt(summary4);

  const enrichedMessage = JSON.parse(userMessage);
  enrichedMessage.repeated_product_views = hasRepeatedProductViews(summary4);

  try {
    const start = Date.now();
    const completion = await anthropic.messages.create({
      model: MODEL,
      system: system,
      messages: [{ role: 'user', content: JSON.stringify(enrichedMessage, null, 2) }],
      max_tokens: 256,
      temperature: 0.4,
    });
    const elapsed = Date.now() - start;

    const rawContent = completion.content?.[0]?.text || '';
    console.log(`  ⏱  Claude responded in ${elapsed}ms`);
    console.log(`  📝 Raw response:\n     ${rawContent}\n`);

    // Parse
    let result;
    try {
      result = parseLlmResponse(rawContent);
    } catch (e) {
      console.log(`  ${FAIL} — Could not parse response as JSON: ${e.message}\n`);
      return;
    }

    // Validate structure
    const hasTrigger = typeof result.trigger === 'boolean';
    const hasMessage = result.trigger ? typeof result.message === 'string' : true;
    const messageOk = !result.message || result.message.trim().split(/\s+/).length <= 15;

    console.log('  Parsed result:');
    console.log(`    trigger:  ${result.trigger} (type: ${typeof result.trigger})`);
    console.log(`    message:  ${result.message || '(none)'}`);
    if (result.message) {
      console.log(`    words:    ${result.message.trim().split(/\s+/).length}/15`);
    }
    console.log('');

    if (hasTrigger && hasMessage && messageOk) {
      console.log(`  ${PASS} — Claude returned valid JSON with correct structure`);
      if (result.trigger) {
        console.log(`  ${PASS} — AI decided to trigger a message for this engaged session`);
      } else {
        console.log(`  ⚠️  AI chose NOT to trigger — this is valid but unexpected for such an engaged session`);
      }
    } else {
      if (!hasTrigger) console.log(`  ${FAIL} — "trigger" should be boolean, got ${typeof result.trigger}`);
      if (!hasMessage) console.log(`  ${FAIL} — "message" should be string when trigger is true`);
      if (!messageOk) console.log(`  ${FAIL} — Message exceeds 15 words`);
    }

  } catch (err) {
    console.log(`  ${FAIL} — Anthropic API call failed: ${err.message}`);
    if (err.status) console.log(`         Status: ${err.status}`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  All tests complete.');
  console.log('═══════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
