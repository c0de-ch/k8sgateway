import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { ConfigService } from './core/config.service';

/** Application shell: top navigation with the IdP name, the user, role badges and Login/Logout. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
})
export class App {
  readonly auth = inject(AuthService);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);

  readonly cfg = this.config.value;
  readonly idpName = computed(() => this.cfg()?.idpName ?? 'IdP');
  readonly year = new Date().getFullYear();

  /** Login from the nav returns to the page the user is looking at. */
  login(): void {
    void this.auth.login(this.router.url === '/callback' ? '/' : this.router.url);
  }
}
