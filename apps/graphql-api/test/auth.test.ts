import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { AuthError, createVerifier, extractRoles, type Verifier } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { startTestIdp, unsignedToken, waitFor, type TestIdp } from './helpers/test-idp.js';

const AUD = 'k8sgateway-api';

async function rejects(p: Promise<unknown>, kind: 'invalid_token' | 'idp_unavailable', messagePart?: string | RegExp) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AuthError, `expected AuthError, got ${String(e)}`);
    assert.equal(e.kind, kind);
    if (messagePart) assert.match(e.message, messagePart instanceof RegExp ? messagePart : new RegExp(messagePart));
    return;
  }
  assert.fail('expected the promise to reject');
}

describe('token verification (discovery path)', () => {
  let idp: TestIdp;
  let verifier: Verifier;

  before(async () => {
    idp = await startTestIdp();
    verifier = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: AUD, DISCOVERY_RETRY_MS: '10' }));
  });
  after(async () => {
    verifier.stop();
    await idp.close();
  });

  it('discovers lazily on first use and reports ready', async () => {
    assert.equal(verifier.state().ready, false);
    const user = await verifier.verify(await idp.token());
    assert.equal(user.sub, '22222222-2222-2222-2222-222222222222');
    assert.equal(user.preferredUsername, 'bob');
    assert.equal(user.name, 'Bob User');
    assert.equal(user.email, 'bob@example.com');
    assert.deepEqual(user.roles, ['user']);
    assert.equal(user.claims.iss, idp.issuer);
    const s = verifier.state();
    assert.equal(s.ready, true);
    assert.equal(s.source, 'discovery');
    assert.equal(s.jwksUri, idp.jwksUri);
    assert.equal(idp.requests.discovery, 1);
  });

  it('accepts aud as an array containing the audience', async () => {
    const user = await verifier.verify(await idp.token({}, { audience: ['other-api', AUD] }));
    assert.deepEqual(user.claims.aud, ['other-api', AUD]);
  });

  it('rejects a wrong audience', async () => {
    await rejects(verifier.verify(await idp.token({}, { audience: 'someone-else' })), 'invalid_token', /aud/);
  });

  it('rejects a wrong issuer (trailing slash matters)', async () => {
    await rejects(verifier.verify(await idp.token({}, { issuer: `${idp.issuer}/` })), 'invalid_token', /iss/);
    await rejects(verifier.verify(await idp.token({}, { issuer: 'https://evil.example.com' })), 'invalid_token', /iss/);
  });

  it('rejects an expired token but tolerates 60s of clock skew', async () => {
    await rejects(verifier.verify(await idp.token({}, { expiresIn: -120 })), 'invalid_token', /expired/);
    const user = await verifier.verify(await idp.token({}, { expiresIn: -30 }));
    assert.equal(user.sub, '22222222-2222-2222-2222-222222222222');
  });

  it('rejects a token without exp (RFC 9068 requires it; jose alone would accept it forever)', async () => {
    await rejects(verifier.verify(await idp.token({}, { withoutExp: true })), 'invalid_token', /exp/);
  });

  it('rejects a token that is not valid yet (nbf) beyond the tolerance', async () => {
    await rejects(verifier.verify(await idp.token({}, { notBefore: 300 })), 'invalid_token', /nbf/);
    await verifier.verify(await idp.token({}, { notBefore: 30 })); // within tolerance
  });

  it('rejects alg=none and HMAC-signed tokens before any key lookup', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: 'x', iss: idp.issuer, aud: AUD, exp: now + 300, iat: now };
    await rejects(verifier.verify(unsignedToken(payload)), 'invalid_token');
    const hs = await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('jwks-are-public-so-this-is-useless'));
    await rejects(verifier.verify(hs), 'invalid_token', /alg/i);
  });

  it('rejects a token signed with a key that is not in the JWKS', async () => {
    const foreign = await idp.foreignKey();
    await rejects(verifier.verify(await idp.token({}, { key: foreign.privateKey, kid: foreign.kid })), 'invalid_token', /signing key/);
    // same kid, different key -> signature check fails
    await rejects(verifier.verify(await idp.token({}, { key: foreign.privateKey })), 'invalid_token', /signature/);
  });

  it('rejects garbage and tokens without sub', async () => {
    await rejects(verifier.verify('not.a.jwt'), 'invalid_token');
    await rejects(verifier.verify(await idp.token({ sub: '' })), 'invalid_token', /sub/);
  });

  it('authenticate(): no header -> anonymous, bad token -> anonymous with reason, good token -> user', async () => {
    assert.deepEqual(await verifier.authenticate(undefined), { user: null });
    assert.deepEqual(await verifier.authenticate(''), { user: null });
    const basic = await verifier.authenticate('Basic dXNlcjpwdw==');
    assert.equal(basic.user, null);
    assert.match(basic.error ?? '', /Bearer/);
    const expired = await verifier.authenticate(`Bearer ${await idp.token({}, { expiresIn: -600 })}`);
    assert.equal(expired.user, null);
    assert.equal(expired.error, 'token expired');
    const ok = await verifier.authenticate(`bearer ${await idp.token()}`); // scheme is case-insensitive
    assert.equal(ok.user?.sub, '22222222-2222-2222-2222-222222222222');
    assert.equal(ok.error, undefined);
  });
});

describe('roles extraction', () => {
  it('reads dotted paths, arrays and space-separated strings; missing claim => []', () => {
    assert.deepEqual(extractRoles({ roles: ['admin', 'user'] }, 'roles'), ['admin', 'user']);
    assert.deepEqual(extractRoles({ realm_access: { roles: ['user', 'offline_access'] } }, 'realm_access.roles'), ['user', 'offline_access']);
    assert.deepEqual(extractRoles({ scp: 'access_as_user admin' }, 'scp'), ['access_as_user', 'admin']);
    assert.deepEqual(extractRoles({ roles: ['user', 42, null] }, 'roles'), ['user']);
    assert.deepEqual(extractRoles({}, 'realm_access.roles'), []);
    assert.deepEqual(extractRoles({ realm_access: 'nope' }, 'realm_access.roles'), []);
  });

  it('maps Keycloak-style claims into the user', async () => {
    const idp = await startTestIdp();
    try {
      const verifier = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer, ROLES_CLAIM: 'realm_access.roles' }));
      const user = await verifier.verify(await idp.token({ realm_access: { roles: ['admin', 'user'] }, roles: undefined }));
      assert.deepEqual(user.roles, ['admin', 'user']);
    } finally {
      await idp.close();
    }
  });
});

describe('OIDC_JWKS_URI override and issuer claim', () => {
  it('skips discovery entirely when OIDC_JWKS_URI is set', async () => {
    const idp = await startTestIdp();
    try {
      const verifier = createVerifier(loadConfig({ OIDC_ISSUER: 'http://idp.internal', OIDC_ISSUER_CLAIM: idp.issuer, OIDC_JWKS_URI: idp.jwksUri }));
      const user = await verifier.verify(await idp.token());
      assert.equal(user.sub, '22222222-2222-2222-2222-222222222222');
      assert.equal(idp.requests.discovery, 0);
      assert.equal(idp.requests.jwks, 1);
      assert.equal(verifier.state().source, 'env');
    } finally {
      await idp.close();
    }
  });

  it('tolerates a trailing slash in OIDC_ISSUER by adopting the issuer advertised by discovery', async () => {
    const idp = await startTestIdp();
    try {
      const verifier = createVerifier(loadConfig({ OIDC_ISSUER: `${idp.issuer}/` }));
      const user = await verifier.verify(await idp.token()); // the token's iss has no slash, like the discovery document
      assert.equal(user.claims.iss, idp.issuer);
      assert.equal(verifier.state().issuer, idp.issuer);
      await rejects(verifier.verify(await idp.token({}, { issuer: `${idp.issuer}/` })), 'invalid_token', /iss/); // still exact afterwards
      // an explicit OIDC_ISSUER_CLAIM is never "corrected"
      const strict = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer, OIDC_ISSUER_CLAIM: `${idp.issuer}/` }));
      await rejects(strict.verify(await idp.token()), 'idp_unavailable', /discovery issuer/);
    } finally {
      await idp.close();
    }
  });

  it('refuses a discovery document whose issuer differs from the expected iss claim', async () => {
    const idp = await startTestIdp();
    try {
      const verifier = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer, OIDC_ISSUER_CLAIM: 'https://identity.example.com/' }));
      await rejects(verifier.verify(await idp.token()), 'idp_unavailable', /discovery issuer/);
      assert.equal(verifier.state().ready, false);
      assert.match(verifier.state().lastError ?? '', /OIDC_ISSUER_CLAIM/);
    } finally {
      await idp.close();
    }
  });
});

describe('discovery resilience', () => {
  it('start() retries with back-off until the IdP answers; requests during the outage fail closed', async () => {
    const idp = await startTestIdp();
    idp.failDiscovery(2);
    const verifier = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer, DISCOVERY_RETRY_MS: '10' }));
    try {
      verifier.start();
      await waitFor(() => verifier.state().ready, 5000);
      assert.ok(verifier.state().attempts >= 3, `attempts=${verifier.state().attempts}`);
      assert.equal(verifier.state().lastError, undefined);
      const user = await verifier.verify(await idp.token());
      assert.equal(user.preferredUsername, 'bob');
    } finally {
      verifier.stop();
      await idp.close();
    }
  });

  it('a request while discovery fails gets idp_unavailable, the next one succeeds', async () => {
    const idp = await startTestIdp();
    idp.failDiscovery(1);
    const verifier = createVerifier(loadConfig({ OIDC_ISSUER: idp.issuer }));
    try {
      await rejects(verifier.verify(await idp.token()), 'idp_unavailable', /HTTP 500/);
      assert.equal(verifier.state().ready, false);
      await verifier.verify(await idp.token());
      assert.equal(verifier.state().ready, true);
    } finally {
      await idp.close();
    }
  });
});
