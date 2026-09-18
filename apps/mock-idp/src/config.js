// Configuration comes from environment variables only (12-factor). Every value has a development
// default, so `node src/server.js` works without any setup. Users and clients are JSON files.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stableUuid } from './util.js';

export const FLAVOR_NAMES = ['generic', 'keycloak', 'entra', 'oracle'];

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());

export function loadConfig(env = process.env) {
  const issuer = (env.MOCK_ISSUER || 'http://idp.127.0.0.1.nip.io').replace(/\/+$/, '');
  const flavor = env.MOCK_FLAVOR || 'generic';
  if (!FLAVOR_NAMES.includes(flavor)) {
    throw new Error(`MOCK_FLAVOR must be one of ${FLAVOR_NAMES.join('|')} (got "${flavor}")`);
  }
  return {
    // Base URL of every endpoint. Discovery is served at ${issuer}/.well-known/openid-configuration.
    issuer,
    // Value of the `iss` claim and of "issuer" in the discovery document. Only differs from `issuer`
    // when imitating Oracle IAM, whose discovery document advertises https://identity.oraclecloud.com/
    // although the endpoints live under the tenant URL.
    issuerClaim: env.MOCK_ISSUER_CLAIM || issuer,
    port: int(env.PORT, 8080),
    flavor,
    audience: env.MOCK_AUDIENCE || 'k8sgateway-api',
    ttl: {
      access: int(env.MOCK_ACCESS_TOKEN_TTL, 300),
      id: int(env.MOCK_ID_TOKEN_TTL, 300),
      refresh: int(env.MOCK_REFRESH_TOKEN_TTL, 1800),
      code: 60, // authorization codes are single-use and short-lived (RFC 6749 4.1.2)
      session: int(env.MOCK_SESSION_TTL, 8 * 3600),
    },
    // true (dev default): any http(s) redirect_uri is accepted. false: only the registered ones.
    allowAnyRedirect: bool(env.MOCK_ALLOW_ANY_REDIRECT, true),
    keyFile: env.MOCK_KEY_FILE || '',
    usersFile: env.MOCK_USERS_FILE || here('../users.json'),
    clientsFile: env.MOCK_CLIENTS_FILE || here('../clients.json'),
    // Signs the SSO cookie. Random per start unless pinned (sessions then survive restarts).
    cookieSecret: env.MOCK_COOKIE_SECRET || randomBytes(32).toString('base64url'),
    tenant: env.MOCK_TENANT || 'k8sgateway',
    logLevel: env.LOG_LEVEL || 'info',
  };
}

function readJsonArray(file, what) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${what} from ${file}: ${err.message}`);
  }
  if (!Array.isArray(data)) throw new Error(`${what} file ${file} must contain a JSON array`);
  return data;
}

/** users.json: username, password, name, email required; sub/given_name/family_name/roles/groups optional. */
export function loadUsers(file) {
  return readJsonArray(file, 'users').map((u, i) => {
    for (const field of ['username', 'password', 'name', 'email']) {
      if (typeof u[field] !== 'string' || !u[field]) throw new Error(`users[${i}]: "${field}" is required`);
    }
    const [given = u.name, ...rest] = u.name.split(' ');
    const user = { sub: stableUuid(`user:${u.username}`), email_verified: true, given_name: given, family_name: rest.join(' '), roles: [], ...u };
    return { ...user, groups: u.groups ?? user.roles };
  });
}

/** clients.json: client_id required; client_secret makes the client confidential; roles feed client_credentials tokens. */
export function loadClients(file) {
  return readJsonArray(file, 'clients').map((c, i) => {
    if (typeof c.client_id !== 'string' || !c.client_id) throw new Error(`clients[${i}]: "client_id" is required`);
    const client = { name: c.client_id, grant_types: ['authorization_code', 'refresh_token'], redirect_uris: [], roles: [], ...c };
    return { ...client, post_logout_redirect_uris: c.post_logout_redirect_uris ?? client.redirect_uris };
  });
}
