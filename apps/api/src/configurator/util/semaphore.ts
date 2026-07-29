/**
 * A tiny async concurrency limiter (spec §8: cap the CPU-bound generation step
 * so one customer's burst can't starve the shared host). Also rejects when the
 * wait queue is saturated, turning an overload into a clean 503 rather than an
 * unbounded backlog.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue = 50,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max && this.queue.length >= this.maxQueue) {
      const err: any = new Error('Generation queue is full, please retry shortly');
      err.status = 503;
      throw err;
    }
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
