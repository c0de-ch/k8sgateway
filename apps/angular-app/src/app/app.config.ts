import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { OAuthModuleConfig, OAuthStorage, provideOAuthClient } from 'angular-oauth2-oidc';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { ConfigService } from './core/config.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),

    // withInterceptorsFromDi() is REQUIRED: angular-oauth2-oidc registers its Bearer-token interceptor
    // through the class-based HTTP_INTERCEPTORS token; plain provideHttpClient() would silently skip it.
    provideHttpClient(withInterceptorsFromDi()),
    provideOAuthClient(),

    // Which URLs may receive the access token is only known once config.json is loaded, so the
    // resource-server config is provided lazily (this overrides the static value set by provideOAuthClient).
    // Never send the token to arbitrary hosts - that is what the allow-list protects against.
    {
      provide: OAuthModuleConfig,
      useFactory: (): OAuthModuleConfig => {
        const config = inject(ConfigService);
        return { resourceServer: { sendAccessToken: true, customUrlValidation: (url) => config.isApiUrl(url) } };
      },
    },

    // Token storage trade-off: the library defaults to sessionStorage (per tab, gone when the tab closes).
    // localStorage keeps the session across reloads and tabs, but the refresh token then lives in the
    // browser profile and is readable by any script running on this origin (XSS). Acceptable for the
    // demo; the Next.js app shows the BFF pattern where tokens never reach the browser at all.
    { provide: OAuthStorage, useFactory: () => localStorage },

    // Runs before the first route: load config.json, then discovery + (on /callback) the code exchange.
    provideAppInitializer(async () => {
      const auth = inject(AuthService);
      try {
        await auth.init(await inject(ConfigService).load());
      } catch (e) {
        auth.error.set(e instanceof Error ? e.message : String(e));
      }
    }),
  ],
};
