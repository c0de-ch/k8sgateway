import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ApolloServer } from '@apollo/server';
import type { Request } from 'express';
import { GraphQLError } from 'graphql';
import { buildContext, createApolloServer } from '../src/app.js';
import type { AuthUser, Verifier } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createOrderStore } from '../src/orders.js';
import type { Context } from '../src/resolvers.js';

function user(sub: string, roles: string[], extra: Partial<AuthUser> = {}): AuthUser {
  return { sub, preferredUsername: sub, name: `${sub} name`, email: `${sub}@example.com`, roles, claims: { sub, roles }, token: `token-of-${sub}`, ...extra };
}
const alice = user('alice', ['admin', 'user']);
const bob = user('bob', ['user']);
const carol = user('carol', []);

interface Result {
  status: number | undefined;
  headers: Map<string, string>;
  data: Record<string, unknown> | null | undefined;
  errors: { message: string; code: string; requiredRole?: unknown; extensions: Record<string, unknown> }[];
}

describe('resolvers + authorization gates (executeOperation)', () => {
  let apollo: ApolloServer<Context>;
  let rest: http.Server;
  let restUrl: string;

  // Fake REST API: accepts only bob's/alice's token and echoes the received Authorization header.
  before(async () => {
    rest = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      if (req.url !== '/api/orders') return void res.writeHead(404).end();
      if (auth !== 'Bearer token-of-bob' && auth !== 'Bearer token-of-alice') {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
        return void res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 7, item: 'from-rest', quantity: 1, owner: auth.slice('Bearer token-of-'.length), createdAt: '2026-09-18T00:00:00Z' }]));
    });
    await new Promise<void>((r) => rest.listen(0, '127.0.0.1', r));
    restUrl = `http://127.0.0.1:${(rest.address() as AddressInfo).port}`;
    apollo = createApolloServer({ cfg: loadConfig({ REST_API_INTERNAL_URL: restUrl }), orders: createOrderStore() });
    await apollo.start();
  });
  after(async () => {
    await apollo.stop();
    await new Promise<void>((r) => rest.close(() => r()));
  });

  async function run(query: string, ctx: Context, variables?: Record<string, unknown>): Promise<Result> {
    const res = await apollo.executeOperation({ query, variables }, { contextValue: ctx });
    assert.equal(res.body.kind, 'single');
    const single = res.body.kind === 'single' ? res.body.singleResult : { data: undefined, errors: undefined };
    return {
      status: res.http.status,
      headers: new Map(res.http.headers),
      data: single.data === undefined ? undefined : (JSON.parse(JSON.stringify(single.data)) as Result['data']), // strip graphql's null prototypes
      errors: (single.errors ?? []).map((e) => ({
        message: e.message,
        code: String(e.extensions?.['code']),
        requiredRole: e.extensions?.['requiredRole'],
        extensions: { ...e.extensions },
      })),
    };
  }

  it('hello is public and greets authenticated users', async () => {
    const anon = await run('{ hello }', { user: null });
    assert.equal(anon.status, undefined); // Apollo default -> 200
    assert.match(String(anon.data?.['hello']), /anonymous/);
    assert.deepEqual(anon.errors, []);
    const auth = await run('{ hello }', { user: bob });
    assert.equal(auth.data?.['hello'], 'Hello bob name!');
  });

  it('introspection works without a token', async () => {
    const r = await run('{ __schema { queryType { name } } }', { user: null });
    assert.deepEqual(r.data, { __schema: { queryType: { name: 'Query' } } });
    assert.equal(r.status, undefined);
  });

  it('me requires authentication -> UNAUTHENTICATED + 401 + WWW-Authenticate', async () => {
    const r = await run('{ me { sub } }', { user: null });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="graphql-api"');
    assert.deepEqual(r.data, { me: null }); // nullable field -> data present, field null
    assert.equal(r.errors[0]?.code, 'UNAUTHENTICATED');
    assert.equal(r.errors[0]?.message, 'authentication required');
  });

  it('a presented but invalid token is refused while building the context: 401 + invalid_token challenge (RFC 6750 §3.1)', async () => {
    const verifier = { authenticate: async () => ({ user: null, error: 'token expired' }) } as unknown as Verifier;
    const req = { headers: { authorization: 'Bearer expired' } } as unknown as Request;
    await assert.rejects(buildContext(verifier)({ req }), (e: unknown) => {
      assert.ok(e instanceof GraphQLError);
      assert.equal(e.message, 'invalid token: token expired');
      assert.equal(e.extensions['code'], 'UNAUTHENTICATED');
      const http = e.extensions['http'] as { status: number; headers: Map<string, string> };
      assert.equal(http.status, 401);
      assert.equal(http.headers.get('www-authenticate'), 'Bearer realm="graphql-api", error="invalid_token", error_description="token expired"');
      return true;
    });
  });

  it('me returns profile, raw roles and claims', async () => {
    const r = await run('{ me { sub name preferredUsername email roles claims } }', { user: alice });
    assert.deepEqual(r.data, {
      me: { sub: 'alice', name: 'alice name', preferredUsername: 'alice', email: 'alice@example.com', roles: ['admin', 'user'], claims: { sub: 'alice', roles: ['admin', 'user'] } },
    });
  });

  it('orders requires role user: carol (no roles) is FORBIDDEN with 403, bob gets the list', async () => {
    const denied = await run('{ orders { id } }', { user: carol });
    assert.equal(denied.status, 403);
    assert.equal(denied.data, null); // non-null field errored -> whole data null
    assert.equal(denied.errors[0]?.code, 'FORBIDDEN');
    assert.equal(denied.errors[0]?.requiredRole, 'user');

    const ok = await run('{ orders { id item quantity owner createdAt } }', { user: bob });
    assert.equal(ok.status, undefined);
    assert.equal((ok.data?.['orders'] as unknown[]).length, 3);
  });

  it('createOrder stores an order owned by the caller and validates input', async () => {
    const r = await run('mutation($item: String!, $q: Int!) { createOrder(item: $item, quantity: $q) { id item quantity owner } }', { user: bob }, { item: 'Laptop stand', q: 2 });
    assert.deepEqual(r.data, { createOrder: { id: 'ord-4', item: 'Laptop stand', quantity: 2, owner: 'bob' } });
    const bad = await run('mutation { createOrder(item: " ", quantity: 0) { id } }', { user: bob });
    assert.equal(bad.errors[0]?.code, 'BAD_USER_INPUT');
    const anon = await run('mutation { createOrder(item: "x", quantity: 1) { id } }', { user: null });
    assert.equal(anon.status, 401);
    const noRole = await run('mutation { createOrder(item: "x", quantity: 1) { id } }', { user: carol });
    assert.equal(noRole.status, 403);
  });

  it('adminStats requires role admin', async () => {
    const denied = await run('{ adminStats { orders } }', { user: bob });
    assert.equal(denied.status, 403);
    assert.equal(denied.errors[0]?.requiredRole, 'admin');
    const ok = await run('{ adminStats { orders users uptimeSeconds } }', { user: alice });
    const stats = ok.data?.['adminStats'] as { orders: number; users: number; uptimeSeconds: number };
    assert.equal(stats.orders, 4); // 3 seeded + 1 created above
    assert.equal(stats.users, 2); // alice, bob
    assert.ok(stats.uptimeSeconds >= 0);
  });

  it('HTTP status policy: 403 only when nothing succeeded, 401 whenever authentication failed', async () => {
    // adminStats is non-null, so GraphQL nulls the whole data object -> the operation failed as a whole -> 403
    const r = await run('{ hello adminStats { orders } }', { user: bob });
    assert.equal(r.status, 403);
    assert.equal(r.data, null);
    assert.equal(r.errors[0]?.code, 'FORBIDDEN');
    // a nullable protected field next to a public one: public data survives, but UNAUTHENTICATED still forces 401
    const r2 = await run('{ hello me { sub } }', { user: null });
    assert.equal(r2.status, 401);
    assert.match(String(r2.data?.['hello']), /anonymous/);
    assert.equal(r2.data?.['me'], null);
    // a plain field error (bad input) keeps the GraphQL default: 200 with partial data
    const r3 = await run('mutation { createOrder(item: "", quantity: 1) { id } }', { user: bob });
    assert.equal(r3.status, undefined);
    assert.equal(r3.errors[0]?.code, 'BAD_USER_INPUT');
  });

  it('restOrders relays the caller token to the REST API', async () => {
    const r = await run('{ restOrders { id item owner } }', { user: bob });
    assert.deepEqual(r.data, { restOrders: [{ id: '7', item: 'from-rest', owner: 'bob' }] });
    const denied = await run('{ restOrders { id } }', { user: carol });
    assert.equal(denied.status, 403);
  });

  it('restOrders surfaces upstream rejections as UPSTREAM_ERROR (status only, the upstream body is never echoed)', async () => {
    const r = await run('{ restOrders { id } }', { user: user('mallory', ['user']) });
    assert.equal(r.status, undefined);
    assert.equal(r.errors[0]?.code, 'UPSTREAM_ERROR');
    assert.match(r.errors[0]?.message ?? '', /401/);
    assert.equal(r.errors[0]?.extensions['upstreamStatus'], 401);
    assert.equal('upstreamBody' in (r.errors[0]?.extensions ?? {}), false);
    assert.doesNotMatch(JSON.stringify(r.errors), /unauthorized/); // the fake REST API's body
  });

  it('role values are configurable (ROLE_ADMIN/ROLE_USER map onto the raw claim values)', async () => {
    const custom = createApolloServer({ cfg: loadConfig({ ROLE_USER: 'k8sgateway.reader', ROLE_ADMIN: 'k8sgateway.admin' }), orders: createOrderStore() });
    await custom.start();
    try {
      const res = await custom.executeOperation({ query: '{ orders { id } adminStats { orders } }' }, { contextValue: { user: user('svc', ['k8sgateway.admin', 'k8sgateway.reader']) } });
      assert.equal(res.body.kind, 'single');
      assert.equal(res.body.kind === 'single' ? res.body.singleResult.errors : 'x', undefined);
      const denied = await custom.executeOperation({ query: '{ orders { id } }' }, { contextValue: { user: bob } }); // 'user' is not the configured value
      assert.equal(denied.http.status, 403);
    } finally {
      await custom.stop();
    }
  });
});
