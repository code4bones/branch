export const maximumPocBurstMessages = 16;
export const pocBurstIntervalMs = 300;

export interface PocBurstTimerPort {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface PocBurstProgress {
  readonly session: number;
  readonly sent: number;
  readonly total: number;
  readonly running: boolean;
}

/**
 * Bounded, endpoint-local pacing for an explicitly user-started PoC burst.
 * It neither changes outbox behaviour nor remembers message content: each
 * emitted item simply enters the ordinary user-owned message composition path.
 */
export class PocBurstRunner {
  readonly #timers: PocBurstTimerPort;
  #timer: unknown = null;
  #running = false;
  #session = 0;
  #activeSession = 0;
  #sent = 0;
  #total = 0;
  #onProgress: ((progress: PocBurstProgress) => void) | null = null;

  constructor(timers: PocBurstTimerPort) {
    this.#timers = timers;
  }

  get running(): boolean { return this.#running; }

  start(count: number, emit: (session: number, index: number, total: number) => void, onProgress: (progress: PocBurstProgress) => void): boolean {
    if (this.#running || !Number.isSafeInteger(count) || count < 1 || count > maximumPocBurstMessages) return false;
    this.#running = true;
    this.#activeSession = this.#session + 1;
    this.#session = this.#activeSession;
    this.#sent = 0;
    this.#total = count;
    this.#onProgress = onProgress;
    this.#next(emit);
    return true;
  }

  stop(): void {
    if (!this.#running) return;
    if (this.#timer !== null) this.#timers.cancel(this.#timer);
    this.#timer = null;
    this.#running = false;
    this.#report();
    this.#onProgress = null;
  }

  #next(emit: (session: number, index: number, total: number) => void): void {
    if (!this.#running) return;
    this.#sent += 1;
    emit(this.#activeSession, this.#sent, this.#total);
    if (this.#sent >= this.#total) {
      this.#timer = null;
      this.#running = false;
      this.#report();
      this.#onProgress = null;
      return;
    }
    this.#report();
    this.#timer = this.#timers.schedule(() => {
      this.#timer = null;
      this.#next(emit);
    }, pocBurstIntervalMs);
  }

  #report(): void {
    this.#onProgress?.({ session: this.#activeSession, sent: this.#sent, total: this.#total, running: this.#running });
  }
}

export const browserPocBurstTimers: PocBurstTimerPort = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
};
