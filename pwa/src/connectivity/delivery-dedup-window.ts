export const incomingDeliveryDedupCapacity = 256;

/** Bounded live-session duplicate window for incoming delivery identifiers. */
export class DeliveryDedupWindow {
  private readonly deliveryIds = new Set<string>();

  constructor(private readonly capacity = incomingDeliveryDedupCapacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("delivery dedup capacity must be a positive safe integer");
    }
  }

  /** Reserves an identifier synchronously; returns false when already reserved. */
  reserve(deliveryId: string): boolean {
    if (this.deliveryIds.has(deliveryId)) {
      return false;
    }
    this.deliveryIds.add(deliveryId);
    if (this.deliveryIds.size > this.capacity) {
      const oldest = this.deliveryIds.values().next().value;
      if (typeof oldest === "string") {
        this.deliveryIds.delete(oldest);
      }
    }
    return true;
  }

  reset(): void {
    this.deliveryIds.clear();
  }

  get size(): number {
    return this.deliveryIds.size;
  }
}
