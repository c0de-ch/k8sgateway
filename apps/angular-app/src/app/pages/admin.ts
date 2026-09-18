import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiError, ApiService, Order, Stats, isApiError } from '../core/api.service';
import { ApiErrorBanner } from '../shared/api-error';

/** Admin area: /api/admin/stats and /api/admin/orders (role "admin" required by the API). */
@Component({
  selector: 'app-admin',
  imports: [ApiErrorBanner],
  template: `
    <h1>Admin</h1>
    <p class="muted">The route is guarded by <code>roleGuard('admin')</code> for a tidy UI, but the API re-checks the role
      inside the token on every call - a 403 here means the two disagree.</p>

    <app-api-error [error]="error()" />

    @if (stats(); as s) {
      <div class="grid" style="margin-bottom: 1.25rem">
        <div class="card stat"><div class="value">{{ s.orders }}</div><div class="label">orders</div></div>
        <div class="card stat"><div class="value">{{ s.users }}</div><div class="label">users</div></div>
        <div class="card stat"><div class="value">{{ s.uptimeSeconds }}</div><div class="label">API uptime (s)</div></div>
      </div>
    }

    <div class="card">
      <div class="actions" style="justify-content: space-between; margin-top: 0">
        <h2 style="margin: 0">All orders</h2>
        <button class="btn sm" (click)="load()" [disabled]="busy()">Reload</button>
      </div>
      @if (orders(); as list) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Item</th><th>Qty</th><th>Owner</th><th>Created</th></tr></thead>
            <tbody>
              @for (o of list; track o.id) {
                <tr><td class="mono">{{ o.id }}</td><td>{{ o.item }}</td><td>{{ o.quantity }}</td><td>{{ o.owner }}</td><td>{{ o.createdAt }}</td></tr>
              } @empty { <tr><td colspan="5" class="muted">No orders.</td></tr> }
            </tbody>
          </table>
        </div>
      } @else if (busy()) { <p class="muted">Loading&hellip;</p> }
    </div>
  `,
})
export class Admin implements OnInit {
  private readonly api = inject(ApiService);
  readonly stats = signal<Stats | null>(null);
  readonly orders = signal<Order[] | null>(null);
  readonly error = signal<ApiError | null>(null);
  readonly busy = signal(false);

  ngOnInit(): void { void this.load(); }

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const [stats, orders] = await Promise.all([this.api.getAdminStats(), this.api.getAdminOrders()]);
      this.stats.set(stats);
      this.orders.set(orders);
    } catch (e) {
      this.error.set(isApiError(e) ? e : { status: -1, message: String(e) });
    } finally {
      this.busy.set(false);
    }
  }
}
