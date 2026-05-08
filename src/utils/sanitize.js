// Input sanitizers — strip control chars, collapse whitespace, cap length.

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function sanitizeText(value, maxLen = 160) {
  return String(value || "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function sanitizeInterests(value) {
  return sanitizeText(value, 300);
}

module.exports = { sanitizeText, sanitizeInterests };
