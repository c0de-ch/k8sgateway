/** In-memory order store — demo data only, lives as long as the pod. */
export interface Order {
  id: string;
  item: string;
  quantity: number;
  owner: string;
  createdAt: string;
}

export interface OrderStore {
  list(): Order[];
  create(input: { item: string; quantity: number; owner: string }): Order;
  count(): number;
  /** Number of distinct owners — the "users" figure in adminStats. */
  ownerCount(): number;
}

const seed: Order[] = [
  { id: 'ord-1', item: 'Mechanical keyboard', quantity: 1, owner: 'alice', createdAt: '2026-09-01T09:00:00.000Z' },
  { id: 'ord-2', item: '27" monitor', quantity: 2, owner: 'bob', createdAt: '2026-09-02T10:30:00.000Z' },
  { id: 'ord-3', item: 'USB-C cable', quantity: 3, owner: 'alice', createdAt: '2026-09-03T14:15:00.000Z' },
];

export function createOrderStore(initial: Order[] = seed): OrderStore {
  const orders: Order[] = initial.map((o) => ({ ...o }));
  let next = orders.length + 1;
  return {
    list: () => orders.map((o) => ({ ...o })),
    create: ({ item, quantity, owner }) => {
      const order: Order = { id: `ord-${next++}`, item, quantity, owner, createdAt: new Date().toISOString() };
      orders.push(order);
      return { ...order };
    },
    count: () => orders.length,
    ownerCount: () => new Set(orders.map((o) => o.owner)).size,
  };
}
