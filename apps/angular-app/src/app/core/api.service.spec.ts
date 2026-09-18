import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiService } from './api.service';
import { ConfigService } from './config.service';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(ConfigService).set({
      issuer: 'http://idp.test', clientId: 'angular-app', scope: 'openid',
      apiUrl: 'http://api.test/', graphqlUrl: 'http://graphql.test/graphql', rolesClaim: 'roles',
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('calls apiUrl without a double slash and returns the body', async () => {
    const p = api.getMe();
    const req = http.expectOne('http://api.test/api/me');
    expect(req.request.method).toBe('GET');
    req.flush({ sub: 'alice', roles: ['admin'], claims: {} });
    expect((await p).sub).toBe('alice');
  });

  it('maps a 401 with the contract error body', async () => {
    const p = api.getOrders();
    http.expectOne('http://api.test/api/orders').flush(
      { error: 'unauthorized', error_description: 'token is expired' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await expect(p).rejects.toEqual({ status: 401, message: 'token is expired', requiredRole: undefined });
  });

  it('maps a 403 including the required role', async () => {
    const p = api.getAdminStats();
    http.expectOne('http://api.test/api/admin/stats').flush(
      { error: 'forbidden', required_role: 'admin' },
      { status: 403, statusText: 'Forbidden' },
    );
    await expect(p).rejects.toMatchObject({ status: 403, message: 'forbidden', requiredRole: 'admin' });
  });

  it('explains status 0 as a network/CORS problem', async () => {
    const p = api.getPublic();
    http.expectOne('http://api.test/api/public').error(new ProgressEvent('error'), { status: 0 });
    await expect(p).rejects.toMatchObject({ status: 0, message: expect.stringContaining('CORS') });
  });
});
