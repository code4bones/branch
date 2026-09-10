// One completion-scheduled local timer for the PWA document. It deliberately
// has no interval, worker, push, background-sync, socket, or storage handle.
// The adapter supplies a bounded live attempt and decides eligibility.
export interface ContactDiscoverySchedulerPorts {
  now(): number;
  nextDelay(): number | null;
  attempt(): Promise<void>;
}

export class ContactDiscoveryScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #generation = 0;

  start(ports: ContactDiscoverySchedulerPorts): void {
    this.stop();
    this.#stopped = false;
    this.#schedule(ports, 0);
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(ports: ContactDiscoverySchedulerPorts, delay: number): void {
    const generation = this.#generation;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#stopped || generation !== this.#generation) return;
      void (async () => {
        try { await ports.attempt(); } catch { /* absence/failure stays local and is retried only when eligible */ }
        finally {
          if (this.#stopped || generation !== this.#generation) return;
          const next = ports.nextDelay();
          if (next !== null) this.#schedule(ports, Math.max(0, next));
        }
      })();
    }, Math.max(0, delay));
  }
}
