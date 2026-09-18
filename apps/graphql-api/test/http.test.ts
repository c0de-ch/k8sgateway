/** End-to-end over HTTP: Express + CORS + real token verification against the in-process IdP. */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ApolloServer } from '@apollo/server';
import { createApolloServer, createExpressApp } from '../src/app.js';
import { createVerifier, type Verifier } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createOrderStore } from '../src/orders.js';
import type { Context } from '../src/resolvers.js';
import { startTestIdp, unsignedToken, waitFor, type TestIdp } from './helpers/test-idp.js';

const ORIGIN = 'http://angular.127.0.0.1.nip.io';

describe('HTTP surface', () => {
  let idp: TestIdp;
  let verifier: Verifier;
  let apollo: ApolloServer<Context>;
  let server: http.Server;
  let base: string;

  before(async () => {
    idp = await startTestIdp();
    const cfg = loadConfig({ OIDC_ISSUER: idp.issuer, CORS_ORIGINS: `${ORIGIN}, http://*.example.test`, DISCOVERY_RETRY_MS: '10' });
    verifier = createVerifier(cfg);
    server = http.createServer();
    apollo = createApolloServer({ cfg, orders: createOrderStore(), httpServer: server });
    await apollo.start();
    server.on('request', createExpressApp({ cfg, apollo, verifier }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    verifier.stop();
    await apollo.stop(); // drain plugin closes `server`
    await idp.close();
  });

  const gql = (query: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ query }) });

  it('/healthz is always 200; /readyz turns 200 once the JWKS were loaded', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    let ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { status: string }).status, 'not_ready');
    verifier.start();
    await waitFor(() => verifier.state().ready);
    ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as { status: string; discovery: { jwksUri: string } };
    assert.equal(body.status, 'ready');
    assert.equal(body.discovery.jwksUri, idp.jwksUri);
  });

  it('GET /graphql serves the landing page (Sandbox) for browsers', async () => {
    const res = await fetch(`${base}/graphql`, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /sandbox/i);
  });

  it('public field without token -> 200', async () => {
    const res = await gql('{ hello }');
    assert.equal(res.status, 200);
    assert.match(JSON.stringify(await res.json()), /anonymous/);
  });

  it('protected field without token -> 401 + WWW-Authenticate', async () => {
    const res = await gql('{ me { sub } }');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="graphql-api"');
    const body = (await res.json()) as { errors: { extensions: { code: string } }[] };
    assert.equal(body.errors[0]?.extensions.code, 'UNAUTHENTICATED');
  });

  it('expired / unsigned / wrong-audience tokens -> 401 invalid_token', async () => {
    const expired = await gql('{ me { sub } }', { authorization: `Bearer ${await idp.token({}, { expiresIn: -600 })}` });
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get('www-authenticate'), 'Bearer realm="graphql-api", error="invalid_token", error_description="token expired"');

    const now = Math.floor(Date.now() / 1000);
    const none = await gql('{ me { sub } }', { authorization: `Bearer ${unsignedToken({ sub: 'x', iss: idp.issuer, aud: 'k8sgateway-api', exp: now + 300 })}` });
    assert.equal(none.status, 401);

    const aud = await gql('{ me { sub } }', { authorization: `Bearer ${await idp.token({}, { audience: 'other' })}` });
    assert.equal(aud.status, 401);
    assert.match(aud.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    const noExp = await gql('{ me { sub } }', { authorization: `Bearer ${await idp.token({}, { withoutExp: true })}` });
    assert.equal(noExp.status, 401);
    assert.match(noExp.headers.get('www-authenticate') ?? '', /missing required .exp. claim/);
  });

  it('a garbage token is refused even when only public fields are selected (RFC 6750 §3.1)', async () => {
    const res = await gql('{ hello }', { authorization: 'Bearer garbage.token.here' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer realm="graphql-api", error="invalid_token", error_description=/);
    const body = (await res.json()) as { data?: unknown; errors: { message: string; extensions: Record<string, unknown> }[] };
    assert.equal(body.data, undefined);
    assert.equal(body.errors[0]?.extensions['code'], 'UNAUTHENTICATED');
    assert.equal('http' in (body.errors[0]?.extensions ?? {}), false); // Apollo strips the http extension from the body
    assert.doesNotMatch(JSON.stringify(body), /at .*\.js:\d+/);
  });

  it('valid token -> 200 with profile; role gates apply', async () => {
    const res = await gql('{ me { sub preferredUsername roles } orders { id } }', { authorization: `Bearer ${await idp.token()}` });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { me: { preferredUsername: string; roles: string[] }; orders: unknown[] } };
    assert.equal(body.data.me.preferredUsername, 'bob');
    assert.deepEqual(body.data.me.roles, ['user']);
    assert.equal(body.data.orders.length, 3);

    const admin = await gql('{ adminStats { orders } }', { authorization: `Bearer ${await idp.token()}` });
    assert.equal(admin.status, 403);
    const ok = await gql('{ adminStats { orders } }', { authorization: `Bearer ${await idp.token({ roles: ['admin', 'user'] })}` });
    assert.equal(ok.status, 200);
  });

  it('CORS: preflight from an allowed origin permits Authorization; unknown origins get no CORS headers', async () => {
    const pre = await fetch(`${base}/graphql`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);

    const wildcard = await fetch(`${base}/graphql`, { method: 'OPTIONS', headers: { origin: 'http://app.example.test', 'access-control-request-method': 'POST' } });
    assert.equal(wildcard.headers.get('access-control-allow-origin'), 'http://app.example.test');

    const actual = await gql('{ me { sub } }', { origin: ORIGIN });
    assert.equal(actual.status, 401);
    assert.equal(actual.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(actual.headers.get('access-control-expose-headers') ?? '', /WWW-Authenticate/);

    const evil = await gql('{ hello }', { origin: 'http://evil.example.com' });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });

  it('malformed JSON body -> 400 JSON error without a stack trace', async () => {
    const res = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'bad_request');
    assert.doesNotMatch(JSON.stringify(body), /at .*\.js:\d+/);
  });
});
