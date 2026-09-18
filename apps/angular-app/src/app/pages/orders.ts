import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiError, ApiService, Order, isApiError } from '../core/api.service';
import { ApiErrorBanner } from '../shared/api-error';

/** GET/POST /api/orders on the REST API (role "user" required by the API). */
@Component({
  selector: 'app-orders',
  imports: [ApiErrorBanner],
  template: `
    <h1>Orders</h1>
    <p class="muted">Calls <code>GET</code> and <code>POST /api/orders</code> through HttpClient;
      the interceptor adds the bearer token because the URL starts with <code>apiUrl</code>.</p>

    <app-api-error [error]="error()" />

    <div class="card">
      <h2>New order</h2>
      <form class="row" (submit)="create($event)">
        <label>Item <input name="item" required placeholder="coffee beans" /></label>
        <label>Quantity <input name="quantity" type="number" min="1" value="1" required style="min-width: 6rem" /></label>
        <button class="btn primary" type="submit" [disabled]="busy()">Create</button>
      </form>
    </div>

    <div class="card">
      <div class="actions" style="justify-content: space-between; margin-top: 0">
        <h2 style="margin: 0">Your orders</h2>
        <button class="btn sm" (click)="load()" [disabled]="busy()">Reload</button>
      </div>
      @if (orders(); as list) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Item</th><th>Qty</th><th>Owner</th><th>Created</th></tr></thead>
            <tbody>
              @for (o of list; track o.id) {
                <tr><td class="mono">{{ o.id }}</td><td>{{ o.item }}</td><td>{{ o.quantity }}</td><td>{{ o.owner }}</td><td>{{ o.createdAt }}</td></tr>
              } @empty { <tr><td colspan="5" class="muted">No orders yet.</td></tr> }
            </tbody>
          </table>
        </div>
      } @else if (busy()) { <p class="muted">Loading&hellip;</p> }
    </div>
  `,
})
export class Orders implements OnInit {
  readonly api = inject(ApiService);
  readonly orders = signal<Order[] | null>(null);
  readonly error = signal<ApiError | null>(null);
  readonly busy = signal(false);

  ngOnInit(): void { void this.load(); }

  async load(): Promise<void> {
    await this.guard(async () => this.orders.set(await this.api.getOrders()));
  }

  async create(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const data = new FormData(form);
    const item = String(data.get('item') ?? '').trim();
    const quantity = Number(data.get('quantity') ?? 1);
    if (!item) return;
    await this.guard(async () => {
      await this.api.createOrder(item, quantity);
      form.reset();
      this.orders.set(await this.api.getOrders());
    });
  }

  /** Runs an API call and maps failures to the banner. */
  private async guard(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(isApiError(e) ? e : { status: -1, message: String(e) });
    } finally {
      this.busy.set(false);
    }
  }
}
