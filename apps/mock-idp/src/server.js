// Mock OpenID Connect provider for development: discovery, JWKS, authorization code flow with
// PKCE, token endpoint (4 grants), userinfo, introspection, revocation, RP-initiated logout,
// a dashboard and a token debugger. Everything is in memory and configured via environment variables.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compactVerify, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { loadClients, loadConfig, loadUsers } from './config.js';
import { parseCookies, serializeCookie, signValue, verifyValue } from './cookies.js';
import { FLAVORS, subjectFor, userinfoClaims } from './flavors.js';
import { loadSigningKey } from './keys.js';
import { authenticateClient, clientAllows, isPublicClient, issueTokens, redirectUriAllowed, verifyPkce } from './oidc.js';
import * as pages from './pages.js';
import { createStores } from './store.js';
import { log, nowSeconds, randomToken, safeEqual, setLogLevel, splitScope } from './util.js';

export const SESSION_COOKIE = 'mock_idp_session';
const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials', 'password'];
const CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none']; // none = public clients send client_id only
const AUTHORIZE_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge',
  'code_challenge_method', 'response_mode', 'prompt', 'login_hint', 'max_age'];

export async function createServer(env = process.env) {
  const config = loadConfig(env);
  setLogLevel(config.logLevel);
  const users = loadUsers(config.usersFile);
  const clients = loadClients(config.clientsFile);
  const key = await loadSigningKey(config.keyFile);
  const stores = createStores();
  const secureCookies = config.issuer.startsWith('https://');
  const view = { config, users, clients, key }; // shared template context

  const userByName = (name) => users.find((u) => u.username === name);
  const clientById = (id) => clients.find((c) => c.client_id === id);
  const url = (path) => `${config.issuer}${path}`;
  const pick = (src = {}) => Object.fromEntries(AUTHORIZE_PARAMS.filter((k) => typeof src[k] === 'string' && src[k] !== '').map((k) => [k, src[k]]));

  const discovery = {
    issuer: config.issuerClaim, // clients compare this with the URL they used for discovery (OIDC Discovery 4.3)
    authorization_endpoint: url('/authorize'),
    token_endpoint: url('/token'),
    userinfo_endpoint: url('/userinfo'),
    jwks_uri: url('/jwks'),
    end_session_endpoint: url('/logout'),
    introspection_endpoint: url('/introspect'),
    revocation_endpoint: url('/revoke'),
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    grant_types_supported: GRANT_TYPES,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    introspection_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS, // RFC 8414: both endpoints authenticate the client
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    claims_supported: [...new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'azp', 'scope', 'auth_time', 'nonce', 'at_hash', 'sid',
      'name', 'preferred_username', 'given_name', 'family_name', 'email', 'email_verified', 'roles', 'groups', FLAVORS[config.flavor].rolesClaim])],
    code_challenge_methods_supported: ['S256'],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };

  // ---- sessions (signed cookie carrying a server-side session id) -----------------------------
  const readSession = (req) => {
    const cookie = verifyValue(parseCookies(req.headers.cookie)[SESSION_COOKIE], config.cookieSecret);
    const session = cookie?.sid && stores.sessions.get(cookie.sid);
    return session && userByName(session.username) ? { sid: cookie.sid, ...session } : null;
  };
  const startSession = (res, user) => {
    const session = { sid: randomUUID(), username: user.username, auth_time: nowSeconds() };
    stores.sessions.set(session.sid, { username: session.username, auth_time: session.auth_time }, config.ttl.session);
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, signValue({ sid: session.sid }, config.cookieSecret), { maxAge: config.ttl.session, secure: secureCookies }));
    return session;
  };
  const endSession = (res, sid) => {
    if (sid) {
      stores.sessions.delete(sid);
      stores.refreshTokens.deleteWhere((rt) => rt.sid === sid); // tokens minted in that session die with it
    }
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies }));
  };

  // ---- helpers ------------------------------------------------------------------------------
  /** Redirects to redirect_uri with params in the query (default) or in the fragment. */
  function redirectTo(res, { redirect_uri, response_mode }, params) {
    const target = new URL(redirect_uri);
    const bag = response_mode === 'fragment' ? new URLSearchParams(target.hash.slice(1)) : target.searchParams;
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') bag.set(k, String(v));
    if (response_mode === 'fragment') target.hash = bag.toString();
    res.redirect(302, target.href);
  }

  /**
   * Validates an authorization request. A `fatal` problem (unknown client, untrusted redirect_uri) is
   * shown to the user - never redirected. Other problems go back to the client (RFC 6749 4.1.2.1).
   */
  function checkAuthorizeRequest(p) {
    const client = clientById(p.client_id);
    if (!client) return { fatal: `Unknown client_id "${p.client_id ?? ''}". Register it in clients.json.` };
    if (!redirectUriAllowed(client.redirect_uris, p.redirect_uri, config.allowAnyRedirect)) {
      return { fatal: `redirect_uri "${p.redirect_uri ?? ''}" is missing, not http(s) or not registered for client "${client.client_id}".` };
    }
    const error = (code, description) => ({ client, error: code, description });
    if (p.response_type !== 'code') return error('unsupported_response_type', 'only response_type=code is supported');
    if (p.response_mode && !['query', 'fragment'].includes(p.response_mode)) return error('invalid_request', 'unsupported response_mode');
    if (!clientAllows(client, 'authorization_code')) return error('unauthorized_client', 'client may not use the authorization code grant');
    if (p.code_challenge && p.code_challenge_method !== 'S256') return error('invalid_request', 'only code_challenge_method=S256 is supported');
    // PKCE is what protects a public client (SPA) against stolen codes - no exceptions.
    if (isPublicClient(client) && !p.code_challenge) return error('invalid_request', 'PKCE (code_challenge) is mandatory for public clients');
    return { client };
  }

  function issueCode(res, p, client, user, session) {
    const code = randomToken(32);
    stores.codes.set(code, {
      client_id: client.client_id, redirect_uri: p.redirect_uri, scope: p.scope ?? '', nonce: p.nonce,
      code_challenge: p.code_challenge, username: user.username, auth_time: session.auth_time, sid: session.sid,
    }, config.ttl.code);
    Object.assign(res.locals, { client_id: client.client_id, sub: subjectFor(config.flavor, { user }), roles: user.roles });
    redirectTo(res, p, { code, state: p.state });
  }

  const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const verifyOwnToken = async (token) =>
    (await jwtVerify(token, key.publicKey, { algorithms: ['RS256'], issuer: config.issuerClaim })).payload;

  const failClientAuth = (res, auth) => {
    if (auth.viaHeader) res.set('WWW-Authenticate', 'Basic realm="mock-idp"'); // RFC 6749 5.2
    res.status(401).json({ error: 'invalid_client', error_description: auth.description });
  };

  // ---- app ----------------------------------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // behind Envoy Gateway: req.ip comes from X-Forwarded-For

  // One JSON line per request; sub/roles/client_id are filled in by the handlers once known.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => log(req.path === '/healthz' || req.path === '/readyz' ? 'debug' : 'info', {
      msg: 'request', method: req.method, path: req.path, status: res.statusCode,
      duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100, ip: req.ip,
      ...(res.locals.client_id && { client_id: res.locals.client_id }),
      ...(res.locals.sub && { sub: res.locals.sub }),
      ...(res.locals.roles && { roles: res.locals.roles }),
    }));
    next();
  });

  // CORS: the Angular SPA calls discovery, /jwks, /token and /userinfo from its own origin. No cookies
  // are involved in those calls, so a wildcard origin is safe. Preflights are answered here.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers') || 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.urlencoded({ extended: false })); // token requests and login forms; req.body stays undefined otherwise

  app.get('/.well-known/openid-configuration', (_req, res) => res.json(discovery));
  app.get('/jwks', (_req, res) => res.set('Cache-Control', 'public, max-age=300').json({ keys: [key.jwk] }));

  // ---- authorization endpoint ---------------------------------------------------------------
  app.get('/authorize', (req, res) => {
    const p = pick(req.query);
    const check = checkAuthorizeRequest(p);
    if (check.fatal) return res.status(400).type('html').send(pages.errorPage({ ...view, title: 'Invalid authorization request', message: check.fatal }));
    if (check.error) return redirectTo(res, p, { error: check.error, error_description: check.description, state: p.state });

    const prompts = splitScope(p.prompt);
    const session = readSession(req);
    const maxAge = p.max_age === undefined ? Infinity : Number(p.max_age); // OIDC Core 3.1.2.1: max_age=0 behaves like prompt=login
    const fresh = session && maxAge > 0 && nowSeconds() - session.auth_time <= maxAge;
    if (fresh && !prompts.includes('login')) return issueCode(res, p, check.client, userByName(session.username), session); // SSO
    if (prompts.includes('none')) return redirectTo(res, p, { error: 'login_required', error_description: 'no SSO session', state: p.state }); // OIDC Core 3.1.2.6
    res.type('html').send(pages.loginPage({ ...view, client: check.client, params: p, loginHint: p.login_hint }));
  });

  app.post('/authorize', (req, res) => {
    const body = req.body ?? {};
    const p = pick(body);
    const check = checkAuthorizeRequest(p); // hidden form fields can be tampered with: validate again
    if (check.fatal) return res.status(400).type('html').send(pages.errorPage({ ...view, title: 'Invalid authorization request', message: check.fatal }));
    if (check.error) return redirectTo(res, p, { error: check.error, error_description: check.description, state: p.state });
    if (body.cancel) return redirectTo(res, p, { error: 'access_denied', error_description: 'the user cancelled the login', state: p.state });

    const user = body.user
      ? userByName(body.user) // one-click demo buttons skip the password
      : users.find((u) => u.username === body.username && safeEqual(u.password, body.password));
    if (!user) {
      return res.status(401).type('html').send(pages.loginPage({
        ...view, client: check.client, params: p, loginHint: body.username, error: 'Wrong username or password. Demo passwords equal the username.',
      }));
    }
    issueCode(res, p, check.client, user, startSession(res, user));
  });

  // ---- token endpoint -----------------------------------------------------------------------
  app.post('/token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }); // RFC 6749 5.1
    const b = req.body ?? {};
    const fail = (status, error, error_description) => res.status(status).json({ error, error_description }); // RFC 6749 5.2

    const auth = authenticateClient(req, clients);
    if (auth.error) return failClientAuth(res, auth);
    const { client } = auth;
    res.locals.client_id = client.client_id;

    if (!b.grant_type) return fail(400, 'invalid_request', 'grant_type is required'); // RFC 6749 5.2: missing parameter
    if (!GRANT_TYPES.includes(b.grant_type)) return fail(400, 'unsupported_grant_type', `grant_type must be one of ${GRANT_TYPES.join(', ')}`);
    if (!clientAllows(client, b.grant_type)) return fail(400, 'unauthorized_client', `client "${client.client_id}" may not use grant_type=${b.grant_type}`);

    let grant; // { user, scope, nonce, authTime, sid, includeRefresh }
    switch (b.grant_type) {
      case 'authorization_code': {
        if (!b.code) return fail(400, 'invalid_request', 'code is required');
        const rec = stores.codes.take(b.code); // single use, even when this exchange fails
        if (!rec) return fail(400, 'invalid_grant', 'authorization code is unknown, expired or already used');
        if (rec.client_id !== client.client_id) return fail(400, 'invalid_grant', 'code was issued to a different client');
        if (rec.redirect_uri !== b.redirect_uri) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
        if (rec.code_challenge) { // PKCE: only the app that started the flow knows the verifier
          if (!b.code_verifier) return fail(400, 'invalid_request', 'code_verifier is required');
          if (!verifyPkce(b.code_verifier, rec.code_challenge)) return fail(400, 'invalid_grant', 'PKCE verification failed: code_verifier does not match code_challenge');
        } else if (b.code_verifier) { // RFC 9700 4.8.2: a verifier for a flow that never sent a challenge means someone stripped it
          return fail(400, 'invalid_grant', 'code_verifier was sent but the authorization request carried no code_challenge (PKCE downgrade)');
        }
        grant = {
          user: userByName(rec.username), scope: rec.scope, nonce: rec.nonce, authTime: rec.auth_time, sid: rec.sid,
          // A refresh token comes with every code grant the client may refresh; offline_access is accepted but not
          // required (Keycloak behaves the same, Entra requires the scope - the apps use "openid profile email" here).
          includeRefresh: clientAllows(client, 'refresh_token'),
        };
        break;
      }
      case 'refresh_token': {
        const rec = b.refresh_token ? stores.refreshTokens.get(b.refresh_token) : undefined;
        if (!rec) return fail(400, 'invalid_grant', 'refresh token is unknown, expired, revoked or already rotated');
        if (rec.client_id !== client.client_id) return fail(400, 'invalid_grant', 'refresh token belongs to a different client');
        const requested = splitScope(b.scope);
        if (requested.some((s) => !splitScope(rec.scope).includes(s))) return fail(400, 'invalid_scope', 'a refresh cannot extend the originally granted scope');
        const user = userByName(rec.username);
        if (!user) return fail(400, 'invalid_grant', 'the user no longer exists');
        stores.refreshTokens.delete(b.refresh_token); // rotation: the presented token is consumed, a new one is issued below
        grant = { user, scope: requested.length ? requested.join(' ') : rec.scope, nonce: rec.nonce, authTime: rec.auth_time, sid: rec.sid, includeRefresh: true };
        break;
      }
      case 'client_credentials':
        if (isPublicClient(client)) return fail(400, 'unauthorized_client', 'client_credentials requires a confidential client');
        grant = { scope: b.scope, includeRefresh: false }; // no user: roles come from clients.json
        break;
      case 'password': { // convenience for scripts and CI - real IdPs discourage or removed this grant
        const user = users.find((u) => u.username === b.username && safeEqual(u.password, b.password));
        if (!user) return fail(400, 'invalid_grant', 'wrong username or password');
        const scope = b.scope || 'openid profile email';
        grant = { user, scope, authTime: nowSeconds(), sid: randomUUID(), includeRefresh: clientAllows(client, 'refresh_token') }; // refresh token regardless of offline_access
        break;
      }
    }
    const tokens = await issueTokens({ config, key, client, stores, ...grant });
    Object.assign(res.locals, { sub: subjectFor(config.flavor, { user: grant.user, client }), roles: grant.user ? grant.user.roles : client.roles });
    res.json(tokens);
  });

  // ---- userinfo / introspection / revocation ------------------------------------------------
  const userinfo = async (req, res) => {
    const token = bearer(req) ?? req.body?.access_token;
    if (!token) return res.set('WWW-Authenticate', 'Bearer realm="mock-idp"').status(401).json({ error: 'invalid_token', error_description: 'missing bearer token' });
    try {
      const payload = await verifyOwnToken(token);
      const user = users.find((u) => subjectFor(config.flavor, { user: u }) === payload.sub);
      Object.assign(res.locals, { sub: payload.sub, roles: user?.roles });
      res.json(user ? userinfoClaims({ flavor: config.flavor, user }) : { sub: payload.sub }); // sub MUST match the ID token
    } catch (err) {
      res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${err.code ?? 'invalid token'}"`)
        .status(401).json({ error: 'invalid_token', error_description: err.message });
    }
  };
  app.get('/userinfo', userinfo);
  app.post('/userinfo', userinfo);

  app.post('/introspect', async (req, res) => { // RFC 7662
    const auth = authenticateClient(req, clients);
    if (auth.error) return failClientAuth(res, auth);
    res.locals.client_id = auth.client.client_id;
    const token = req.body?.token ?? '';
    const rt = stores.refreshTokens.get(token);
    if (rt) return res.json({ active: true, token_type: 'refresh_token', client_id: rt.client_id, username: rt.username, scope: rt.scope, sid: rt.sid });
    try {
      const payload = await verifyOwnToken(token);
      res.locals.sub = payload.sub;
      res.json({ active: true, token_type: 'Bearer', client_id: payload.azp ?? payload.client_id, username: payload.preferred_username, ...payload });
    } catch {
      res.json({ active: false }); // RFC 7662 2.2: do not explain why
    }
  });

  app.post('/revoke', (req, res) => { // RFC 7009 - refresh tokens only; access tokens are stateless JWTs
    const auth = authenticateClient(req, clients);
    if (auth.error) return failClientAuth(res, auth);
    res.locals.client_id = auth.client.client_id;
    const token = req.body?.token ?? '';
    if (stores.refreshTokens.get(token)?.client_id === auth.client.client_id) stores.refreshTokens.delete(token);
    res.status(200).end(); // 200 even for unknown tokens
  });

  // ---- RP-initiated logout ------------------------------------------------------------------
  const logout = async (req, res) => {
    const q = { ...req.query, ...(req.body ?? {}) };
    let hint = null;
    if (typeof q.id_token_hint === 'string') {
      try { // signature only - the ID token is usually expired by the time the user logs out
        const { payload } = await compactVerify(q.id_token_hint, key.publicKey, { algorithms: ['RS256'] });
        const claims = JSON.parse(Buffer.from(payload).toString());
        if (claims.iss === config.issuerClaim) hint = claims;
      } catch { /* best effort: an unusable hint just means no client context */ }
    }
    const client = clientById(hint?.aud) ?? clientById(q.client_id);
    const session = readSession(req);
    endSession(res, session?.sid ?? hint?.sid);
    Object.assign(res.locals, { client_id: client?.client_id, sub: hint?.sub ?? session?.username });

    const uri = typeof q.post_logout_redirect_uri === 'string' ? q.post_logout_redirect_uri : undefined;
    // RP-Initiated Logout 1.0: only redirect to URIs registered for the client (or anywhere in dev mode)
    if (uri && redirectUriAllowed(client?.post_logout_redirect_uris, uri, config.allowAnyRedirect)) {
      return redirectTo(res, { redirect_uri: uri }, { state: q.state });
    }
    res.type('html').send(pages.loggedOutPage({ ...view, rejectedRedirect: uri }));
  };
  app.get('/logout', logout);
  app.post('/logout', logout);

  // ---- dashboard, debugger, health ----------------------------------------------------------
  app.get('/', (req, res) => res.type('html').send(pages.dashboardPage({
    ...view, session: readSession(req),
    stats: { codes: stores.codes.size, refreshTokens: stores.refreshTokens.size, sessions: stores.sessions.size },
  })));

  async function inspectToken(token) {
    const result = { checks: [] };
    try {
      result.header = decodeProtectedHeader(token);
      result.payload = decodeJwt(token);
    } catch (err) {
      return { parseError: `Not a JWT: ${err.message}` };
    }
    const now = nowSeconds();
    const check = (name, ok, detail) => result.checks.push({ name, ok, detail });
    try {
      await compactVerify(token, key.publicKey, { algorithms: ['RS256'] });
      check('Signature', true, `verified with the current key (kid ${key.kid})`);
    } catch (err) {
      check('Signature', false, err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? 'does not verify with the current key (tampered, or signed by another key/issuer)' : err.message);
    }
    check('Key id (kid)', result.header.kid === key.kid, result.header.kid ?? 'missing');
    check('Algorithm (alg)', result.header.alg === 'RS256', result.header.alg ?? 'missing');
    check('Issuer (iss)', result.payload.iss === config.issuerClaim, `${result.payload.iss ?? 'missing'} (expected ${config.issuerClaim})`);
    const { exp, nbf } = result.payload;
    check('Expiry (exp)', typeof exp === 'number' && exp > now, typeof exp !== 'number' ? 'missing' : exp > now ? `valid for another ${exp - now}s` : `expired ${now - exp}s ago`);
    if (typeof nbf === 'number') check('Not before (nbf)', nbf <= now, nbf <= now ? 'ok' : `not valid for another ${nbf - now}s`);
    result.valid = result.checks.every((c) => c.ok);
    return result;
  }
  app.get('/debug/token', (_req, res) => res.type('html').send(pages.debugTokenPage({ ...view })));
  app.post('/debug/token', async (req, res) => {
    const token = String(req.body?.token ?? '').trim();
    res.type('html').send(pages.debugTokenPage({ ...view, token, result: await inspectToken(token) }));
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.json({ status: 'ready', issuer: config.issuer, flavor: config.flavor, kid: key.kid }));

  app.use((req, res) => res.status(404).json({ error: 'not_found', error_description: `${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars -- Express recognises error handlers by their arity
  app.use((err, _req, res, _next) => {
    log('error', { msg: 'unhandled error', error: err.message, stack: err.stack });
    res.status(500).json({ error: 'server_error' }); // never leak stack traces to clients
  });

  return {
    app, config, users, clients, key, stores,
    listen: (port = config.port) => new Promise((resolve, reject) => {
      const server = app.listen(port, () => resolve(server));
      server.once('error', reject);
    }),
    close: () => stores.close(),
  };
}

// Entry point when started as `node src/server.js` (not when imported by the tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idp = await createServer();
  const server = await idp.listen();
  log('info', {
    msg: 'mock-idp listening', port: server.address().port, issuer: idp.config.issuer, issuer_claim: idp.config.issuerClaim,
    flavor: idp.config.flavor, audience: idp.config.audience, kid: idp.key.kid, key: idp.key.source,
    users: idp.users.map((u) => u.username), clients: idp.clients.map((c) => c.client_id),
  });
  const shutdown = (signal) => {
    log('info', { msg: 'shutting down', signal });
    server.close(() => { idp.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
