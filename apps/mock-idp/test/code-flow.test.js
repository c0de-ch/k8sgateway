import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { atHash as serverAtHash } from '../src/oidc.js';
import { atHash, codeFlowParams, decode, getAuthorize, pkce, postAuthorize, postForm, startIdp } from './helpers.js';

test('authorization code flow with PKCE (as angular-oauth2-oidc runs it)', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const { verifier, challenge } = pkce();
  const params = codeFlowParams(challenge);
  const exchange = (code, code_verifier) => postForm(`${idp.issuer}/token`, {
    grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: 'angular-app', code_verifier,
  });

  await t.test('GET /authorize without a session renders the login page', async () => {
    const page = await getAuthorize(idp.issuer, params);
    assert.equal(page.status, 200);
    for (const s of ['angular-app', 'openid', 'profile', 'name="user" value="alice"', 'name="user" value="bob"', 'name="user" value="carol"', 'name="password"', 'Generic OIDC']) {
      assert.ok(page.html.includes(s), `login page contains ${s}`);
    }
  });

  await t.test('wrong password re-renders the form with an error and no code', async () => {
    const r = await postAuthorize(idp.issuer, params, { username: 'alice', password: 'nope' });
    assert.equal(r.status, 401);
    assert.match(r.html, /Wrong username or password/);
    assert.equal(r.cookie, undefined);
  });

  let cookie;
  await t.test('correct password redirects with code + state, sets the SSO cookie; a bad verifier burns the code', async () => {
    const r = await postAuthorize(idp.issuer, params, { username: 'alice', password: 'alice' });
    assert.equal(r.status, 302);
    assert.ok(r.location.startsWith(`${params.redirect_uri}?`));
    assert.equal(r.query.state, 'xyz');
    assert.ok(r.query.code);
    assert.match(r.cookie, /^mock_idp_session=/);
    cookie = r.cookie;

    const bad = await exchange(r.query.code, 'x'.repeat(43));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_grant');
    const replay = await exchange(r.query.code, verifier);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, 'invalid_grant', 'codes are single use');
  });

  let tokens;
  await t.test('SSO: a second /authorize with the cookie issues a code without a login page', async () => {
    const r = await getAuthorize(idp.issuer, params, cookie);
    assert.equal(r.status, 302);
    const code = new URL(r.location).searchParams.get('code');
    const missingVerifier = await postForm(`${idp.issuer}/token`, { grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: 'angular-app' });
    assert.equal(missingVerifier.body.error, 'invalid_request');

    const again = await getAuthorize(idp.issuer, params, cookie);
    const res = await exchange(new URL(again.location).searchParams.get('code'), verifier);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    tokens = res.body;
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(typeof tokens.expires_in, 'number');
    assert.equal(tokens.scope, params.scope);
    assert.ok(tokens.refresh_token, 'refresh token issued even without offline_access (SPEC A15)');
  });

  await t.test('ID token: nonce, aud = client_id, iss, correct at_hash', async () => {
    // Known vector from OpenID Connect Core 1.0 Appendix A.3 pins the server's formula; the live token is
    // then checked against the WebCrypto oracle in helpers.js (a different implementation than the server's).
    assert.equal(serverAtHash('jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y'), '77QmUPtjPfzWtF2AnpK9RQ');
    const id = decode(tokens.id_token);
    assert.equal(id.nonce, params.nonce);
    assert.equal(id.aud, 'angular-app');
    assert.equal(id.azp, 'angular-app');
    assert.equal(id.iss, idp.issuer);
    assert.equal(id.at_hash, await atHash(tokens.access_token));
    assert.equal(typeof id.auth_time, 'number');
    assert.equal(id.preferred_username, 'alice');
    assert.deepEqual(id.roles, ['admin', 'user']);
  });

  await t.test('access token verifies against /jwks with jose and carries both roles for alice', async () => {
    const jwks = createRemoteJWKSet(new URL(`${idp.issuer}/jwks`));
    const { payload, protectedHeader } = await jwtVerify(tokens.access_token, jwks, { issuer: idp.issuer, audience: 'k8sgateway-api' });
    assert.deepEqual(protectedHeader, { alg: 'RS256', typ: 'JWT', kid: idp.key.kid });
    assert.deepEqual(payload.roles, ['admin', 'user']);
    assert.equal(payload.azp, 'angular-app');
    assert.equal(payload.preferred_username, 'alice');
    assert.equal(payload.sub, decode(tokens.id_token).sub, 'access and ID token share the subject');
  });

  await t.test('userinfo returns the same sub as the ID token', async () => {
    const res = await fetch(`${idp.issuer}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.sub, decode(tokens.id_token).sub);
    assert.equal(info.email, 'alice@example.com');
    assert.deepEqual(info.roles, ['admin', 'user']);
  });

  await t.test('refresh keeps the nonce and rotates the refresh token', async () => {
    const res = await postForm(`${idp.issuer}/token`, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'angular-app' });
    assert.equal(res.status, 200);
    assert.equal(decode(res.body.id_token).nonce, params.nonce);
    assert.notEqual(res.body.refresh_token, tokens.refresh_token);
    tokens = res.body;
  });

  await t.test('prompt=login, prompt=none and login_hint', async () => {
    assert.equal((await getAuthorize(idp.issuer, { ...params, prompt: 'login' }, cookie)).status, 200, 'prompt=login always shows the form');
    const none = await getAuthorize(idp.issuer, { ...params, prompt: 'none' });
    assert.equal(none.status, 302);
    assert.equal(new URL(none.location).searchParams.get('error'), 'login_required');
    assert.equal(new URL(none.location).searchParams.get('state'), 'xyz');
    const noneSso = await getAuthorize(idp.issuer, { ...params, prompt: 'none' }, cookie);
    assert.ok(new URL(noneSso.location).searchParams.get('code'), 'prompt=none with a session issues a code silently');
    const hint = await getAuthorize(idp.issuer, { ...params, prompt: 'login', login_hint: 'bob' }, cookie);
    assert.match(hint.html, /value="bob"/);
    const stale = await getAuthorize(idp.issuer, { ...params, max_age: '0' }, cookie);
    assert.equal(stale.status, 200, 'max_age=0 forces re-authentication');
  });

  await t.test('logout clears the session, revokes its refresh tokens and redirects with state', async () => {
    const q = new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: 'http://angular.127.0.0.1.nip.io/', state: 's1' });
    const res = await fetch(`${idp.issuer}/logout?${q}`, { redirect: 'manual', headers: { cookie } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://angular.127.0.0.1.nip.io/?state=s1');
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await getAuthorize(idp.issuer, params, cookie)).status, 200, 'the old cookie no longer logs in');
    const refresh = await postForm(`${idp.issuer}/token`, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'angular-app' });
    assert.equal(refresh.body.error, 'invalid_grant');
  });
});

test('authorization request validation', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const { challenge } = pkce();
  const errorOf = async (params) => new URL((await getAuthorize(idp.issuer, params)).location).searchParams.get('error');

  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { client_id: 'ghost' }))).status, 400, 'unknown client: shown, not redirected');
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { redirect_uri: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { redirect_uri: undefined }))).status, 400);
  assert.equal(await errorOf(codeFlowParams(challenge, { response_type: 'token' })), 'unsupported_response_type');
  assert.equal(await errorOf(codeFlowParams(undefined)), 'invalid_request', 'PKCE is mandatory for public clients');
  assert.equal(await errorOf(codeFlowParams(challenge, { code_challenge_method: 'plain' })), 'invalid_request');
  assert.equal(await errorOf(codeFlowParams(challenge, { code_challenge_method: undefined })), 'invalid_request');
  assert.equal(await errorOf(codeFlowParams(challenge, { client_id: 'svc-batch' })), 'unauthorized_client');
  assert.equal(await errorOf(codeFlowParams(challenge, { response_mode: 'form_post' })), 'invalid_request');

  const cancel = await postAuthorize(idp.issuer, codeFlowParams(challenge), { cancel: '1' });
  assert.equal(cancel.query.error, 'access_denied');
  assert.equal(cancel.query.state, 'xyz');

  const fragment = await postAuthorize(idp.issuer, codeFlowParams(challenge, { response_mode: 'fragment' }), { user: 'carol' });
  assert.match(new URL(fragment.location).hash, /^#code=.+&state=xyz$/);
});

test('one-click demo login, confidential client with client_secret_basic and without PKCE', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const params = { client_id: 'nextjs-app', redirect_uri: 'http://next.127.0.0.1.nip.io/api/auth/callback', response_type: 'code', scope: 'openid profile', state: 's', nonce: 'n' };
  const r = await postAuthorize(idp.issuer, params, { user: 'bob' });
  assert.equal(r.status, 302);

  const basic = Buffer.from('nextjs-app:nextjs-secret').toString('base64');
  const res = await postForm(`${idp.issuer}/token`, { grant_type: 'authorization_code', code: r.query.code, redirect_uri: params.redirect_uri }, { authorization: `Basic ${basic}` });
  assert.equal(res.status, 200);
  assert.equal(decode(res.body.id_token).nonce, 'n');
  assert.equal(decode(res.body.access_token).preferred_username, 'bob');
  assert.deepEqual(decode(res.body.access_token).roles, ['user']);
  assert.ok(res.body.refresh_token, 'refresh token issued even without offline_access (SPEC A15)');

  const downgraded = await postAuthorize(idp.issuer, params, { user: 'bob' });
  const withVerifier = await postForm(`${idp.issuer}/token`, { grant_type: 'authorization_code', code: downgraded.query.code, redirect_uri: params.redirect_uri, code_verifier: 'a'.repeat(43) }, { authorization: `Basic ${basic}` });
  assert.equal(withVerifier.status, 400);
  assert.equal(withVerifier.body.error, 'invalid_grant', 'code_verifier without a code_challenge is a PKCE downgrade (RFC 9700 4.8.2)');

  const r2 = await postAuthorize(idp.issuer, params, { user: 'bob' });
  const mismatch = await postForm(`${idp.issuer}/token`, {
    grant_type: 'authorization_code', code: r2.query.code, redirect_uri: 'http://next.127.0.0.1.nip.io/other', client_id: 'nextjs-app', client_secret: 'nextjs-secret',
  });
  assert.equal(mismatch.body.error, 'invalid_grant');

  const r3 = await postAuthorize(idp.issuer, params, { user: 'bob' });
  const wrongClient = await postForm(`${idp.issuer}/token`, { grant_type: 'authorization_code', code: r3.query.code, redirect_uri: params.redirect_uri, client_id: 'cli' });
  assert.equal(wrongClient.body.error, 'unauthorized_client');
  const r4 = await postAuthorize(idp.issuer, params, { user: 'bob' });
  const stolen = await postForm(`${idp.issuer}/token`, { grant_type: 'authorization_code', code: r4.query.code, redirect_uri: params.redirect_uri, client_id: 'angular-app', code_verifier: 'v'.repeat(43) });
  assert.equal(stolen.body.error, 'invalid_grant', 'a code cannot be redeemed by another client');
});

test('MOCK_ALLOW_ANY_REDIRECT=false enforces registered redirect URIs (trailing * is a prefix wildcard)', async (t) => {
  const idp = await startIdp({ MOCK_ALLOW_ANY_REDIRECT: 'false' });
  t.after(() => idp.stop());
  const { challenge } = pkce();
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { redirect_uri: 'http://evil.example/callback' }))).status, 400);
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { redirect_uri: 'http://angular.127.0.0.1.nip.io/callback' }))).status, 200);
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { redirect_uri: 'http://localhost:4200/' }))).status, 200);
  assert.equal((await getAuthorize(idp.issuer, codeFlowParams(challenge, { client_id: 'nextjs-app', redirect_uri: 'http://next.127.0.0.1.nip.io/api/auth/callback2' }))).status, 400, 'exact entries do not match prefixes');

  const rejected = await fetch(`${idp.issuer}/logout?post_logout_redirect_uri=http://evil.example/&client_id=angular-app`, { redirect: 'manual' });
  assert.equal(rejected.status, 200, 'unregistered post_logout_redirect_uri: page instead of redirect');
  assert.match(await rejected.text(), /not registered/);
  const accepted = await fetch(`${idp.issuer}/logout?post_logout_redirect_uri=http://angular.127.0.0.1.nip.io/bye&client_id=angular-app`, { redirect: 'manual' });
  assert.equal(accepted.status, 302);
});
