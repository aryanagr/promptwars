// Structured logger — emits Cloud Logging-format JSON to stdout/stderr so it
// is auto-ingested with severity levels when running on Google Cloud Run.

const log = {
  info: (msg, meta = {}) => console.log(JSON.stringify({ severity: 'INFO', message: msg, ...meta })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ severity: 'WARNING', message: msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ severity: 'ERROR', message: msg, ...meta }))
};

module.exports = { log };
