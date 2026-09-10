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
  #running = false;
  #ports: ContactDiscoverySchedulerPorts | null = null;

  start(ports: ContactDiscoverySchedulerPorts): void {
    this.stop();
    this.#stopped = false;
    this.#ports = ports;
    if (!this.#running) this.#schedule(ports, 0);
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#ports = null;
  }

  // A UI change may make a row immediately eligible. It never starts another
  // attempt while the prior one is awaiting completion; that invocation alone
  // owns re-arming the timeout.
  wake(): void {
    if (this.#stopped || this.#running || this.#ports === null) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#schedule(this.#ports, 0);
  }

  #schedule(ports: ContactDiscoverySchedulerPorts, delay: number): void {
    const generation = this.#generation;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#stopped || generation !== this.#generation) return;
      if (this.#running) return;
      this.#running = true;
      void (async () => {
        try { await ports.attempt(); } catch { /* absence/failure stays local and is retried only when eligible */ }
        finally {
          this.#running = false;
          if (!this.#stopped && generation !== this.#generation && this.#ports !== null) {
            this.#schedule(this.#ports, 0);
          } else if (!this.#stopped && generation === this.#generation) {
            const next = ports.nextDelay();
            if (next !== null) this.#schedule(ports, Math.max(0, next));
          }
        }
      })();
    }, Math.max(0, delay));
  }
}
