import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { App } from './app';
import { ConfigService } from './core/config.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideOAuthClient()],
    }).compileComponents();
    TestBed.inject(ConfigService).set({
      idpName: 'Test IdP', issuer: 'http://idp.test', clientId: 'angular-app', scope: 'openid',
      apiUrl: 'http://api.test', graphqlUrl: 'http://graphql.test/graphql', rolesClaim: 'roles',
    });
  });

  it('renders the IdP name and a Login button when signed out', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.badge.idp')?.textContent).toContain('Test IdP');
    expect(el.querySelector('.user button')?.textContent).toContain('Login');
    expect(el.querySelector('a[href="/admin"]')).toBeNull();
  });
});
