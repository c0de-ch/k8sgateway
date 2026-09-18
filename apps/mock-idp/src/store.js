// In-memory stores with a TTL: authorization codes, refresh tokens and SSO sessions.
// Single replica only - a restart forgets everything, which is fine for development.

export class TtlStore {
  #entries = new Map();

  set(key, value, ttlSeconds) {
    this.#entries.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
    return value;
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.exp <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** get + delete: makes authorization codes and refresh tokens single-use. */
  take(key) {
    const value = this.get(key);
    this.#entries.delete(key);
    return value;
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  deleteWhere(predicate) {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (predicate(entry.value, key)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.exp <= now) this.#entries.delete(key);
  }

  get size() {
    this.sweep();
    return this.#entries.size;
  }
}

export function createStores() {
  const stores = { codes: new TtlStore(), refreshTokens: new TtlStore(), sessions: new TtlStore() };
  const timer = setInterval(() => Object.values(stores).forEach((s) => s instanceof TtlStore && s.sweep()), 60_000);
  timer.unref();
  stores.close = () => clearInterval(timer);
  return stores;
}
