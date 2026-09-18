// Protocol helpers: at_hash, PKCE, redirect URI matching, client authentication and token minting.
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { accessTokenClaims, idTokenClaims } from './flavors.js';
import { nowSeconds, randomToken, safeEqual, splitScope } from './util.js';

/** OIDC Core 3.1.3.6: for RS256, base64url of the left-most 128 bits of SHA-256(access_token). */
export function atHash(accessToken) {
  return createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url');
}

/** RFC 7636 S256: code_challenge = base64url(SHA-256(code_verifier)). */
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false; // RFC 7636 4.1
  return safeEqual(pkceChallenge(verifier), challenge);
}

export const isPublicClient = (client) => !client.client_secret;
export const clientAllows = (client, grant) => client.grant_types.includes(grant);

/** Exact match, or prefix match when the registered pattern ends with `*` (Keycloak style). */
export function redirectUriAllowed(patterns, uri, allowAny = false) {
  if (typeof uri !== 'string' || !/^https?:\/\/[^\s]+$/i.test(uri)) return false; // never redirect to javascript:, data:, ...
  if (allowAny) return true;
  return (patterns ?? []).some((p) => (p.endsWith('*') ? uri.startsWith(p.slice(0, -1)) : uri === p));
}

/**
 * RFC 6749 2.3.1: client_secret_basic (Authorization: Basic) or client_secret_post (body fields).
 * Public clients only send client_id. Returns { client } or { error, description, viaHeader }.
 */
export function authenticateClient(req, clients) {
  const body = req.body ?? {};
  let id = body.client_id;
  let secret = body.client_secret;
  let viaHeader = false;

  const header = req.headers.authorization ?? '';
  if (/^basic /i.test(header)) {
    viaHeader = true;
    const [rawId = '', ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } }; // RFC 6749: form-url-encoded
    const headerId = decode(rawId);
    if (id && id !== headerId) return { error: 'invalid_client', description: 'client_id in body and Authorization header differ', viaHeader };
    id = headerId;
    secret = decode(rest.join(':'));
  }

  const client = clients.find((c) => c.client_id === id);
  if (!client) return { error: 'invalid_client', description: 'unknown client_id', viaHeader };
  if (!isPublicClient(client) && !safeEqual(client.client_secret, secret)) {
    return { error: 'invalid_client', description: 'invalid client_secret', viaHeader };
  }
  return { client, viaHeader };
}

/**
 * Mints the token response for any grant. `user` undefined means client_credentials.
 * The refresh token is an opaque random string stored server-side (never a JWT).
 */
export async function issueTokens({ config, key, client, user, scope, nonce, authTime, sid, stores, includeRefresh }) {
  const now = nowSeconds();
  const scopes = splitScope(scope);
  const grantedScope = scopes.join(' ') || undefined;
  const sign = (payload) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: key.kid }).sign(key.privateKey);

  const access_token = await sign(accessTokenClaims({ flavor: config.flavor, config, client, user, scope: grantedScope, sid, now }));
  const response = { access_token, token_type: 'Bearer', expires_in: config.ttl.access, scope: grantedScope };

  if (user && scopes.includes('openid')) {
    response.id_token = await sign(idTokenClaims({
      flavor: config.flavor, config, client, user, nonce, authTime, sid, now, atHash: atHash(access_token),
    }));
  }
  if (includeRefresh) {
    const refresh_token = randomToken(48);
    stores.refreshTokens.set(refresh_token, {
      client_id: client.client_id, username: user?.username, scope: grantedScope, nonce, auth_time: authTime, sid,
    }, config.ttl.refresh);
    Object.assign(response, { refresh_token, refresh_expires_in: config.ttl.refresh });
  }
  return response;
}
