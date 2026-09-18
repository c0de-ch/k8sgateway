import { ConfigService } from './config.service';

const base = { issuer: 'http://idp.test', clientId: 'angular-app', scope: 'openid profile email', rolesClaim: 'roles' };

describe('ConfigService', () => {
  let cfg: ConfigService;

  beforeEach(() => {
    cfg = new ConfigService();
  });

  it('rejects a config.json without the required keys', () => {
    expect(() => cfg.set({ issuer: 'http://idp.test' })).toThrow(/missing: clientId, scope, apiUrl, graphqlUrl, rolesClaim/);
    expect(cfg.value()).toBeNull();
  });

  it('applies safe defaults', () => {
    const c = cfg.set({ ...base, apiUrl: 'http://api.test', graphqlUrl: 'http://graphql.test/graphql' });
    expect(c.requireHttps).toBe(true);
    expect(c.strictDiscoveryDocumentValidation).toBe(true);
    expect(c.roleUser).toBe('user');
    expect(c.roleAdmin).toBe('admin');
    expect(c.idpName).toBe('IdP');
  });

  describe('isApiUrl (which requests get the bearer token)', () => {
    beforeEach(() =>
      cfg.set({ ...base, apiUrl: 'http://api.127.0.0.1.nip.io', graphqlUrl: 'http://graphql.127.0.0.1.nip.io/graphql' }),
    );

    it('accepts the configured REST and GraphQL endpoints', () => {
      expect(cfg.isApiUrl('http://api.127.0.0.1.nip.io/api/me')).toBe(true);
      expect(cfg.isApiUrl('http://API.127.0.0.1.nip.io/api/orders?limit=1')).toBe(true);
      expect(cfg.isApiUrl('http://graphql.127.0.0.1.nip.io/graphql')).toBe(true);
    });

    it('rejects look-alike hosts, other schemes/ports and sibling paths', () => {
      expect(cfg.isApiUrl('http://api.127.0.0.1.nip.io.attacker.example/api/me')).toBe(false);
      expect(cfg.isApiUrl('https://api.127.0.0.1.nip.io/api/me')).toBe(false);
      expect(cfg.isApiUrl('http://api.127.0.0.1.nip.io:8080/api/me')).toBe(false);
      expect(cfg.isApiUrl('http://graphql.127.0.0.1.nip.io/graphql-admin')).toBe(false);
      expect(cfg.isApiUrl('http://idp.127.0.0.1.nip.io/token')).toBe(false);
      expect(cfg.isApiUrl('not a url')).toBe(false);
    });

    it('sends nothing before config.json is loaded', () => {
      expect(new ConfigService().isApiUrl('http://api.127.0.0.1.nip.io/api/me')).toBe(false);
    });
  });
});
