/**
 * A tiny in-process "identity provider" for the tests: generates an RSA key pair with jose and
 * serves OIDC discovery + JWKS over plain HTTP on an ephemeral port. token() mints access tokens.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
export type PrivateKey = KeyPair['privateKey'];

export interface TokenOptions {
  /** Signing key (defaults to the IdP key). */
  key?: PrivateKey;
  kid?: string;
  alg?: string;
  issuer?: string;
  audience?: string | string[];
  /** Seconds relative to now (negative = already expired). */
  expiresIn?: number;
  /** Omit the `exp` claim entirely — such a token must be rejected. */
  withoutExp?: boolean;
  notBefore?: number;
}

export interface TestIdp {
  issuer: string;
  jwksUri: string;
  kid: string;
  requests: { discovery: number; jwks: number };
  /** Makes the next `n` discovery requests answer HTTP 500. */
  failDiscovery(n: number): void;
  token(claims?: JWTPayload & Record<string, unknown>, opts?: TokenOptions): Promise<string>;
  /** A second key pair that is NOT published in the JWKS. */
  foreignKey(): Promise<{ privateKey: PrivateKey; kid: string }>;
  close(): Promise<void>;
}

export const DEFAULT_CLAIMS = {
  sub: '22222222-2222-2222-2222-222222222222',
  preferred_username: 'bob',
  name: 'Bob User',
  email: 'bob@example.com',
  roles: ['user'],
};

export async function startTestIdp(): Promise<TestIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk: JWK = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };

  const requests = { discovery: 0, jwks: 0 };
  let discoveryFailures = 0;
  let issuer = '';

  const server = http.createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      requests.discovery++;
      if (discoveryFailures > 0) {
        discoveryFailures--;
        res.writeHead(500).end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks`, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }));
      return;
    }
    if (req.url === '/jwks') {
      requests.jwks++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    kid,
    requests,
    failDiscovery: (n) => {
      discoveryFailures = n;
    },
    async token(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ ...DEFAULT_CLAIMS, ...claims })
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? kid, typ: 'at+jwt' })
        .setIssuer(opts.issuer ?? issuer)
        .setAudience(opts.audience ?? 'k8sgateway-api')
        .setIssuedAt(now);
      if (!opts.withoutExp) jwt.setExpirationTime(now + (opts.expiresIn ?? 300));
      if (opts.notBefore !== undefined) jwt.setNotBefore(now + opts.notBefore);
      return jwt.sign(opts.key ?? privateKey);
    },
    async foreignKey() {
      const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
      return { privateKey: pair.privateKey, kid: await calculateJwkThumbprint(await exportJWK(pair.publicKey)) };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** An unsigned token (`alg: none`) — must always be rejected. */
export function unsignedToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

/** Polls until `check()` is true or the timeout elapses. */
export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
