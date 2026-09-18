import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, decodeHeader, postForm, startIdp } from './helpers.js';

const token = (idp) => `${idp.issuer}/token`;
const basic = (id, secret) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });

test('password grant (cli client, scripts only)', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());

  const ok = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'alice', password: 'alice', scope: 'openid profile email' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.body.token_type, 'Bearer');
  assert.equal(ok.body.expires_in, 300);
  assert.equal(ok.body.scope, 'openid profile email');
  assert.deepEqual(decodeHeader(ok.body.access_token), { alg: 'RS256', typ: 'JWT', kid: idp.key.kid });
  const at = decode(ok.body.access_token);
  assert.deepEqual(at.roles, ['admin', 'user'], 'alice shows both roles');
  assert.deepEqual(at.aud, ['k8sgateway-api']);
  assert.equal(at.iss, idp.issuer);
  assert.equal(at.azp, 'cli');
  assert.ok(at.jti && at.nbf && at.iat && at.exp - at.iat === 300);
  assert.ok(ok.body.id_token, 'openid scope => id_token');
  assert.ok(ok.body.refresh_token, 'refresh token issued even without offline_access (SPEC A15)');
  assert.equal(ok.body.refresh_expires_in, 1800);

  const carol = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'carol', password: 'carol' });
  assert.deepEqual(decode(carol.body.access_token).roles, [], 'carol is authenticated but has no roles');
  assert.equal(carol.body.scope, 'openid profile email', 'default scope');

  const bad = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'alice', password: 'wrong' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_grant');
  const notAllowed = await postForm(token(idp), { grant_type: 'password', client_id: 'angular-app', username: 'alice', password: 'alice' });
  assert.equal(notAllowed.status, 400);
  assert.equal(notAllowed.body.error, 'unauthorized_client');
});

test('client authentication and RFC 6749 error responses', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());

  const unknown = await postForm(token(idp), { grant_type: 'client_credentials', client_id: 'ghost', client_secret: 'x' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'invalid_client');
  assert.equal(unknown.headers.get('www-authenticate'), null, 'no challenge when the header was not used');

  const wrongSecret = await postForm(token(idp), { grant_type: 'client_credentials' }, basic('svc-batch', 'nope'));
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, 'invalid_client');
  assert.match(wrongSecret.headers.get('www-authenticate'), /^Basic/);

  const missingSecret = await postForm(token(idp), { grant_type: 'client_credentials', client_id: 'svc-batch' });
  assert.equal(missingSecret.status, 401);
  const conflicting = await postForm(token(idp), { grant_type: 'client_credentials', client_id: 'cli' }, basic('svc-batch', 'svc-batch-secret'));
  assert.equal(conflicting.body.error, 'invalid_client');

  const unsupported = await postForm(token(idp), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'cli' });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error, 'unsupported_grant_type');
  const noGrant = await postForm(token(idp), { client_id: 'cli' });
  assert.equal(noGrant.status, 400);
  assert.equal(noGrant.body.error, 'invalid_request', 'RFC 6749 5.2: a missing required parameter is invalid_request');

  const noBody = await fetch(token(idp), { method: 'POST' });
  assert.equal(noBody.status, 401);
  assert.equal((await noBody.json()).error, 'invalid_client');
});

test('client_credentials: roles come from the client entry', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());

  const viaBasic = await postForm(token(idp), { grant_type: 'client_credentials' }, basic('svc-batch', 'svc-batch-secret'));
  assert.equal(viaBasic.status, 200);
  const at = decode(viaBasic.body.access_token);
  assert.deepEqual(at.roles, ['admin']);
  assert.equal(at.azp, 'svc-batch');
  assert.equal(at.preferred_username, 'service-account-svc-batch');
  assert.deepEqual(at.aud, ['k8sgateway-api']);
  assert.equal(viaBasic.body.id_token, undefined);
  assert.equal(viaBasic.body.refresh_token, undefined);
  assert.equal(viaBasic.body.scope, undefined);

  const viaPost = await postForm(token(idp), { grant_type: 'client_credentials', client_id: 'svc-batch', client_secret: 'svc-batch-secret', scope: 'k8sgateway-api/.default' });
  assert.equal(viaPost.status, 200);
  assert.equal(decode(viaPost.body.access_token).sub, at.sub, 'stable subject for a client');
  assert.equal(viaPost.body.scope, 'k8sgateway-api/.default');

  const publicClient = await postForm(token(idp), { grant_type: 'client_credentials', client_id: 'cli' });
  assert.equal(publicClient.body.error, 'unauthorized_client');
});

test('refresh token rotation', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());

  const first = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'bob', password: 'bob', scope: 'openid offline_access' });
  assert.ok(first.body.refresh_token);
  assert.equal(first.body.refresh_expires_in, 1800);

  const second = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli', refresh_token: first.body.refresh_token });
  assert.equal(second.status, 200);
  assert.ok(second.body.refresh_token && second.body.refresh_token !== first.body.refresh_token, 'a new refresh token is issued');
  assert.equal(decode(second.body.access_token).preferred_username, 'bob');
  assert.ok(second.body.id_token, 'refresh with openid scope returns a new id_token');

  const reuse = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli', refresh_token: first.body.refresh_token });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'invalid_grant', 'the rotated token is dead');

  const otherClient = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'angular-app', refresh_token: second.body.refresh_token });
  assert.equal(otherClient.body.error, 'invalid_grant');
  const wider = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli', refresh_token: second.body.refresh_token, scope: 'openid offline_access admin:everything' });
  assert.equal(wider.body.error, 'invalid_scope');
  const narrower = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli', refresh_token: second.body.refresh_token, scope: 'openid' });
  assert.equal(narrower.status, 200);
  assert.equal(narrower.body.scope, 'openid');

  const revoke = await postForm(`${idp.issuer}/revoke`, { client_id: 'cli', token: narrower.body.refresh_token });
  assert.equal(revoke.status, 200);
  const afterRevoke = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli', refresh_token: narrower.body.refresh_token });
  assert.equal(afterRevoke.body.error, 'invalid_grant');
  const missing = await postForm(token(idp), { grant_type: 'refresh_token', client_id: 'cli' });
  assert.equal(missing.body.error, 'invalid_grant');
});

test('userinfo and introspection', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const { body } = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'alice', password: 'alice', scope: 'openid offline_access' });

  const missing = await fetch(`${idp.issuer}/userinfo`);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /^Bearer/);
  const garbage = await fetch(`${idp.issuer}/userinfo`, { headers: { authorization: 'Bearer not.a.jwt' } });
  assert.equal(garbage.status, 401);
  assert.match(garbage.headers.get('www-authenticate'), /invalid_token/);

  const info = await (await fetch(`${idp.issuer}/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } })).json();
  assert.equal(info.sub, decode(body.id_token).sub);
  assert.equal(info.preferred_username, 'alice');
  assert.deepEqual(info.roles, ['admin', 'user']);
  const viaPost = await postForm(`${idp.issuer}/userinfo`, { access_token: body.access_token });
  assert.equal(viaPost.body.sub, info.sub);

  const active = await postForm(`${idp.issuer}/introspect`, { client_id: 'cli', token: body.access_token });
  assert.equal(active.body.active, true);
  assert.equal(active.body.client_id, 'cli');
  assert.equal(active.body.username, 'alice');
  const rt = await postForm(`${idp.issuer}/introspect`, { client_id: 'cli', token: body.refresh_token });
  assert.equal(rt.body.active, true);
  assert.equal(rt.body.token_type, 'refresh_token');
  const inactive = await postForm(`${idp.issuer}/introspect`, { client_id: 'cli', token: 'nope' });
  assert.deepEqual(inactive.body, { active: false });
  const unauthenticated = await postForm(`${idp.issuer}/introspect`, { client_id: 'svc-batch', token: body.access_token });
  assert.equal(unauthenticated.status, 401);
});

test('token debugger page decodes and validates', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const { body } = await postForm(token(idp), { grant_type: 'password', client_id: 'cli', username: 'alice', password: 'alice' });
  const debug = (jwt) => fetch(`${idp.issuer}/debug/token`, { method: 'POST', body: new URLSearchParams({ token: jwt }) }).then((r) => r.text());

  assert.equal((await fetch(`${idp.issuer}/debug/token`)).status, 200);
  const html = await debug(body.access_token);
  assert.match(html, /Token is valid/);
  assert.match(html, /&quot;preferred_username&quot;: &quot;alice&quot;/);
  const tampered = await debug(`${body.access_token.slice(0, -4)}AAAA`);
  assert.match(tampered, /Token is NOT valid/);
  assert.match(await debug('garbage'), /Not a JWT/);
});
