// Minimal signed-cookie support for the SSO session (no external dependency).
import { createHmac } from 'node:crypto';
import { safeEqual } from './util.js';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

const mac = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

/** value = base64url(JSON) + "." + HMAC-SHA256(value): readable by the browser, but not forgeable. */
export function signValue(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${mac(data, secret)}`;
}

export function verifyValue(value, secret) {
  const i = (value ?? '').lastIndexOf('.');
  if (i < 1) return null;
  const data = value.slice(0, i);
  if (!safeEqual(mac(data, secret), value.slice(i + 1))) return null; // tampered or signed with another secret
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
}

export function serializeCookie(name, value, { maxAge, secure = false, path = '/', sameSite = 'Lax' } = {}) {
  // HttpOnly: no script access. SameSite=Lax: still sent on the top-level redirect from the app to /authorize.
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}`;
  if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
  if (secure) cookie += '; Secure';
  return cookie;
}
