// Shared test helpers: start an IdP on a free port and drive the endpoints like a browser/client would.
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer } from '../src/server.js';

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Starts a mock IdP; MOCK_ISSUER points at itself so discovery is self-consistent. */
export async function startIdp(env = {}) {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const idp = await createServer({ MOCK_ISSUER: issuer, LOG_LEVEL: 'warn', ...env });
  const server = await idp.listen(port);
  return { ...idp, issuer, stop: () => { idp.close(); return new Promise((resolve) => server.close(resolve)); } };
}

export const form = (fields) => new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined));

export async function postForm(url, fields, headers = {}) {
  const res = await fetch(url, { method: 'POST', body: form(fields), headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
export const decodeHeader = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString());
/** Independent at_hash oracle: WebCrypto SHA-256 (as angular-oauth2-oidc computes it), not the server's node:crypto code. */
export async function atHash(token) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest.slice(0, 16)).toString('base64url');
}

export async function getAuthorize(issuer, params, cookie) {
  const res = await fetch(`${issuer}/authorize?${form(params)}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: res.status, location: res.headers.get('location'), html: res.status === 200 ? await res.text() : '' };
}

/** Submits the login form (hidden authorization params + credentials) like a browser would. */
export async function postAuthorize(issuer, params, fields, cookie) {
  const res = await fetch(`${issuer}/authorize`, { method: 'POST', redirect: 'manual', body: form({ ...params, ...fields }), headers: cookie ? { cookie } : {} });
  const location = res.headers.get('location');
  return {
    status: res.status,
    location,
    query: location ? Object.fromEntries(new URL(location).searchParams) : {},
    cookie: res.headers.get('set-cookie')?.split(';')[0],
    html: res.status !== 302 ? await res.text() : '',
  };
}

/** A typical angular-oauth2-oidc authorization request for the public angular-app client. */
export const codeFlowParams = (challenge, extra = {}) => ({
  client_id: 'angular-app',
  redirect_uri: 'http://angular.127.0.0.1.nip.io/callback',
  response_type: 'code',
  scope: 'openid profile email',
  state: 'xyz',
  nonce: 'n-0S6_WzA2Mj',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...extra,
});
