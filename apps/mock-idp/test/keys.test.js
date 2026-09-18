import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { postForm, startIdp } from './helpers.js';

test('MOCK_KEY_FILE persists the signing key across restarts (stable kid)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mock-idp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'idp.pem');

  const first = await startIdp({ MOCK_KEY_FILE: keyFile });
  const { kid } = first.key;
  assert.equal(first.key.source, `${keyFile} (created)`);
  const { body } = await postForm(`${first.issuer}/token`, { grant_type: 'password', client_id: 'cli', username: 'bob', password: 'bob' });
  await first.stop();
  assert.match(await readFile(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);

  const second = await startIdp({ MOCK_KEY_FILE: keyFile });
  t.after(() => second.stop());
  assert.equal(second.key.kid, kid);
  assert.equal(second.key.source, keyFile);
  // a token minted before the restart still verifies against the JWKS of the restarted instance
  const { payload } = await jwtVerify(body.access_token, createRemoteJWKSet(new URL(`${second.issuer}/jwks`)), { audience: 'k8sgateway-api' });
  assert.equal(payload.preferred_username, 'bob');
});

test('an ephemeral key is generated when MOCK_KEY_FILE is unset', async (t) => {
  const a = await startIdp();
  t.after(() => a.stop());
  const b = await startIdp();
  t.after(() => b.stop());
  assert.notEqual(a.key.kid, b.key.kid);
  assert.equal(a.key.source, 'generated (ephemeral)');
  assert.equal(a.key.jwk.kid, a.key.kid);
});
