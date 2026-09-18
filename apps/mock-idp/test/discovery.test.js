import test from 'node:test';
import assert from 'node:assert/strict';
import { startIdp } from './helpers.js';

test('discovery document and JWKS', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());

  const res = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const doc = await res.json();
  assert.equal(doc.issuer, idp.issuer, 'issuer must equal MOCK_ISSUER byte for byte (openid-client, go-oidc)');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri', 'end_session_endpoint', 'introspection_endpoint', 'revocation_endpoint']) {
    assert.ok(doc[k].startsWith(idp.issuer), `${k} must start with the issuer (angular-oauth2-oidc strict validation)`);
  }
  assert.deepEqual(doc.id_token_signing_alg_values_supported, ['RS256']);
  assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(doc.response_types_supported, ['code']);
  assert.deepEqual(doc.subject_types_supported, ['public']);
  for (const m of ['client_secret_basic', 'client_secret_post', 'none']) assert.ok(doc.token_endpoint_auth_methods_supported.includes(m));
  assert.deepEqual(doc.introspection_endpoint_auth_methods_supported, doc.token_endpoint_auth_methods_supported, 'RFC 8414');
  assert.deepEqual(doc.revocation_endpoint_auth_methods_supported, doc.token_endpoint_auth_methods_supported, 'RFC 8414');
  for (const g of ['authorization_code', 'refresh_token', 'client_credentials', 'password']) assert.ok(doc.grant_types_supported.includes(g));
  assert.ok(doc.scopes_supported.includes('openid'));

  const jwksRes = await fetch(doc.jwks_uri);
  assert.equal(jwksRes.headers.get('access-control-allow-origin'), '*');
  const jwks = await jwksRes.json();
  assert.equal(jwks.keys.length, 1);
  const [jwk] = jwks.keys;
  assert.equal(jwk.kty, 'RSA');
  assert.equal(jwk.use, 'sig');
  assert.equal(jwk.alg, 'RS256');
  assert.equal(jwk.kid, idp.key.kid);
  for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(jwk[priv], undefined, 'private key material must never be published');
});

test('CORS preflight for the browser calls of the SPA', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const token = await fetch(`${idp.issuer}/token`, {
    method: 'OPTIONS',
    headers: { origin: 'http://angular.127.0.0.1.nip.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(token.status, 204);
  assert.equal(token.headers.get('access-control-allow-origin'), '*');
  assert.match(token.headers.get('access-control-allow-methods'), /POST/);
  assert.match(token.headers.get('access-control-allow-headers'), /content-type/i);

  const userinfo = await fetch(`${idp.issuer}/userinfo`, {
    method: 'OPTIONS',
    headers: { origin: 'http://angular.127.0.0.1.nip.io', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(userinfo.status, 204);
  assert.match(userinfo.headers.get('access-control-allow-headers'), /authorization/i);
});

test('health endpoints, dashboard and 404', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  assert.equal((await fetch(`${idp.issuer}/healthz`)).status, 200);
  const ready = await (await fetch(`${idp.issuer}/readyz`)).json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.kid, idp.key.kid);

  const home = await fetch(`${idp.issuer}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  for (const s of ['alice', 'bob', 'carol', 'angular-app', 'nextjs-app', 'cli', 'svc-batch', 'grant_type=password', 'grant_type=client_credentials',
    '/.well-known/openid-configuration', 'ROLES_CLAIM=roles', 'No SSO session']) {
    assert.ok(html.includes(s), `dashboard shows ${s}`);
  }

  const missing = await fetch(`${idp.issuer}/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not_found');
});

test('MOCK_ISSUER_CLAIM imitates the Oracle issuer mismatch', async (t) => {
  const idp = await startIdp({ MOCK_ISSUER_CLAIM: 'https://identity.oraclecloud.com/', MOCK_FLAVOR: 'oracle' });
  t.after(() => idp.stop());
  const doc = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(doc.issuer, 'https://identity.oraclecloud.com/');
  assert.ok(doc.token_endpoint.startsWith(idp.issuer), 'endpoints still live under MOCK_ISSUER');
});

test('users and clients files are validated at start', async () => {
  await assert.rejects(startIdp({ MOCK_USERS_FILE: '/nonexistent/users.json' }), /cannot read users/);
  await assert.rejects(startIdp({ MOCK_FLAVOR: 'okta' }), /MOCK_FLAVOR/);
});
