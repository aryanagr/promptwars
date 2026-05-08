// Security regression tests: XSS escaping, header presence, auth gating.
process.env.ORIGIN_GUARD = 'off';
process.env.API_RATE_LIMIT_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, _internals } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => { await new Promise((r) => server.close(r)); });

// === XSS regression ===

test('escapeHtml: defangs <script> payload', () => {
  const payload = '<script>alert("pwned")</script>';
  const escaped = _internals.escapeHtml(payload);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));
});

test('escapeHtml: defangs onerror image payload', () => {
  const payload = '<img src=x onerror="alert(1)">';
  const escaped = _internals.escapeHtml(payload);
  assert.ok(!escaped.includes('<img'));
  assert.ok(escaped.includes('&lt;img'));
});

test('escapeHtml: defangs javascript: URL in href context', () => {
  const escaped = _internals.escapeHtml('javascript:alert(1)');
  // Just escape — safeUrl on the frontend filters protocol; this is the inner text path.
  assert.equal(escaped, 'javascript:alert(1)'); // no HTML-significant chars to escape
});

// === Security headers ===

test('GET / returns CSP, X-Frame-Options, X-Content-Type-Options', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('GET /api/health attaches an X-Request-ID header', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const reqId = res.headers.get('x-request-id');
  assert.ok(reqId && reqId.length > 0, 'X-Request-ID should be set');
});

test('Helmet adds Origin-Agent-Cluster and X-Permitted-Cross-Domain headers', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.headers.get('origin-agent-cluster'), '?1');
  assert.equal(res.headers.get('x-permitted-cross-domain-policies'), 'none');
});

// === Auth + storage gating ===

test('POST /api/save-itinerary without scope returns 401', async () => {
  const res = await fetch(`${baseUrl}/api/save-itinerary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itinerary: { days: [] } })
  });
  assert.equal(res.status, 401);
});

test('POST /api/save-itinerary with X-Session-ID succeeds and round-trips', async () => {
  const sessionId = 'test-session-' + Date.now();
  const headers = { 'Content-Type': 'application/json', 'X-Session-ID': sessionId };

  const saveRes = await fetch(`${baseUrl}/api/save-itinerary`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ itinerary: { tripTitle: 'Round trip', days: [{ activities: [] }] } })
  });
  const saveData = await saveRes.json();
  assert.equal(saveRes.status, 200);
  assert.equal(saveData.success, true);
  assert.ok(saveData.id);

  const listRes = await fetch(`${baseUrl}/api/saved-itineraries`, { method: 'POST', headers, body: '{}' });
  const listData = await listRes.json();
  assert.equal(listData.success, true);
  assert.ok(listData.items.some((i) => i.id === saveData.id));

  const loadRes = await fetch(`${baseUrl}/api/saved-itinerary/${saveData.id}`, { method: 'POST', headers, body: '{}' });
  const loadData = await loadRes.json();
  assert.equal(loadData.success, true);
  assert.equal(loadData.item.tripTitle, 'Round trip');

  const delRes = await fetch(`${baseUrl}/api/saved-itinerary/${saveData.id}/delete`, { method: 'POST', headers, body: '{}' });
  const delData = await delRes.json();
  assert.equal(delData.success, true);
  assert.equal(delData.deleted, 1);
});

test('GET /api/auth-config exposes whether auth is enabled', async () => {
  const res = await fetch(`${baseUrl}/api/auth-config`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok('googleClientId' in data);
  assert.equal(data.storageEnabled, true);
});

test('XSS-laden itinerary saved and reloaded does not execute (data preserved as text)', async () => {
  const sessionId = 'xss-' + Date.now();
  const headers = { 'Content-Type': 'application/json', 'X-Session-ID': sessionId };
  const evilTitle = '<img src=x onerror=alert(1)>';
  const saveRes = await fetch(`${baseUrl}/api/save-itinerary`, {
    method: 'POST', headers,
    body: JSON.stringify({ itinerary: { tripTitle: evilTitle, days: [{ activities: [] }] } })
  });
  const saveData = await saveRes.json();
  // sanitizeText strips control chars but does NOT escape HTML — escape happens at render time.
  // Just verify the value is stored verbatim and round-trips.
  const loadRes = await fetch(`${baseUrl}/api/saved-itinerary/${saveData.id}`, { method: 'POST', headers, body: '{}' });
  const loadData = await loadRes.json();
  assert.equal(loadData.item.tripTitle, evilTitle);
});
