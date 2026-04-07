/**
 * Shopify Engagement Tracker v1.0
 * ─────────────────────────────────────────────────────────────────────
 * Lightweight, privacy-first analytics snippet for Shopify theme.liquid.
 *
 * Tracks:  page_view · click (Add-to-Cart, Cart links) · time_on_page
 * Ships:   navigator.sendBeacon / fetch+keepalive every 30 s or on action
 * Modal:   one non-intrusive prompt per session when the API says so
 *
 * Zero external dependencies. Does not capture PII.
 * ─────────────────────────────────────────────────────────────────────
 */
; (function EngagementTracker() {
  'use strict';

  /* ──────────────────────────── CONFIG ──────────────────────────── */
  var API_ENDPOINT = 'https://stephane-unapprehended-osteologically.ngrok-free.dev/analyze';
  var FLUSH_INTERVAL = 30000;                       // 30 seconds
  var CLICK_SELECTORS = [
    '[name="add"]',
    'button[type="submit"][name="add"]',
    'form[action*="/cart/add"] button',
    '.cart-link',
    'a[href="/cart"]'
  ];
  var PII_INPUT_TYPES = [
    'password', 'tel', 'email', 'credit-card', 'cc-number',
    'cc-exp', 'cc-csc'
  ];

  /* ──────────────────────── SESSION HELPERS ─────────────────────── */

  /**
   * Generate a v4-ish UUID without crypto (works in older browsers too).
   */
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /**
   * Return (or create) a stable session ID that lives for the tab session.
   */
  function getSessionId() {
    var id = sessionStorage.getItem('_et_sid');
    if (!id) {
      id = uuid();
      sessionStorage.setItem('_et_sid', id);
    }
    return id;
  }

  var SESSION_ID = getSessionId();

  /* ──────────────────────── EVENT QUEUE ─────────────────────────── */

  /**
   * Read the current event log from sessionStorage (returns []).
   */
  function readQueue() {
    try {
      return JSON.parse(sessionStorage.getItem('_et_q') || '[]');
    } catch (_) {
      return [];
    }
  }

  /**
   * Persist the event queue back to sessionStorage.
   */
  function writeQueue(q) {
    try {
      sessionStorage.setItem('_et_q', JSON.stringify(q));
    } catch (_) { /* quota exceeded — drop silently */ }
  }

  /**
   * Push one event onto the queue.
   *
   * @param {string} type    – 'page_view' | 'click' | 'time_on_page'
   * @param {Object} payload – event-specific data
   */
  function pushEvent(type, payload) {
    var q = readQueue();
    q.push({
      type: type,
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      url: location.href,
      payload: payload
    });
    writeQueue(q);
  }

  /* ──────────────────────── PAGE TYPE DETECTION ────────────────── */

  /**
   * Infer the Shopify page type from the URL / meta.
   * Falls back to 'other' when heuristics don't match.
   */
  function detectPageType() {
    var path = location.pathname;

    if (path === '/' || path === '') return 'home';
    if (/^\/collections\/?$/i.test(path)) return 'collections';
    if (/^\/collections\/[^/]+\/?$/i.test(path)) return 'collection';
    if (/^\/products\/[^/]+/i.test(path)) return 'product';
    if (/^\/cart\/?$/i.test(path)) return 'cart';
    if (/\/checkouts?\//i.test(path)) return 'checkout';
    if (/^\/pages\//i.test(path)) return 'page';
    if (/^\/blogs?\//i.test(path)) return 'blog';
    if (/^\/account/i.test(path)) return 'account';
    if (/^\/search/i.test(path)) return 'search';
    if (/\/orders?\//i.test(path)) return 'order';

    // Shopify exposes meta.page.pageType on some themes
    if (window.meta && window.meta.page && window.meta.page.pageType) {
      return window.meta.page.pageType;
    }

    return 'other';
  }

  /* ──────────────────────── PII GUARD ──────────────────────────── */

  /**
   * Returns true when the click target sits inside—or is—a PII input.
   */
  function isPiiElement(el) {
    if (!el) return false;

    // Walk up to check for sensitive fields
    var node = el;
    while (node && node !== document.body) {
      if (node.tagName === 'INPUT') {
        var type = (node.getAttribute('type') || '').toLowerCase();
        var auto = (node.getAttribute('autocomplete') || '').toLowerCase();
        if (PII_INPUT_TYPES.indexOf(type) !== -1) return true;
        if (PII_INPUT_TYPES.indexOf(auto) !== -1) return true;
        if (/password|card|cvv|cvc|ssn/i.test(node.className + ' ' + node.id + ' ' + node.name)) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  /* ──────────────────────── DATA SHIPPING ──────────────────────── */

  var _flushTimer = null;
  var _modalShown = sessionStorage.getItem('_et_modal') === '1';

  /**
   * Send the queued events to the backend.
   *
   * @param {boolean} isBeacon – if true, uses sendBeacon (page unload)
   */
  function flush(isBeacon) {
    var q = readQueue();
    if (q.length === 0) return;

    var body = JSON.stringify({
      sessionId: SESSION_ID,
      events: q
    });

    // Clear the queue immediately to avoid double-sends
    writeQueue([]);

    if (isBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(API_ENDPOINT, new Blob([body], { type: 'application/json' }));
      return; // sendBeacon doesn't return a response we can read
    }

    // Use fetch + keepalive so the browser won't cancel on nav
    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: body,
      keepalive: true
    })
      .then(function (res) { return res.json(); })
      .then(handleApiResponse)
      .catch(function () { /* network error – events are lost, acceptable */ });
  }

  /**
   * Process the API response.  If `trigger: true` → show modal once.
   */
  function handleApiResponse(data) {
    if (!data) return;
    if (data.trigger === true && !_modalShown) {
      _modalShown = true;
      sessionStorage.setItem('_et_modal', '1');
      showModal(data.message || '');
    }
  }

  /* ──────────────────────── MODAL UI ───────────────────────────── */

  /**
   * Inject a non-intrusive slide-in modal with the given message.
   * Dismisses on click/tap of the close button or the backdrop.
   */
  function showModal(message) {
    if (!message) return;

    // ── Styles (scoped via unique id) ──
    var styleId = '_et_modal_style';
    if (!document.getElementById(styleId)) {
      var css = document.createElement('style');
      css.id = styleId;
      css.textContent = [
        '#_et_overlay{',
        '  position:fixed;inset:0;z-index:2147483647;',
        '  display:flex;align-items:flex-end;justify-content:center;',
        '  background:rgba(0,0,0,.35);',
        '  opacity:0;transition:opacity .3s ease;',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
        '}',
        '#_et_overlay._et_show{opacity:1}',
        '#_et_card{',
        '  position:relative;',
        '  max-width:460px;width:92%;margin:0 auto 24px;',
        '  background:#fff;border-radius:14px;',
        '  box-shadow:0 12px 40px rgba(0,0,0,.18);',
        '  padding:28px 24px 22px;',
        '  transform:translateY(40px);transition:transform .35s cubic-bezier(.16,1,.3,1);',
        '}',
        '#_et_overlay._et_show #_et_card{transform:translateY(0)}',
        '#_et_card p{',
        '  margin:0;font-size:15px;line-height:1.55;color:#1a1a1a;',
        '}',
        '#_et_close{',
        '  position:absolute;top:10px;right:12px;',
        '  background:none;border:none;font-size:22px;color:#999;cursor:pointer;',
        '  line-height:1;padding:4px 8px;',
        '}',
        '#_et_close:hover{color:#333}',
      ].join('\n');
      document.head.appendChild(css);
    }

    // ── Markup ──
    var overlay = document.createElement('div');
    overlay.id = '_et_overlay';
    overlay.innerHTML = [
      '<div id="_et_card">',
      '  <button id="_et_close" aria-label="Close">&times;</button>',
      '  <p>' + escapeHtml(message) + '</p>',
      '</div>'
    ].join('');

    document.body.appendChild(overlay);

    // Trigger reflow then animate in
    void overlay.offsetHeight;
    overlay.classList.add('_et_show');

    // Dismiss handlers
    function dismiss() {
      overlay.classList.remove('_et_show');
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 350);
    }

    document.getElementById('_et_close').addEventListener('click', dismiss);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) dismiss();
    });
  }

  /**
   * Basic HTML entity escaping to prevent injection.
   */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /* ──────────────────────── EVENT LISTENERS ─────────────────────── */

  // 1. PAGE VIEW ──────────────────────────────────────────────────
  pushEvent('page_view', {
    pageType: detectPageType(),
    referrer: document.referrer || null,
    title: document.title
  });

  // 2. CLICK TRACKING (delegated) ─────────────────────────────────
  document.addEventListener('click', function (e) {
    var target = e.target;

    // Guard: skip PII-adjacent clicks
    if (isPiiElement(target)) return;

    // Walk up to find a matching selector
    var matched = null;
    for (var i = 0; i < CLICK_SELECTORS.length; i++) {
      var hit = target.closest(CLICK_SELECTORS[i]);
      if (hit) { matched = hit; break; }
    }
    if (!matched) return;

    var isAddToCart = !!(
      matched.matches('[name="add"]') ||
      matched.matches('form[action*="/cart/add"] button')
    );

    pushEvent('click', {
      selector: selectorPath(matched),
      text: (matched.textContent || '').trim().substring(0, 120),
      isAddToCart: isAddToCart
    });

    // Add-to-Cart is a "significant action" → flush immediately
    if (isAddToCart) {
      flush(false);
    }
  }, true); // capture phase to beat stopPropagation

  // 3. TIME ON PAGE ───────────────────────────────────────────────
  var _pageStart = Date.now();

  function recordTimeOnPage() {
    var seconds = Math.round((Date.now() - _pageStart) / 1000);
    if (seconds > 0) {
      pushEvent('time_on_page', { seconds: seconds });
      _pageStart = Date.now();
    }
  }

  /* ──────────────────────── SELECTOR PATH HELPER ────────────────  */

  /**
   * Build a short, human-readable CSS path for the clicked element.
   * We deliberately avoid capturing any attribute values that could
   * contain PII (e.g. input values).
   */
  function selectorPath(el) {
    if (!el || el === document.body) return 'body';

    var parts = [];
    var node = el;
    var depth = 0;

    while (node && node !== document.body && depth < 4) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + node.id);
        break;
      }
      var cls = (node.className && typeof node.className === 'string')
        ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      parts.unshift(tag + cls);
      node = node.parentElement;
      depth++;
    }

    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  /* ──────────────────────── PERIODIC FLUSH ──────────────────────  */

  _flushTimer = setInterval(function () {
    recordTimeOnPage();
    flush(false);
  }, FLUSH_INTERVAL);

  /* ──────────────────────── PAGE LIFECYCLE ──────────────────────  */

  // Flush + record time on page when leaving
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      recordTimeOnPage();
      flush(true); // beacon – reliable on tab close / navigate
    }
  });

  // Fallback for older browsers without visibilitychange
  window.addEventListener('pagehide', function () {
    recordTimeOnPage();
    flush(true);
  });

  // Cleanup on full unload (belt-and-suspenders)
  window.addEventListener('beforeunload', function () {
    clearInterval(_flushTimer);
  });

})();
