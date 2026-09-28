/**
 * idempotencyStore.ts
 *
 * In-memory idempotency tracker for processed message IDs.
 *
 * RabbitMQ guarantees at-least-once delivery — the same message can be
 * redelivered after a consumer crash or network glitch. This store lets the
 * consumer safely detect and skip duplicate deliveries.
 *
 * Design decisions:
 *  - Uses a plain JS `Set` (insertion-ordered) so we can evict the oldest
 *    entry when the store reaches capacity, acting as a sliding window.
 *  - Single-instance scope: the store lives in process memory.
 *    If you scale to multiple worker instances, replace this with a shared
 *    store (e.g., Redis SETNX with TTL) behind the same interface.
 *  - Default capacity: 10,000 IDs ≈ ~400 KB at 40 bytes/UUID.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyStoreOptions {
  /** Maximum number of message IDs kept in memory. Default: 10_000 */
  maxSize?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class IdempotencyStore {
  private readonly store: Set<string>;
  private readonly maxSize: number;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.maxSize = options.maxSize ?? 10_000;
    this.store   = new Set<string>();
  }

  /**
   * Returns `true` if this `messageId` has already been marked as processed.
   */
  has(messageId: string): boolean {
    return this.store.has(messageId);
  }

  /**
   * Marks `messageId` as processed.
   * If the store is at capacity, the oldest entry is evicted first (FIFO).
   */
  mark(messageId: string): void {
    if (this.store.has(messageId)) {
      return; // already present, no-op
    }

    if (this.store.size >= this.maxSize) {
      // Evict the first (oldest) entry — Set iteration follows insertion order
      const oldest = this.store.values().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.add(messageId);
  }

  /**
   * Returns the current number of tracked message IDs.
   * Exposed for testing and health-check purposes.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clears all tracked IDs. Intended for tests only.
   */
  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton instance shared across the application
// ---------------------------------------------------------------------------

export const idempotencyStore = new IdempotencyStore();
