import test from 'node:test';
import assert from 'node:assert/strict';
import { atHash, decode, decodeHeader, postForm, startIdp } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function tokensFor(idp) {
  const user = await postForm(`${idp.issuer}/token`, { grant_type: 'password', client_id: 'cli', username: 'alice', password: 'alice', scope: 'openid profile email' });
  const svc = await postForm(`${idp.issuer}/token`, { grant_type: 'client_credentials', client_id: 'svc-batch', client_secret: 'svc-batch-secret' });
  assert.equal(user.status, 200);
  assert.equal(svc.status, 200);
  return { user: user.body, svc: svc.body, at: decode(user.body.access_token), id: decode(user.body.id_token), svcAt: decode(svc.body.access_token) };
}

test('generic flavor', async (t) => {
  const idp = await startIdp();
  t.after(() => idp.stop());
  const { at, id, svcAt } = await tokensFor(idp);
  assert.deepEqual(at.aud, ['k8sgateway-api']);
  assert.deepEqual(at.roles, ['admin', 'user']);
  assert.deepEqual(at.groups, ['admin', 'user']);
  assert.equal(at.preferred_username, 'alice');
  assert.equal(at.name, 'Alice Admin');
  assert.equal(at.email, 'alice@example.com');
  assert.equal(at.email_verified, true);
  assert.equal(at.azp, 'cli');
  assert.equal(at.scope, 'openid profile email');
  assert.match(at.sub, UUID);
  assert.equal(id.sub, at.sub);
  assert.deepEqual(svcAt.roles, ['admin']);
  assert.equal(svcAt.azp, 'svc-batch');
  assert.match(svcAt.sub, UUID);
});

test('keycloak flavor', async (t) => {
  const idp = await startIdp({ MOCK_FLAVOR: 'keycloak' });
  t.after(() => idp.stop());
  const { at, svcAt } = await tokensFor(idp);
  assert.equal(at.typ, 'Bearer');
  assert.equal(at.acr, '1');
  assert.ok(at.sid);
  assert.ok(Array.isArray(at['allowed-origins']));
  assert.ok(at.realm_access.roles.includes('admin') && at.realm_access.roles.includes('user'));
  assert.deepEqual(at.resource_access['k8sgateway-api'].roles, ['admin', 'user']);
  assert.equal(at.given_name, 'Alice');
  assert.equal(at.family_name, 'Admin');
  assert.deepEqual(at.aud, ['k8sgateway-api']);
  assert.deepEqual(at.roles, ['admin', 'user'], 'keycloak = generic + realm/resource access');
  assert.ok(svcAt.realm_access.roles.includes('admin'));
  assert.equal(svcAt.preferred_username, 'service-account-svc-batch');
});

test('entra flavor', async (t) => {
  const idp = await startIdp({ MOCK_FLAVOR: 'entra' });
  t.after(() => idp.stop());
  const { at, id, svcAt } = await tokensFor(idp);
  assert.equal(at.aud, 'k8sgateway-api', 'Entra v2: aud is a string');
  assert.equal(at.ver, '2.0');
  assert.equal(at.scp, 'access_as_user');
  assert.equal(at.azpacr, '0');
  assert.equal(at.preferred_username, 'alice@example.com');
  assert.match(at.oid, UUID);
  assert.match(at.tid, UUID);
  assert.ok(at.uti);
  assert.deepEqual(at.roles, ['admin', 'user']);
  assert.equal(at.jti, undefined);
  assert.equal(id.sub, at.sub);
  assert.equal(id.tid, at.tid);
  assert.deepEqual(svcAt.roles, ['admin']);
  assert.equal(svcAt.scp, undefined, 'app-only tokens have roles, not scp');
  assert.equal(svcAt.idtyp, 'app');
  assert.equal(svcAt.azpacr, '1');
});

test('oracle flavor with the issuer override', async (t) => {
  const idp = await startIdp({ MOCK_FLAVOR: 'oracle', MOCK_ISSUER_CLAIM: 'https://identity.oraclecloud.com/' });
  t.after(() => idp.stop());
  const { user, at, id, svcAt } = await tokensFor(idp);
  assert.equal(at.iss, 'https://identity.oraclecloud.com/');
  assert.equal(at.sub, 'alice', 'Oracle: sub is the user login');
  assert.equal(at.sub_type, 'user');
  assert.equal(at.tok_type, 'AT');
  assert.equal(at.user_displayname, 'Alice Admin');
  assert.equal(at.user_tenantname, 'k8sgateway');
  assert.equal(at.client_id, 'cli');
  assert.equal(at.client_name, 'Scripts and tests (password grant)');
  assert.deepEqual(at.aud, ['k8sgateway-api']);
  assert.deepEqual(at.groups, ['admin', 'user']);
  assert.match(at.user_id, UUID);
  assert.equal(id.sub, 'alice');
  assert.equal(id.iss, 'https://identity.oraclecloud.com/');
  assert.equal(svcAt.sub, 'svc-batch');
  assert.deepEqual(svcAt.groups, ['admin']);

  const info = await (await fetch(`${idp.issuer}/userinfo`, { headers: { authorization: `Bearer ${user.access_token}` } })).json();
  assert.equal(info.sub, 'alice', 'userinfo sub matches the ID token sub');
});

test('ID token has the same shape in every flavor', async () => {
  for (const flavor of ['generic', 'keycloak', 'entra', 'oracle']) {
    const idp = await startIdp({ MOCK_FLAVOR: flavor });
    try {
      const { user, id } = await tokensFor(idp);
      assert.deepEqual(decodeHeader(user.id_token), { alg: 'RS256', typ: 'JWT', kid: idp.key.kid });
      assert.equal(id.aud, 'cli');
      assert.equal(id.iss, idp.issuer);
      assert.equal(id.at_hash, await atHash(user.access_token));
      for (const c of ['sub', 'exp', 'iat', 'auth_time', 'name', 'preferred_username', 'email', 'email_verified', 'given_name', 'family_name', 'roles']) {
        assert.ok(c in id, `${flavor}: id_token has ${c}`);
      }
      assert.equal(id.exp - id.iat, 300);
      assert.deepEqual(id.roles, ['admin', 'user']);
    } finally {
      await idp.stop();
    }
  }
});

test('TTLs and audience are configurable', async (t) => {
  const idp = await startIdp({ MOCK_ACCESS_TOKEN_TTL: '120', MOCK_ID_TOKEN_TTL: '60', MOCK_REFRESH_TOKEN_TTL: '900', MOCK_AUDIENCE: 'orders-api' });
  t.after(() => idp.stop());
  const res = await postForm(`${idp.issuer}/token`, { grant_type: 'password', client_id: 'cli', username: 'bob', password: 'bob', scope: 'openid offline_access' });
  assert.equal(res.body.expires_in, 120);
  assert.equal(res.body.refresh_expires_in, 900);
  const at = decode(res.body.access_token);
  const id = decode(res.body.id_token);
  assert.equal(at.exp - at.iat, 120);
  assert.equal(id.exp - id.iat, 60);
  assert.deepEqual(at.aud, ['orders-api']);
});
