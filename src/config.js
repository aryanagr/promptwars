// Centralized env reading: alias resolution, _FILE secret-mount support,
// placeholder detection, and grouped config objects per service.

const fs = require('fs');

const isCloudRun = Boolean(process.env.K_SERVICE);

function readFromFileEnv(name) {
  const filePath = process.env[`${name}_FILE`];
  if (!filePath) return '';
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch { return ''; }
}

function envValue(...names) {
  for (const name of names) {
    const direct = (process.env[name] || '').trim();
    if (direct) return direct;
    const fromFile = readFromFileEnv(name);
    if (fromFile) return fromFile;
  }
  return '';
}

function isPlaceholderSecret(value) {
  const v = String(value || '').toLowerCase();
  if (!v) return true;
  return v.includes('replace_with') || v.includes('your_') || v.includes('password_here') ||
    v.includes('app_password_here') || v.includes('changeme');
}

function getGeminiApiKey() {
  return envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY');
}

function getMapsApiKey() {
  return envValue('GOOGLE_MAPS_API_KEY', 'MAPS_API_KEY');
}

function getMapsApiKeyClient() {
  return envValue('GOOGLE_MAPS_API_KEY_CLIENT', 'GOOGLE_MAPS_BROWSER_KEY') || getMapsApiKey();
}

function getMapsApiKeyServer() {
  return envValue('GOOGLE_MAPS_API_KEY_SERVER', 'GOOGLE_MAPS_BACKEND_KEY') || getMapsApiKey();
}

function getMailerConfig() {
  const host = envValue('SMTP_HOST', 'MAIL_HOST', 'EMAIL_HOST');
  const portRaw = envValue('SMTP_PORT', 'MAIL_PORT', 'EMAIL_PORT');
  const port = Number(portRaw || 587);
  const secureRaw = envValue('SMTP_SECURE', 'MAIL_SECURE', 'EMAIL_SECURE');
  const secure = secureRaw ? String(secureRaw).toLowerCase() === 'true' : port === 465;
  const user = envValue('SMTP_USER', 'SMTP_USERNAME', 'MAIL_USER', 'EMAIL_USER');
  const pass = envValue('SMTP_PASS', 'SMTP_PASSWORD', 'MAIL_PASS', 'EMAIL_PASS');
  const from = envValue('MAIL_FROM', 'SMTP_FROM', 'EMAIL_FROM') || user;
  return { host, port, secure, user, pass, from };
}

function hasValidGeminiKey() {
  const key = getGeminiApiKey();
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

function hasValidMapsKey() {
  return Boolean(getMapsApiKeyServer());
}

function hasValidMailerConfig() {
  const cfg = getMailerConfig();
  return Boolean(cfg.host && Number.isFinite(cfg.port) && cfg.port > 0 && cfg.user && cfg.pass && cfg.from && !isPlaceholderSecret(cfg.pass));
}

function missingMailerFields() {
  const cfg = getMailerConfig();
  const missing = [];
  if (!cfg.host) missing.push('SMTP_HOST');
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) missing.push('SMTP_PORT');
  if (!cfg.user) missing.push('SMTP_USER');
  if (!cfg.pass || isPlaceholderSecret(cfg.pass)) missing.push('SMTP_PASS');
  if (!cfg.from) missing.push('MAIL_FROM');
  return missing;
}

function getAllowedOrigins() {
  const raw = envValue('CORS_ORIGINS', 'CORS_ORIGIN');
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const GEMINI_TIMEOUT_MS = {
  generate: Number(envValue('GEMINI_GENERATE_TIMEOUT_MS') || 50000),
  replanActivity: Number(envValue('GEMINI_REPLAN_ACTIVITY_TIMEOUT_MS') || 30000),
  replanDay: Number(envValue('GEMINI_REPLAN_DAY_TIMEOUT_MS') || 45000),
  replanSegment: Number(envValue('GEMINI_REPLAN_SEGMENT_TIMEOUT_MS') || 45000)
};

module.exports = {
  isCloudRun,
  envValue,
  isPlaceholderSecret,
  getGeminiApiKey,
  getMapsApiKey,
  getMapsApiKeyClient,
  getMapsApiKeyServer,
  getMailerConfig,
  hasValidGeminiKey,
  hasValidMapsKey,
  hasValidMailerConfig,
  missingMailerFields,
  getAllowedOrigins,
  GEMINI_TIMEOUT_MS
};
