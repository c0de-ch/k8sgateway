import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpiringSoon, keyFromHex, safeReturnTo, seal, unseal, type Session } from "./session-crypto";

const HEX = "0123456789abcdef".repeat(4); // 64 hex chars = 32 bytes
const key = keyFromHex(HEX);

const session: Session = {
  sub: "alice-uuid",
  name: "Alice Admin",
  roles: ["user", "admin"],
  accessToken: "eyJ.access.token",
  refreshToken: "refresh-1",
  issuedAt: 1_799_999_700,
  expiresAt: 1_800_000_000,
  authTime: 1_700_000_000,
};

test("keyFromHex requires exactly 64 hex characters", () => {
  assert.equal(key.byteLength, 32);
  assert.throws(() => keyFromHex(undefined), /64 hex/);
  assert.throws(() => keyFromHex("abc"), /64 hex/);
  assert.throws(() => keyFromHex("zz".repeat(32)), /64 hex/);
});

test("seal/unseal round-trips the session and produces a compact JWE (5 parts, dir/A256GCM header)", async () => {
  const token = await seal(session, 60, key);
  const parts = token.split(".");
  assert.equal(parts.length, 5);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  assert.deepEqual(header, { alg: "dir", enc: "A256GCM" });
  assert.ok(!token.includes("access.token"), "payload must not be readable in clear text");
  const back = await unseal<Session>(token, key);
  assert.ok(back);
  assert.equal(back.sub, "alice-uuid");
  assert.equal(back.accessToken, "eyJ.access.token");
  assert.deepEqual(back.roles, ["user", "admin"]);
});

test("tampered ciphertext, wrong key, garbage and missing cookies all yield null", async () => {
  const token = await seal(session, 60, key);
  const parts = token.split(".");
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "BB" : "AA"); // flip ciphertext bytes
  assert.equal(await unseal(parts.join("."), key), null);
  assert.equal(await unseal(token, keyFromHex("f".repeat(64))), null);
  assert.equal(await unseal("not-a-jwe", key), null);
  assert.equal(await unseal(undefined, key), null);
});

test("expired payloads are rejected", async () => {
  const token = await seal(session, -120, key); // exp already in the past (beyond jose's default tolerance)
  assert.equal(await unseal(token, key), null);
});

test("safeReturnTo only accepts same-origin absolute paths", () => {
  assert.equal(safeReturnTo("/orders?x=1"), "/orders?x=1");
  assert.equal(safeReturnTo(undefined), "/");
  assert.equal(safeReturnTo(""), "/");
  assert.equal(safeReturnTo("https://evil.example"), "/");
  assert.equal(safeReturnTo("//evil.example/path"), "/");
  assert.equal(safeReturnTo("/\\evil.example"), "/");
  assert.equal(safeReturnTo("orders", "/dashboard"), "/dashboard");
});

test("isExpiringSoon uses a 30 s guard, capped at half the token lifetime (no refresh loop for short tokens)", () => {
  const now = 1_000_000;
  const token = (ttl: number, age: number) => ({ issuedAt: now - age, expiresAt: now - age + ttl });
  assert.equal(isExpiringSoon(token(300, 0), 30, now), false, "fresh 5-minute token");
  assert.equal(isExpiringSoon(token(300, 269), 30, now), false, "31 s left");
  assert.equal(isExpiringSoon(token(300, 270), 30, now), true, "30 s left -> refresh");
  assert.equal(isExpiringSoon(token(300, 400), 30, now), true, "long expired");
  assert.equal(isExpiringSoon(token(30, 0), 30, now), false, "fresh 30 s token: guard shrinks to 15 s");
  assert.equal(isExpiringSoon(token(30, 15), 30, now), true, "15 s left of a 30 s token -> refresh");
  assert.equal(isExpiringSoon({ issuedAt: Number.NaN, expiresAt: now + 10 }, 30, now), true, "unknown lifetime: plain 30 s guard");
});
