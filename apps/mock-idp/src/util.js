// Small shared helpers: time, random tokens, constant-time compare, HTML escaping, JSON logging.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const splitScope = (value) => [...new Set(String(value ?? '').split(/\s+/).filter(Boolean))];

/** Constant-time comparison for secrets, PKCE challenges and cookie signatures. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Deterministic UUID-shaped identifier (stable `sub`/`oid`/`tid` for clients and tenants). */
export function stableUuid(name) {
  const h = createHash('sha256').update(`mock-idp:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** HTML-escapes everything that came from a request before it is rendered. */
export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
export const setLogLevel = (level) => { threshold = LEVELS[level] ?? LEVELS.info; };

/** One JSON object per line: info/debug to stdout, warn/error to stderr. */
export function log(level, fields) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const line = `${JSON.stringify({ time: new Date().toISOString(), level, ...fields })}\n`;
  if (level === 'warn' || level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}
