# TravelAI — Code Review

Scope: `server.js`, `lib/trip-planner-utils.js`, `public/index.html`, `public/script.js`, `public/style.css`, `tests/`, `package.json`, `ecosystem.config.cjs`.
Method: full-file read of each, smoke-test of the running server (`/api/health`, security headers, replan input validation, sitemap, robots), full pass of the existing test suite (`5/5 passing`).

## At-a-glance

| Area | Grade | Headline |
| --- | --- | --- |
| Code Quality | B− | Clean utility lib + working app, but `server.js` and `script.js` are monolithic with mixed concerns. |
| Security | B+ | Recent XSS / email-injection fixes closed the critical holes; CSP added. A few moderate items remain. |
| Efficiency | C+ | Sequential per-activity API calls and unbounded in-memory caches will hurt under load. |
| Testing | C− | Pure utils have unit tests; routes, parsers, and frontend have none. |
| Accessibility | B− | Solid baseline (ARIA roles, sr-announcer, semantic structure); contrast and focus management need attention. |
| Google Services | B | Sensible model choice and field masks; missing batching, exponential backoff, and quota guards. |

---

## 1. Code Quality

### What's good
- **`lib/trip-planner-utils.js`** is genuinely well-factored: pure functions, no side effects, no hidden state. Easy to test, easy to reason about. This is the bar to aim for elsewhere.
- **Consistent error-response shape** across all endpoints: `{ success: boolean, error?: string, ... }` — frontend handlers can rely on it.
- **Multi-alias env resolution with `_FILE` fallback** for Cloud Run secrets is thoughtful ([server.js:25-43](server.js#L25-L43)).
- **Lightweight JSON repair** for truncated LLM output is pragmatic and well-scoped ([server.js:417-458](server.js#L417-L458)).
- **Defensive map handling**: `mapsReady` flag, `gm_authFailure` callback, fallback messages when the SDK fails to load.

### What hurts
- **`server.js` is a 996-line god file** combining: env parsing, validation, security headers, rate limiter, in-memory cache, Gemini wrapper, Maps/Places/Routes wrappers, mailer, prompts, schema validator, and 10 route handlers. Reasoning about any change requires holding all of it in your head.
- **`public/script.js` is 994 lines with eight top-level mutable globals** (`gMap`, `markers`, `itineraryData`, `currentDayIndex`, `mapsReady`, `replanInFlight`, `routeInFlight`, `dayActivityPage`). Hard to test in isolation; any bug touching state requires tracing the whole file.
- **Duplicated logic**: `normalizeCityName` is defined in [lib/trip-planner-utils.js:1-3](lib/trip-planner-utils.js#L1-L3) AND [public/script.js:31-33](public/script.js#L31-L33). Same with date parsing concepts. No bundler means this drift will happen.
- **Inconsistent mutation contracts**: `enrichWithBookingLinks` mutates *and* returns ([server.js:466-480](server.js#L466-L480)); some callers assign the return ([server.js:642](server.js#L642)), some rely on the mutation ([server.js:945](server.js#L945)). Pick one.
- **Inline `onclick="..."` handlers** generated as strings in `script.js` ([public/script.js:524-548](public/script.js#L524-L548)) coexist with `addEventListener` elsewhere — two paradigms in one codebase, and the inline form forces `'unsafe-inline'` in the CSP.
- **Magic numbers scattered**: `22000`, `25000`, `60000`, `120`, `150`, `5000`, `2500`. A few are env-tunable; most aren't.
- **Comment quality is mixed**: useful comments in `cleanAndParseJSON` are absent; banal "// Form submission" / "// Set default dates" markers add noise.
- **Browser script uses `prompt()` and `alert()`** for the email flow ([public/script.js:983-997](public/script.js#L983-L997)) while replan uses a real modal — UX inconsistency.

### Recommendations (prioritized)

1. **Split `server.js`** into:
   ```
   src/
     index.js                 // app bootstrap
     middleware/
       security.js            // CSP, headers
       rateLimit.js
       cors.js
     services/
       gemini.js              // getModel, generateWithRetry, prompt builders
       places.js              // placesTextSearch
       routes.js              // computeRouteMinutes
       mailer.js              // transporter, itineraryToEmailHtml, escapeHtml
       cache.js               // itineraryCache, stableStringify, buildKey
     routes/
       itinerary.js           // /generate, /replan-*, /apply-constraints
       maps.js                // /maps-key, /validate-places, /compute-routes
       mail.js                // /email-itinerary
       health.js
   ```
   No behavior change — it's a pure mechanical refactor with high readability payoff.
2. **Extract `script.js` state into a single object** (e.g. `const state = { gMap, markers, ... }`) and group functions into modules using `<script type="module">`. Browser-supported with no bundler.
3. **Share `normalizeCityName`** by either (a) adopting a tiny bundler (esbuild/vite) or (b) generating `public/shared.js` from the lib at build time, or (c) commenting both copies "must stay in sync with `lib/trip-planner-utils.js`".
4. **Pick one mutation style** for `enrichWithBookingLinks` — recommend pure (returns new object) or void-mutating, not both.
5. **Replace inline `onclick=` with event delegation** on `#itinerary-content`. This lets you drop `'unsafe-inline'` from `script-src` and tightens CSP.
6. **Make timeouts and caps configurable**: `GEMINI_TIMEOUT_MS`, `REPLAN_DAY_TIMEOUT_MS`, `MAX_PLACES_PER_VALIDATION`, etc.
7. **Remove banal `// what` comments**; keep only "why" comments.

---

## 2. Security

### Recently fixed (verified by smoke test)
| Issue | Fix | Verified |
| --- | --- | --- |
| Reflected XSS via AI output in activity cards / day header / InfoWindow / toast | `escapeHtml` + `safeUrl` helpers; `textContent` for toast/map-unavailable | ✅ |
| HTML injection in outbound emails | `escapeHtml` over every interpolation in `itineraryToEmailHtml` | ✅ |
| Subject/text-body header-injection via newlines | `sanitizeText` strips control chars from subject/text body | ✅ |
| `replan-day` raw `dayIndex` (string-vs-number) and missing array guards | Uses `safeDayIndex`; `Array.isArray` guards on nested `activities` | ✅ |
| `day.activities[0]?.location` throws when `activities` undefined | Now `day.activities?.[0]?.location` | ✅ |
| Lat/lng zero coordinate skipped validation | `Number.isFinite` + range check | ✅ |
| No CSP | Full CSP added with origin allow-lists, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` | ✅ |

### Remaining issues — prioritized

#### High
- **CSP still allows `'unsafe-inline'` for both script and style.** Inline `onclick=` handlers and the inline `<script type="application/ld+json">` block force this. Long-term: convert to event delegation, then remove `'unsafe-inline'` and add per-load nonces. Until then, the CSP blocks cross-origin script injection but not reflected inline-script injection — escaping is your only line of defense (which we now have).
- **No authentication on any POST endpoint.** Anyone on the internet who finds the URL can:
  - Burn your Gemini quota (rate-limited to 30/min/IP, but easy to rotate IPs)
  - Send arbitrary emails through your SMTP relay (rate-limited to 30/min)
  - Burn Maps Places/Routes quota
  Add a simple bearer token (`X-API-Key`) check for any non-localhost deploy, or move the form behind an auth wall. At minimum, lock `/api/email-itinerary` behind a Turnstile/reCAPTCHA challenge — it's the most abusable surface.

#### Medium
- **`/api/maps-key` returns the Maps key to anyone.** This is unavoidable for a pure-frontend Maps integration, but make sure the key in GCP has:
  - HTTP referrer restrictions matching your production hostname only
  - API restrictions: only Maps JavaScript API enabled (separate keys for Places/Routes which are server-side)
- **In-memory rate limiter and cache** ([server.js:163-188](server.js#L163-L188)) — fine on a single Cloud Run instance; multiple instances each get their own limit, so the effective limit is `instances × 30/min`. Use Redis/Memorystore once you autoscale.
- **CORS in default config is permissive** — when `CORS_ORIGINS` is unset, Express CORS allows all origins. Set it for production.
- **Itinerary cache is unbounded.** `itineraryCache.set()` ([server.js:234](server.js#L234)) never trims; only the rate-limit map has eviction. Add an LRU bound (e.g. 500 entries).
- **No request-size guard beyond Express's 250 KB JSON limit.** A user could ship a 200 KB itinerary to `/api/replan-day` causing a giant Gemini prompt. Cap `itinerary.days.length` and total activity count on every endpoint that accepts an itinerary payload.

#### Low
- **`prompt()` for email entry** has no validation beyond a basic regex and offers no UX for autofill or paste-cleaning. Replace with the existing `reason-modal` pattern.
- **Stack traces leak through `formatApiError`** when Gemini returns rich error details — fine for a hackathon, redact for production.
- **No `helmet` package** — you've reimplemented most of what helmet would do. Adopting `helmet()` would replace ~25 lines of header middleware with one `app.use(helmet({ contentSecurityPolicy: { directives: ... } }))`.

#### Reviewed and OK
- SQL injection — n/a (no DB).
- SSRF — server fetches Gemini and Maps with hardcoded URLs only.
- Path traversal — `express.static('public')` is safe.
- Secret exposure in logs — `console.error` only logs `err.message`, not the full env.

---

## 3. Efficiency

### Server hot paths

| Path | Hottest cost | Notes |
| --- | --- | --- |
| `POST /api/generate-itinerary` | Gemini call (~5–20s) | SHA256-cached for 3 min — good. |
| `POST /api/validate-places` | Sequential Places API calls | **N round-trips** for N activities. |
| `POST /api/compute-routes` | Sequential Routes API calls | **N–1 round-trips** per day. |
| `POST /api/replan-*` | Gemini call | No caching — every replan hits the API. |
| `POST /api/email-itinerary` | SMTP handshake | New transporter per request. |

### Issues

1. **Sequential external API calls.** [server.js:782-800](server.js#L782-L800) and [server.js:821-837](server.js#L821-L837) use `for…of` with `await` inside. A 7-day × 4-activity itinerary triggers 28 sequential Places calls. Latency = 28 × ~200ms ≈ 6 s. With `Promise.all` on each day (4 parallel), that drops to ~1.5 s.
2. **`getModel()` rebuilds the Gemini SDK on every call** ([server.js:254-269](server.js#L254-L269)). `new GoogleGenerativeAI(key)` is cheap but pointless to repeat — memoize once, since the key is stable per process.
3. **SMTP transporter is created per request** ([server.js:973](server.js#L973)). Build it once at startup (or lazily on first call) and reuse — saves the TLS handshake on every send.
4. **Unbounded itinerary cache** — `itineraryCache.set()` never evicts on size, only on TTL miss. Under high traffic with diverse inputs, memory grows unbounded.
5. **`JSON.parse(JSON.stringify(value))` for cache deep-clone** ([server.js:227, 234](server.js#L227)) — fine for small payloads, but it's the most expensive way to clone in hot paths.
6. **Loading Maps SDK on every itinerary** — the `loadMapsAPI` short-circuit on `window.google.maps` works, so subsequent generates skip the script tag, but the first call always blocks on script load. Consider preloading via `<link rel="preload" as="script">`.
7. **`animateLoadingSteps` runs a `setInterval` that may not be cleared** if the request errors before `renderResults` runs — `showFatalError` calls `resetLoadingSteps` but never `clearInterval(window._loadingInterval)`. Minor leak per failed generate.

### Recommendations

1. **Parallelize Places/Routes per day**:
   ```js
   for (const day of itinerary.days) {
     const acts = day.activities || [];
     const results = await Promise.all(acts.map((act) =>
       placesTextSearch(`${...}`).catch(() => null)
     ));
     // assign back
   }
   ```
   Bound concurrency with a tiny `pLimit(5)` if you ever exceed Maps QPS.
2. **Memoize `getModel()`** at module scope.
3. **Single global `nodemailer.createTransport`** built once.
4. **Cap the cache** to 500 entries with LRU eviction (or use `lru-cache` from npm — 6 KB).
5. **Switch `JSON.parse(JSON.stringify(...))` to `structuredClone(...)`** — Node 17+, faster.
6. **Clear `window._loadingInterval` in `showFatalError`** to plug the leak.
7. **Add `Cache-Control: public, max-age=86400` for `style.css`/static assets** — currently `no-store` is set on every `.js`/`.css` ([server.js:251-256](server.js#L251-L256)) which forces re-download on every page load. Use ETags or content hashing instead (you already version-bust with `?v=20260508-7`).

---

## 4. Testing

### What exists
- `tests/trip-planner-utils.test.js`: 5 tests — all passing — covering `buildInclusiveDates`, `sanitizeStops`, `buildCityPlan` (happy path + duplicate-destination rejection), and `applyCityPlanToItinerary` (padding behavior).
- Run: `npm test` (uses Node's built-in `node:test` runner — no dev dependencies needed).

### Coverage gaps

**Server (zero coverage):**
- `cleanAndParseJSON` — the JSON repair logic deserves tests for: well-formed input, code-fenced input, truncated string, truncated array, truncated object, double-truncated.
- `validateItinerary` — should fail for missing fields, invalid coords, duplicate places.
- `buildItineraryCacheKey` — equivalent inputs in different key orders should hash identically.
- `parseTimeToMinutes` / `durationTextToMinutes` — edge cases (12:00 AM/PM, missing minutes, empty input).
- Rate limiter — bucket eviction, retry-after header.
- All 10 route handlers — at minimum, validation-error paths (no Gemini calls needed).

**Frontend (zero coverage):**
- `escapeHtml`, `safeUrl`, `toLatLng`, `validateIntermediateStops`, `calculateTripDays`, `normalizeRoutePoints`, `routeStatusMessage`. All pure functions.

### Recommendations (prioritized)

1. **Extend `tests/` with route validation tests** using `supertest`:
   ```js
   const request = require('supertest');
   const { createApp } = require('../src/app');  // requires the split refactor
   ```
   Hit each endpoint with bad input and assert the 400 + error-message shape. No external API calls — just validation paths.
2. **Add a focused parser test file**: `tests/clean-and-parse-json.test.js` — copy ~10 real Gemini truncation failures into fixtures and assert recovery.
3. **Add a CI workflow** (`.github/workflows/test.yml`) that runs `npm test` on every push.
4. **Frontend pure-function tests**: factor `escapeHtml`/`toLatLng`/etc. into a `public/utils.js` and test it via `node:test` with a tiny DOM polyfill or just bare-function exports.
5. **Smoke-test target in `package.json`**: `"smoke": "node scripts/smoke.js"` that hits `/api/health` and asserts the security headers — what I did manually during this review.

---

## 5. Accessibility

### Strengths
- `lang="en"` on `<html>`.
- Live region for status: `<div id="sr-announcer" aria-live="assertive" aria-atomic="true">` ([public/index.html:138](public/index.html#L138)) — toasts feed it.
- `aria-busy` toggling on the loading section.
- `aria-label` on stop city/days inputs and remove buttons.
- `aria-hidden` on the reason modal until opened.
- `role="alert"` / `role="status"` distinction on toasts based on type.
- Semantic structure: `<nav>`, `<section>`, `<form>`, `<footer>`, single `<h1>`.
- Keyboard support in the reason modal (Enter to confirm, Escape to cancel).

### Issues — prioritized

#### High
- **Color contrast**: `--text-secondary: #a0a0c0` on `--bg-primary: #0a0a1a` is **~4.0:1** — below WCAG AA 4.5:1 for normal text. Used widely (form labels, hints, tips, activity meta). Lighten to `#b8b8d4` (~5.5:1).
- **Focus visibility**: no `:focus-visible` styles. Tab through the form and you can't see what's focused. Add:
  ```css
  :focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  button:focus-visible, .day-tab:focus-visible, .interest-chip:focus-visible span,
  .action-link:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  ```
- **Day tabs use `<button>` (good) but no `role="tablist"` / `role="tab"` / `aria-selected`** — screen readers announce them as plain buttons. Add ARIA tabs pattern, or accept that they're just buttons and remove the "tabs" mental model.

#### Medium
- **`tabindex` is missing on the reason modal** — when opened, focus is trapped only by `setTimeout(() => input.focus(), 10)`. Tab can escape to the page behind. Implement focus trap + restore-focus-on-close.
- **`alert()` for email success** ([public/script.js:997](public/script.js#L997)) bypasses the live region; screen readers may or may not announce native alerts depending on platform. Use `showToast` instead.
- **`prompt()` for email recipient** is keyboard-accessible but not styleable and not announced consistently.
- **`<button class="day-tab" onclick="...">` lacks `type="button"`** — inside a `<form>`, default button type is `submit`. These buttons are outside the form so it's safe, but still good practice.
- **Activity cards have `cursor: pointer` and a click handler** ([public/script.js:561-568](public/script.js#L561-L568)) but no keyboard equivalent. Add `tabindex="0"` + Enter/Space handler, or accept that the card is decorative and remove the cursor.
- **Map container has no fallback text** when Maps fails — currently shows the unavailable message visually but isn't announced.

#### Low
- **Emoji-only buttons** like `✖`, `↑`, `↓` rely on `aria-label`/`title` — most have it but the activity-card move buttons don't.
- **Form fields don't have explicit `autocomplete` attributes** — add `autocomplete="off"` for the AI prompt fields and appropriate values (`given-name`, etc.) where applicable.
- **No skip link** at the top of the page for keyboard users.
- **`prefers-reduced-motion` ignored** — orb animation, plane animation, and `fadeUp` keyframes all run regardless. Add a media query:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }
  }
  ```

---

## 6. Google Services

### Gemini (Generative AI)

#### Configuration
- Model: `gemini-2.5-flash-lite` ([server.js:262](server.js#L262)).
- Generation config: `temperature: 0.5`, `maxOutputTokens: 1400`, `responseMimeType: 'application/json'`.
- Timeout: 22 s (generate), 20–25 s (replan variants).
- Retry: 1 attempt by default ([server.js:511](server.js#L511)).

#### Strengths
- `responseMimeType: 'application/json'` is the right setting — pushes Gemini toward valid JSON.
- JSON repair fallback handles common truncation patterns.
- Hard constraints baked into the prompt for multi-city plans ("Return exactly N day objects", "Do not put X activities on Y day") — this is the right approach since Gemini Flash-Lite is small.

#### Gaps
1. **Model client is rebuilt per call** — see Efficiency #2.
2. **No exponential backoff between retries** — `generateWithRetry` retries immediately on failure ([server.js:511-536](server.js#L511-L536)). 429s and 503s should back off (e.g. 1s, 2s, 4s).
3. **Validation warnings are logged but never acted on** ([server.js:527](server.js#L527)) — schema is decorative. Either retry on schema failure with a "fix this JSON" prompt, or drop the validation.
4. **Prompts are inlined as `\n`-stuffed template literals** ([server.js:634](server.js#L634)) — hard to read and edit. Move to a dedicated `prompts/` directory or use multi-line template strings.
5. **No prompt versioning or AB hooks** — a hackathon-okay omission, but worth flagging if you ever want to compare prompt changes against quality metrics.
6. **No streaming** — the user waits 5–20 s with a fake "loading steps" animation. `model.generateContentStream()` would let you show partial results.

### Google Maps (JavaScript SDK)

#### Strengths
- Loaded dynamically with auth-failure callback (`gm_authFailure`) — gracefully degrades if key is misconfigured.
- DirectionsRenderer reused across renders.
- Transit fallback logic ([public/script.js:920-940](public/script.js#L920-L940)) handles the multi-waypoint limitation cleanly.

#### Gaps
1. **`google.maps.Marker` is deprecated** — Google now recommends `AdvancedMarkerElement`. Marker continues to work but will be sunset. The library `marker` is loaded ([public/script.js:418](public/script.js#L418)), so the migration is one-line.
2. **No `loading=async`** parameter on the Maps script — recommended by Google to avoid blocking page load.
3. **No `v=` parameter** — pins you to whichever version Google serves. Pin `v=quarterly` or `v=weekly` to control the upgrade cadence.
4. **API key restrictions** must be set in GCP console (referrer restriction, API restriction to Maps JavaScript only). The code can't enforce this; the doc should call it out as a deploy step.

### Places API (server-side)

`placesTextSearch` ([server.js:325-347](server.js#L325-L347)) uses Places API v1 with a precise field mask. Good — keeps cost low.

#### Gaps
1. **Sequential calls** — see Efficiency #1.
2. **No cache** — same `${location} ${destination}` query gets re-fetched every validate. Add a 1-hour cache keyed by the query string.
3. **No retry on 429** — single failed call kills the whole validation.
4. **Hard-coded `pageSize: 1`** — usually fine but if the AI gives a vague location ("downtown") the first result may not match the intent. Consider asking for `pageSize: 3` and ranking by distance to a reference point.
5. **Same Maps key used for client AND server** — restricting the key to referrers (for client) blocks the server, restricting to IPs (for server) blocks the browser. Use **two keys**: one referrer-restricted (Maps JS), one IP-restricted (Places + Routes).

### Routes API (server-side)

`computeRouteMinutes` ([server.js:349-374](server.js#L349-L374)) uses the v2 `:computeRoutes` endpoint with a tight field mask.

#### Gaps
1. **Sequential calls** — see Efficiency #1.
2. **Travel-mode validation is loose** — `safeTravelMode = sanitizeText(travelMode || 'DRIVE', 20).toUpperCase()` ([server.js:817](server.js#L817)) accepts any string. Should be an enum check (`['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'TWO_WHEELER']`).
3. **Distance never used in UI** — server returns `distanceMeters` but the frontend ignores it. Either show it in the activity card or stop fetching it.
4. **No traffic awareness** — Routes API supports `routingPreference: 'TRAFFIC_AWARE'` for driving — drops travel-time accuracy without it.

### Cost / quota guard rails (none currently)

- **No daily quota cap.** A bug or attacker could blow through your Gemini billing in minutes.
- **No per-user quota** — any one client can hit `/api/replan-*` 30 times/min indefinitely.
- **No metrics** — you can't tell from the code whether the cache is hitting, how often Places fails, or how long Gemini is taking.

#### Recommendation
Add a `/api/usage` debug endpoint (auth-gated) that exposes:
```json
{ "cacheHits": 142, "cacheMisses": 38, "geminiCalls": 38, "placesCalls": 1064, "routesCalls": 532, "p50LatencyMs": 4200 }
```
Or wire to OpenTelemetry / Cloud Trace.

---

## Top 10 fixes — ranked by impact ÷ effort

1. **Add auth + per-user rate limit** to non-`/api/health` POSTs. Stops public abuse.
2. **Parallelize Places/Routes calls** (`Promise.all` per day). 4× faster for typical itineraries.
3. **Memoize Gemini model + reuse SMTP transporter.** One-line change, real win.
4. **Bound the itinerary cache** (LRU 500). Prevents memory leak.
5. **Fix `--text-secondary` contrast.** A11y compliance win, one-line CSS.
6. **Add `:focus-visible` styles.** Keyboard usability win, ~5 lines CSS.
7. **Add `prefers-reduced-motion`.** A11y + power saving.
8. **Split Maps key into client (referrer-locked) + server (IP-locked).** Plugs key abuse.
9. **Replace `Marker` with `AdvancedMarkerElement`.** Future-proofing.
10. **Extract `server.js` into modules.** Pays dividends on every future change.

---

## What's safe to leave alone (for now)

- `lib/trip-planner-utils.js` — clean and tested.
- The CSP — appropriate trade-off given inline handlers; revisit when you remove them.
- The Gemini prompt structure — works well enough for the model's capability.
- The glassmorphism design system in `style.css` — consistent and pleasant.
- PM2 config — minimal and correct for a single-instance deploy.

---

*Review based on commit `415eb71` plus the security/SEO patches applied during the prior session. All recommendations preserve current behavior; none require breaking changes.*
