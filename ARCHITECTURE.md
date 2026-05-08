# TravelAI — Architecture

Technical reference for the codebase. For setup see [README.md](README.md); for the code-quality audit see [REVIEW.md](REVIEW.md).

## Folder structure

```
promptwar/
├── server.js                        # Express app: routes, middleware, Gemini/Maps/SMTP clients
├── lib/
│   └── trip-planner-utils.js        # Pure helpers for multi-city day allocation
├── public/                          # Static frontend (no bundler)
│   ├── index.html                   # Single-page UI shell
│   ├── style.css                    # Glassmorphism design system
│   ├── script.js                    # Form, API calls, map rendering, replan flow
│   ├── robots.txt
│   └── sitemap.xml
├── tests/
│   ├── trip-planner-utils.test.js   # Pure-function tests
│   └── server-routes.test.js        # Endpoint validation tests (no Gemini/Maps/SMTP)
├── ecosystem.config.cjs             # PM2 process config
├── package.json
├── README.md                        # Setup & usage
├── REVIEW.md                        # Audit notes
└── ARCHITECTURE.md                  # This file
```

## Request flow

```
Browser (index.html + script.js)
        │
        │  fetch('/api/...', { headers: { Origin: <same-origin> } })
        ▼
Express middleware chain
  ├─ cors           → block cross-origin unless in CORS_ORIGINS
  ├─ express.json   → parse body (250 KB cap)
  ├─ securityHeadersMiddleware → CSP, HSTS, X-Frame, etc.
  └─ originGuard (POST only) → reject if Origin/Referer doesn't match host
        │
        ▼
writeApiLimiter (per IP+path, in-memory) → 429 if over 30/min
        │
        ▼
Route handler
  ├─ sanitizeText / sanitizeStops / sanitizeInterests   (input validation)
  ├─ buildItineraryCacheKey + getCachedItinerary        (skip AI if cached)
  ├─ Gemini  → generateWithRetry → cleanAndParseJSON    (3-stage parse)
  ├─ Google Maps Places / Routes (server-side key)
  └─ Nodemailer → SMTP transport
        │
        ▼
JSON response: { success, itinerary?, error? }
        │
        ▼
Frontend: renderResults → day tabs, activity cards, map markers, route polyline
```

## Endpoint reference

| Method | Path | Purpose | Inputs | Notable behavior |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | Service status | — | Returns config flags (`geminiConfigured`, `mapsConfigured`, `mailerConfigured`, etc.). |
| GET | `/api/maps-key` | Frontend Maps SDK key | — | Returns the **client** key (referrer-restricted). |
| POST | `/api/generate-itinerary` | Main itinerary generation | trip params + stops | SHA256-cached for `ITINERARY_CACHE_TTL_MS`. |
| POST | `/api/replan-activity` | Replace one activity | itinerary, dayIndex, activityIndex, reason | Returns mutated itinerary. |
| POST | `/api/replan-day` | Regenerate full day | itinerary, dayIndex, reason | Preserves date, day number, city. |
| POST | `/api/replan-segment` | Regenerate contiguous slice | itinerary, dayIndex, start/end indexes | Maintains segment size and budget. |
| POST | `/api/validate-places` | Resolve activities to Places API | itinerary, destination | Sequential calls (caps at 120 activities). |
| POST | `/api/compute-routes` | Travel time/distance between activities | itinerary, travelMode | Sequential calls (caps at 150 activities). |
| POST | `/api/apply-constraints` | Check budget/category/timing | itinerary, constraints | Returns findings array; doesn't modify itinerary. |
| POST | `/api/email-itinerary` | Send via SMTP | toEmail, itinerary | Requires full SMTP_* env config. |

All POST endpoints share: `originGuard` → `writeApiLimiter` → handler.

## Itinerary shape

```json
{
  "tripTitle": "string",
  "summary": "string",
  "totalEstimatedCost": 0,
  "currency": "USD",
  "tips": ["string", ...],
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "city": "string",
      "theme": "string",
      "activities": [
        {
          "time": "09:00 AM",
          "title": "string",
          "description": "string",
          "location": "string",
          "lat": 0.0,
          "lng": 0.0,
          "duration": "60 mins",
          "estimatedCost": 0,
          "category": "sightseeing | food | adventure | culture | shopping | transport | relaxation",
          "bookingLinks": { "googleMaps": "...", "googleSearch": "...", "mapsDirection": "..." },
          "discarded": false
        }
      ]
    }
  ]
}
```

`enrichWithBookingLinks()` adds `bookingLinks` after Gemini returns. The frontend may add `discarded: true` to any activity (kept-but-hidden). `validate-places` adds `placeId`, `verified`, `openNow`, `rating`, `mapsUri`. `compute-routes` adds `travelFromPrevious: { travelMinutes, distanceMeters }` to each non-first activity.

## Configuration (env vars)

### Required
| Var | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini access. Aliases: `GOOGLE_API_KEY`, `GEMINI_KEY`. Cloud Run: `<NAME>_FILE` for secret mount. |
| `GOOGLE_MAPS_API_KEY` | Single-key fallback. See split-key vars below to harden. |

### Maps key split (recommended for prod)
| Var | Restrict to | Used by |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY_CLIENT` | HTTP referrer = your domain | Browser (Maps JS SDK) |
| `GOOGLE_MAPS_API_KEY_SERVER` | Server IP allowlist | Places + Routes APIs |

### SMTP (optional — disables `/api/email-itinerary` if unset)
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Aliases: `MAIL_*`, `EMAIL_*`. `SMTP_SECURE=true` forces TLS (defaults to true on port 465).

### Hardening / tuning
| Var | Default | Purpose |
| --- | --- | --- |
| `CORS_ORIGINS` | (none) | Comma-separated cross-origin allowlist. Empty = same-origin only. |
| `ORIGIN_GUARD` | on | Set `off` to disable Origin/Referer enforcement (dev/curl). |
| `TRUST_PROXY_HOPS` | 1 | Number of upstream proxies trusted for `req.ip`. |
| `EXPOSE_ERROR_DETAILS` | false | Echo provider error messages to clients (debug only). |
| `API_RATE_LIMIT_WINDOW_MS` | 60000 | Rate-limit window. |
| `API_RATE_LIMIT_MAX` | 30 | Requests per window per IP+path. |
| `ITINERARY_CACHE_TTL_MS` | 180000 | Cache TTL. |
| `ITINERARY_CACHE_MAX_ENTRIES` | 500 | Hard cap; LRU eviction by insertion order. |
| `JSON_BODY_LIMIT` | 250kb | Max request body. |
| `GEMINI_GENERATE_TIMEOUT_MS` | 50000 | Per-request Gemini timeout. |
| `GEMINI_REPLAN_ACTIVITY_TIMEOUT_MS` | 30000 | |
| `GEMINI_REPLAN_DAY_TIMEOUT_MS` | 45000 | |
| `GEMINI_REPLAN_SEGMENT_TIMEOUT_MS` | 45000 | |

## Security model

Layered defense, no single hard gate:

1. **CSP** ([server.js](server.js) `CSP_DIRECTIVES`) — restricts script/style/connect origins, denies framing, forbids `<object>`. `'unsafe-inline'` is allowed for scripts/styles because the templates use inline `onclick=` and inline `style=`; tightening requires moving to event delegation.
2. **CORS** — same-origin by default. Cross-origin browsers blocked unless listed in `CORS_ORIGINS`.
3. **Origin guard** — POST endpoints require an Origin/Referer that matches the request's own host or `CORS_ORIGINS`. Stops casual cross-origin abuse from arbitrary scripts.
4. **Rate limit** — 30 req/min per IP+path (in-memory; per-instance).
5. **Input sanitization** — `sanitizeText`, `sanitizeStops`, `sanitizeInterests` strip control chars and cap length on every user input.
6. **Output escaping** — all AI/user data passed to `innerHTML` or to email HTML goes through `escapeHtml`/`safeUrl` to prevent XSS and HTML injection.
7. **Generic errors** — provider error messages logged server-side, only the fallback message returned to clients (toggle with `EXPOSE_ERROR_DETAILS`).
8. **Lat/lng range checks** — itinerary validator rejects coordinates outside [-90,90]/[-180,180] (and now correctly accepts 0).

What's *not* there: real authentication. Anyone who can send an Origin matching your host can call any endpoint. For untrusted public traffic, add Turnstile/reCAPTCHA on `/api/email-itinerary` and `/api/generate-itinerary`.

## Caching strategy

| Cache | Where | Key | TTL | Cap |
| --- | --- | --- | --- | --- |
| Itinerary | `itineraryCache: Map` in server.js | SHA256 of normalized payload | 180 s | 500 entries (LRU) |
| Rate-limit buckets | `buckets: Map` in `createRateLimiter` | `${ip}:${path}` | window-based | 5000-bucket sweep on overflow |

Both are in-memory and per-instance — fine on a single Cloud Run container, not safe across horizontal autoscaling. Replace with Redis when you need shared state.

`buildItineraryCacheKey` normalizes input (lowercased cities, sorted stops, etc.) so semantically-equivalent payloads share a cache entry.

## Gemini integration

- **Model**: `gemini-2.5-flash-lite` ([server.js](server.js) `getModel`).
- **Generation config**: `temperature 0.5`, `maxOutputTokens 4096`, `responseMimeType: 'application/json'`.
- **Timeouts**: see env table above. All wrapped in `withTimeout(promise, ms, message)`.
- **Retry**: `generateWithRetry(prompt, maxRetries = 1)` — one retry on any failure, no backoff (TODO: exponential).
- **JSON parse pipeline** (`cleanAndParseJSON`):
  1. Strip code fences, slice to outermost `{...}`.
  2. `JSON.parse` (vanilla path).
  3. Append closing brackets/quotes if truncated (`tryCloseTruncatedJson`).
  4. Last resort: `jsonrepair` package — handles trailing commas, missing commas, smart quotes, unquoted keys.
  5. If all fail: log preview server-side, throw generic error to client.
- **Schema validation** (`validateItinerary`): warns but doesn't reject. Treat output as untrusted.

## Google Maps integration

| API | Client key | Server key | Used in | Field mask |
| --- | --- | --- | --- | --- |
| Maps JavaScript | ✓ | — | Browser SDK loaded from `maps.googleapis.com` | — |
| Places API v1 | — | ✓ | `placesTextSearch` | id, displayName, formattedAddress, location, rating, userRatingCount, googleMapsUri, regularOpeningHours.openNow |
| Routes API v2 | — | ✓ | `computeRouteMinutes` | duration, distanceMeters |

The frontend route drawer (`startRoute`) uses Directions Service via the loaded SDK and falls back to driving when transit is requested with multi-waypoint itineraries (Directions Service limitation).

## SMTP integration

- Built lazily per request via `nodemailer.createTransport`.
- Email body assembled by `itineraryToEmailHtml` — every interpolation goes through `escapeHtml`.
- Subject and plain-text fallback go through `sanitizeText` to strip control chars (header injection guard).
- Email button is auto-disabled in the UI if `/api/health` reports `mailerConfigured: false`.

## Frontend state

`script.js` keeps state in module-scope `let`s — no framework. Key globals:

| State | Purpose |
| --- | --- |
| `gMap`, `directionsService`, `directionsRenderer` | Google Maps SDK objects |
| `markers: Marker[]` | Currently-rendered map pins |
| `itineraryData: object \| null` | Source of truth for the active trip |
| `currentDayIndex: number` | Selected day tab |
| `mapsReady: boolean` | SDK loaded successfully |
| `dayActivityPage: { [dayIdx]: number }` | Per-day pagination cursor |
| `replanInFlight`, `routeInFlight: boolean` | Mutex flags to disable concurrent ops |
| `userPreferences: object` | From/To/transport selections |

All DOM mutations rebuild from `itineraryData` rather than patching individual elements.

## Adding a new route

1. Place the handler in `server.js` near the existing routes (after `// === Routes ===` banner).
2. Wire the standard middleware: `originGuard` and `writeApiLimiter` for POSTs.
3. Validate inputs at the top: use `sanitizeText`, `sanitizeStops`, etc., return early with `400` and `{ success: false, error }`.
4. Catch errors with `formatApiError(err, 'Failed to ...')` so provider details get logged but not leaked.
5. Add a validation test in `tests/server-routes.test.js` — bad input → 400 with expected error shape.

## Deployment notes

- **PM2** ([ecosystem.config.cjs](ecosystem.config.cjs)) — fork mode, single instance, auto-restart up to 20 times.
- **Cloud Run** — set `K_SERVICE` (auto-set), use `<NAME>_FILE` env vars for mounted secrets, set `TRUST_PROXY_HOPS=1` for the Cloud Run proxy.
- **Restarts** — local: `npx pm2 restart promptwar`; prod: deploy your usual way.
- **Static asset cache** — JS/CSS currently served `Cache-Control: no-store` to avoid stale clients. The HTML uses `?v=...` query strings for cache busting.

## Test strategy

- `npm test` runs Node's built-in `node:test` against everything in `tests/*.test.js`.
- **Pure tests** (`trip-planner-utils.test.js`): no I/O, fast.
- **Route tests** (`server-routes.test.js`): boots the app on port 0 (random), disables origin guard via env, hits validation paths only — no Gemini/Maps/SMTP calls.
- Coverage gaps: full happy-path Gemini calls, Places/Routes, SMTP send. Mock these with a fixture-recorder if you need integration coverage.

## Known limitations / future work

See [REVIEW.md](REVIEW.md) for the prioritized list. Highlights:

- Per-IP rate limiter doesn't survive horizontal scaling.
- Sequential Places/Routes calls — should batch with `Promise.all` per day (≈4× faster).
- `Marker` is deprecated by Google in favor of `AdvancedMarkerElement`.
- No real auth on POSTs — origin guard is defense-in-depth, not a hard gate.
- `validateItinerary` warns rather than rejects.
- Inline `onclick=` handlers force `'unsafe-inline'` in CSP.
