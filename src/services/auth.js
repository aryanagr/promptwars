// Google OAuth ID-token verification (server-side check via tokeninfo endpoint).

const { log } = require('../utils/log');

// Returns { email, name, sub } on success, or null on failure.
async function verifyGoogleIdToken(idToken, expectedAud) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) return null;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (expectedAud && data.aud !== expectedAud) return null;
    if (!data.email_verified) return null;
    return { email: data.email, name: data.name, sub: data.sub };
  } catch (err) {
    log.warn('verifyGoogleIdToken failed', { error: err?.message });
    return null;
  }
}

module.exports = { verifyGoogleIdToken };
