// CSP, security headers, and the same-origin guard middleware.

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com https://www.googletagmanager.com https://www.google-analytics.com https://accounts.google.com https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com https://www.google-analytics.com https://www.googletagmanager.com https://lh3.googleusercontent.com",
  "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://places.googleapis.com https://routes.googleapis.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://accounts.google.com https://oauth2.googleapis.com",
  "frame-src 'self' https://www.google.com https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  const forwardedProto = req.headers['x-forwarded-proto'];
  const isHttps = req.secure || String(forwardedProto || '').includes('https');
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Reject POSTs whose Origin/Referer doesn't match allowedOrigins or req host.
function buildOriginGuard({ allowedOrigins, enabled }) {
  return function originGuard(req, res, next) {
    if (!enabled) return next();
    const host = req.get('host');
    const origin = req.get('origin');
    let candidate = origin;
    if (!candidate) {
      const referer = req.get('referer');
      if (referer) {
        try { candidate = new URL(referer).origin; } catch { candidate = null; }
      }
    }
    if (!candidate) return res.status(403).json({ success: false, error: 'Origin header required for this endpoint.' });
    const expected = new Set(allowedOrigins);
    if (host) {
      expected.add(`http://${host}`);
      expected.add(`https://${host}`);
    }
    if (!expected.has(candidate)) return res.status(403).json({ success: false, error: 'Origin not allowed.' });
    next();
  };
}

module.exports = { CSP_DIRECTIVES, securityHeaders, buildOriginGuard };
