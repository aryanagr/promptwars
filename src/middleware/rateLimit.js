// In-memory per-IP+path rate limiter. Single-instance only — for horizontal
// scaling, swap to Redis with the same Map-like contract.

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: 'Too many requests. Please slow down and retry shortly.' });
    }
    if (buckets.size > 5000) {
      for (const [k, v] of buckets.entries()) if (now >= v.resetAt) buckets.delete(k);
    }
    return next();
  };
}

module.exports = { createRateLimiter };
