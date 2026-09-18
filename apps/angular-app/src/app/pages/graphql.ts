import { Component, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { AuthService } from '../core/auth.service';
import { GQL, GraphqlResult, GraphqlService } from '../core/graphql.service';

type OpName = keyof typeof GQL;

/** Runs the GraphQL API's queries and mutation with plain fetch + a hand-set Authorization header. */
@Component({
  selector: 'app-graphql',
  imports: [JsonPipe],
  template: `
    <h1>GraphQL</h1>
    <p class="muted">Each button POSTs one operation to <code>graphqlUrl</code>. <code>hello</code> is public,
      <code>me</code> needs a valid token, <code>orders</code>/<code>createOrder</code>/<code>restOrders</code> need the
      role "user" (<code>restOrders</code> relays your token to the REST API) and <code>adminStats</code> needs "admin".
      Errors arrive as <code>extensions.code</code> UNAUTHENTICATED / FORBIDDEN.</p>

    <div class="card">
      <div class="actions">
        @for (op of queries; track op) {
          <button class="btn" (click)="run(op)" [disabled]="busy()">{{ op }}</button>
        }
      </div>
      <form class="row" (submit)="createOrder($event)">
        <label>Item <input name="item" required placeholder="tea" /></label>
        <label>Quantity <input name="quantity" type="number" min="1" value="2" required style="min-width: 6rem" /></label>
        <button class="btn primary" type="submit" [disabled]="busy()">createOrder</button>
      </form>
    </div>

    @if (current(); as op) {
      <div class="card">
        <h2>{{ op }} <span class="badge" [class.ok]="ok()" [class.admin]="!ok()">HTTP {{ result()?.status }}</span></h2>
        <h3>Operation</h3>
        <pre>{{ query }}</pre>
        @if (variables(); as v) { <h3>Variables</h3><pre>{{ v | json }}</pre> }
        <h3>Response</h3>
        <pre>{{ result() | json }}</pre>
      </div>
    }
  `,
})
export class Graphql {
  private readonly gql = inject(GraphqlService);
  readonly auth = inject(AuthService);
  readonly queries: OpName[] = ['hello', 'me', 'orders', 'restOrders', 'adminStats'];

  readonly current = signal<OpName | null>(null);
  readonly variables = signal<Record<string, unknown> | null>(null);
  readonly result = signal<GraphqlResult | null>(null);
  readonly busy = signal(false);
  readonly ok = () => {
    const r = this.result();
    return !!r && r.status === 200 && !r.errors?.length;
  };
  get query(): string {
    const op = this.current();
    return op ? GQL[op] : '';
  }

  async run(op: OpName, variables: Record<string, unknown> | null = null): Promise<void> {
    this.busy.set(true);
    this.current.set(op);
    this.variables.set(variables);
    this.result.set(await this.gql.run(GQL[op], variables ?? {}));
    this.busy.set(false);
  }

  createOrder(ev: SubmitEvent): void {
    ev.preventDefault();
    const data = new FormData(ev.target as HTMLFormElement);
    void this.run('createOrder', { item: String(data.get('item') ?? ''), quantity: Number(data.get('quantity') ?? 1) });
  }
}
