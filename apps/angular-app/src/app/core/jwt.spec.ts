import { base64UrlDecode, claimPath, decodeJwt, extractRoles } from './jwt';

/** builds an unsigned token with the given payload (signature part is irrelevant for decoding) */
function fakeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc(header)}.${enc(payload)}.sig`;
}

describe('jwt helpers', () => {
  it('decodes base64url without padding', () => {
    expect(base64UrlDecode('aGk')).toBe('hi');
    expect(base64UrlDecode('Pz8-Pw')).toBe('??>?');
  });

  it('decodes header and payload', () => {
    const t = decodeJwt(fakeJwt({ sub: 'alice', exp: 123 }));
    expect(t?.header['alg']).toBe('RS256');
    expect(t?.payload['sub']).toBe('alice');
    expect(t?.signature).toBe('sig');
  });

  it('returns null for garbage', () => {
    expect(decodeJwt(null)).toBeNull();
    expect(decodeJwt('not-a-token')).toBeNull();
    expect(decodeJwt('a.b.c')).toBeNull();
  });

  it('reads dotted claim paths', () => {
    const claims = { realm_access: { roles: ['admin'] }, scp: 'read write' };
    expect(claimPath(claims, 'realm_access.roles')).toEqual(['admin']);
    expect(claimPath(claims, 'realm_access.missing')).toBeUndefined();
    expect(claimPath(null, 'x')).toBeUndefined();
  });

  it('extracts roles from arrays, space-separated strings and missing claims', () => {
    expect(extractRoles({ roles: ['admin', 'user'] }, 'roles')).toEqual(['admin', 'user']);
    expect(extractRoles({ realm_access: { roles: ['user', 'offline_access'] } }, 'realm_access.roles')).toEqual(['user', 'offline_access']);
    expect(extractRoles({ scp: 'access_as_user admin' }, 'scp')).toEqual(['access_as_user', 'admin']);
    expect(extractRoles({ roles: [1, 'user'] }, 'roles')).toEqual(['user']);
    expect(extractRoles({}, 'roles')).toEqual([]);
    expect(extractRoles(undefined, 'roles')).toEqual([]);
  });
});
