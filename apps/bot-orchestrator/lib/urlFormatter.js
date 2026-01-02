// filepath: /root/bot-manager/lib/urlFormatter.js
const { URL } = require('url');

/**
 * Transform a raw Turso URL into a SQLAlchemy-compatible URL with credentials
 * Ensures 'user:password@host:port/dbName' format to satisfy parse_db_uri_for_logging
 */
function formatDbUrl(rawUrl, dbName) {
  if (!rawUrl) {
    throw new Error('Empty Turso URL');
  }
  let urlStr = rawUrl.trim();

  // Add default libsql:// prefix if missing
  if (!urlStr.startsWith('libsql://') && !urlStr.startsWith('sqlite+libsql://')) {
    urlStr = `libsql://${urlStr}`;
  }
  // Normalize to sqlite+libsql://
  urlStr = urlStr.replace(/^libsql:\/\//, 'sqlite+libsql://');

  // Ensure the database name path exists
  const stripped = urlStr.replace('sqlite+libsql://', '');
  if (!stripped.includes('/')) {
    urlStr = `${urlStr}/${dbName}`;
  }

  // Build final URL using libsql dialect: libsql://:<token>@host:port/db
  const parsed = new URL(urlStr);
  const token = process.env.TURSO_API_KEY || parsed.username;
  if (!token) {
    throw new Error('Missing Turso token');
  }
  const host = parsed.hostname;
  const port = parsed.port || '443';
  const db = parsed.pathname.replace(/^\//, '') || dbName;
  // Construct inner libsql URL and embed via URL param for SQLAlchemy HTTP transport
  const innerUrl = `libsql://:${token}@${host}:${port}/${db}`;
  const encoded = encodeURIComponent(innerUrl);
  return `sqlite+libsql:///?url=${encoded}&timeout=30`;
}

module.exports = { formatDbUrl };