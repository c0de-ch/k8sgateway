/**
 * Minimal JWT helpers - decode only, no library.
 * The SPA never verifies signatures: it just reads claims for display and for UI hints (menu entries).
 * The REST and GraphQL APIs verify every token (signature via JWKS, iss, aud, exp) on every request.
 */
export type Claims = Record<string, unknown>;

export interface DecodedJwt {
  header: Claims;
  payload: Claims;
  /** base64url signature, kept only to show the token structure */
  signature: string;
}

/** base64url (RFC 7515, no padding) -> UTF-8 string */
export function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeJwt(token: string | null | undefined): DecodedJwt | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(base64UrlDecode(parts[0])) as Claims,
      payload: JSON.parse(base64UrlDecode(parts[1])) as Claims,
      signature: parts[2],
    };
  } catch {
    return null;
  }
}

/** Reads a dotted path such as "realm_access.roles" from a claims object. */
export function claimPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, key) => (o && typeof o === 'object' ? (o as Claims)[key] : undefined), obj);
}

/**
 * Role extraction rule shared by all apps of the tutorial: the claim may be an array of strings
 * or a space-separated string (like `scp`). A missing claim means "no roles" (still authenticated).
 */
export function extractRoles(claims: unknown, path: string): string[] {
  const value = claimPath(claims, path);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  return [];
}
