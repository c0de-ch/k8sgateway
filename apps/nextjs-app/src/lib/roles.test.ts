import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair } from "jose";
import { appRoles, rawRoles, readClaimPath, rolesFromTokens } from "./roles";

const rules = { rolesClaim: "roles", roleUser: "user", roleAdmin: "admin" };

test("readClaimPath walks dotted paths and tolerates missing segments", () => {
  const claims = { realm_access: { roles: ["user"] }, scope: "openid" };
  assert.deepEqual(readClaimPath(claims, "realm_access.roles"), ["user"]);
  assert.equal(readClaimPath(claims, "resource_access.api.roles"), undefined);
  assert.equal(readClaimPath(claims, "scope.foo"), undefined);
  assert.equal(readClaimPath(undefined, "roles"), undefined);
});

test("rawRoles accepts arrays and space-separated strings", () => {
  assert.deepEqual(rawRoles({ roles: ["admin", "user", 42] }, "roles"), ["admin", "user"]);
  assert.deepEqual(rawRoles({ scp: "access_as_user  admin" }, "scp"), ["access_as_user", "admin"]);
  assert.deepEqual(rawRoles({}, "roles"), []);
});

test("appRoles maps IdP values to user/admin without implying one from the other", () => {
  assert.deepEqual(appRoles({ roles: ["admin", "user"] }, rules), ["user", "admin"]);
  assert.deepEqual(appRoles({ roles: ["user"] }, rules), ["user"]);
  assert.deepEqual(appRoles({ roles: ["admin"] }, rules), ["admin"]);
  assert.deepEqual(appRoles({ roles: [] }, rules), []);
  assert.deepEqual(appRoles({ groups: ["admin"] }, rules), [], "wrong claim path -> no roles");
});

test("Keycloak and Oracle shapes work through configuration only", () => {
  const kc = { realm_access: { roles: ["offline_access", "user"] } };
  assert.deepEqual(appRoles(kc, { ...rules, rolesClaim: "realm_access.roles" }), ["user"]);
  const oracle = { groups: ["Administrators", "Users"] };
  assert.deepEqual(appRoles(oracle, { rolesClaim: "groups", roleUser: "Users", roleAdmin: "Administrators" }), ["user", "admin"]);
});

test("rolesFromTokens prefers the access token and falls back to ID token claims for opaque tokens", async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const accessToken = await new SignJWT({ roles: ["user"] }).setProtectedHeader({ alg: "RS256" }).setSubject("bob").sign(privateKey);
  assert.deepEqual(rolesFromTokens(accessToken, { roles: ["admin"] }, rules), ["user"]);
  assert.deepEqual(rolesFromTokens("opaque-token-value", { roles: ["admin"] }, rules), ["admin"]);
  const noRoles = await new SignJWT({ scope: "openid" }).setProtectedHeader({ alg: "RS256" }).setSubject("carol").sign(privateKey);
  assert.deepEqual(rolesFromTokens(noRoles, { roles: ["user"] }, rules), ["user"], "claim absent in access token -> ID token");
  assert.deepEqual(rolesFromTokens(noRoles, undefined, rules), []);
});
