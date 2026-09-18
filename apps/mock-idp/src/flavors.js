// Claim shapes per IdP "flavor". Applications are developed against the mock and later switched to
// the real IdP, so the access token must look like the real thing (roles claim path, aud type, ...).
import { randomBytes, randomUUID } from 'node:crypto';
import { stableUuid } from './util.js';

export const FLAVORS = {
  generic: {
    label: 'Generic OIDC',
    rolesClaim: 'roles',
    summary: 'Flat roles[] and groups[] claims, aud as an array, RFC 9068-style access token. What most OIDC providers look like.',
  },
  keycloak: {
    label: 'Keycloak',
    rolesClaim: 'realm_access.roles',
    summary: 'Realm roles in realm_access.roles, client roles in resource_access.<client>.roles, typ Bearer, sid/acr/allowed-origins like a Keycloak 26 realm.',
  },
  entra: {
    label: 'Microsoft Entra ID (v2.0)',
    rolesClaim: 'roles',
    summary: 'aud is the API client id as a string, app roles in roles[], delegated scopes in scp, oid/tid/uti/ver like a v2.0 access token.',
  },
  oracle: {
    label: 'Oracle IAM Identity Domains',
    rolesClaim: 'groups',
    summary: 'sub is the user login, user_id/user_displayname/tenant/tok_type=AT, group names in groups[]. Set MOCK_ISSUER_CLAIM=https://identity.oraclecloud.com/ to imitate the issuer mismatch.',
  },
};

/** The `sub` used in the access token, the ID token and /userinfo - it must be identical in all three. */
export function subjectFor(flavor, { user, client }) {
  if (user) return flavor === 'oracle' ? user.username : user.sub;
  return flavor === 'oracle' ? client.client_id : stableUuid(`client:${client.client_id}`);
}

const tenantId = (config) => stableUuid(`tenant:${config.tenant}`);
const originsOf = (uris = []) =>
  [...new Set(uris.map((u) => { try { return new URL(u.replace(/\*.*$/, '')).origin; } catch { return null; } }).filter(Boolean))];

/**
 * Access token payload. `user` is undefined for client_credentials: the roles then come from the
 * client entry in clients.json, and there is no profile.
 */
export function accessTokenClaims({ flavor, config, client, user, scope, sid, now }) {
  const roles = user ? user.roles : client.roles;
  const iss = config.issuerClaim;
  const exp = now + config.ttl.access;
  const sub = subjectFor(flavor, { user, client });
  const profile = user
    ? { preferred_username: user.username, name: user.name, email: user.email, email_verified: user.email_verified }
    : { preferred_username: `service-account-${client.client_id}` };

  switch (flavor) {
    case 'keycloak':
      return {
        exp, iat: now, nbf: now, jti: randomUUID(), iss, aud: [config.audience], sub, typ: 'Bearer', azp: client.client_id,
        sid, session_state: sid, acr: '1', 'allowed-origins': client.web_origins ?? originsOf(client.redirect_uris),
        // Keycloak adds the realm default roles next to the assigned ones - "contains" is the right check.
        realm_access: { roles: [`default-roles-${config.tenant}`, 'offline_access', 'uma_authorization', ...roles] },
        resource_access: { [config.audience]: { roles }, account: { roles: ['manage-account', 'view-profile'] } },
        scope, ...profile, ...(user ? { given_name: user.given_name, family_name: user.family_name } : {}),
        roles, groups: user ? user.groups : roles,
      };
    case 'entra':
      return {
        aud: config.audience, // v2.0 tokens: the API's client id as a plain string
        // azpacr is Entra's own encoding of how the client authenticated: "0" public client (SPA), "1" client secret,
        // "2" certificate. Frontends therefore see "0"; confidential clients (BFF, services) see "1".
        iss, iat: now, nbf: now, exp, azp: client.client_id, azpacr: client.client_secret ? '1' : '0',
        ...(user
          ? { name: user.name, oid: user.sub, preferred_username: user.email, scp: 'access_as_user' }
          : { oid: sub, idtyp: 'app' }),
        roles, sub, tid: tenantId(config), uti: randomBytes(16).toString('base64url'), ver: '2.0',
      };
    case 'oracle':
      return {
        iss, sub, sub_type: user ? 'user' : 'client',
        ...(user ? { user_id: user.sub, user_displayname: user.name, user_tenantname: config.tenant } : {}),
        client_id: client.client_id, client_name: client.name, client_tenantname: config.tenant, tenant: config.tenant,
        tok_type: 'AT', jti: randomUUID(), aud: [config.audience], scope, groups: roles, sid, iat: now, exp,
      };
    default:
      return {
        iss, sub, aud: [config.audience], exp, iat: now, nbf: now, jti: randomUUID(), azp: client.client_id, scope,
        ...profile, roles, groups: user ? user.groups : roles,
      };
  }
}

/** ID token payload: identical core (OIDC Core 2) in every flavor plus a few flavor-specific extras. */
export function idTokenClaims({ flavor, config, client, user, nonce, authTime, atHash, sid, now }) {
  const claims = {
    iss: config.issuerClaim,
    sub: subjectFor(flavor, { user }),
    aud: client.client_id, // OIDC Core 2: MUST contain the client_id of the relying party
    azp: client.client_id,
    exp: now + config.ttl.id,
    iat: now,
    auth_time: authTime,
    ...(nonce ? { nonce } : {}), // echoed from the authorization request: binds the token to the login attempt
    at_hash: atHash,
    sid,
    name: user.name, preferred_username: user.username, email: user.email, email_verified: user.email_verified,
    given_name: user.given_name, family_name: user.family_name,
    roles: user.roles, // convenience for UI gating only - APIs use the access token
  };
  if (flavor === 'entra') Object.assign(claims, { oid: user.sub, tid: tenantId(config), preferred_username: user.email, ver: '2.0' });
  if (flavor === 'oracle') Object.assign(claims, { user_id: user.sub, user_displayname: user.name, user_tenantname: config.tenant, tok_type: 'IT' });
  return claims;
}

/** /userinfo response. Clients verify that `sub` equals the ID token's sub (OIDC Core 5.3.2). */
export function userinfoClaims({ flavor, user }) {
  return {
    sub: subjectFor(flavor, { user }),
    name: user.name,
    preferred_username: flavor === 'entra' ? user.email : user.username,
    given_name: user.given_name,
    family_name: user.family_name,
    email: user.email,
    email_verified: user.email_verified,
    roles: user.roles,
    groups: user.groups,
  };
}
