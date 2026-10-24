// Workers' rate limit binding ({ limit({ key }) → { success } }), in memory:
// a fixed one-minute window per key. One process, so memory is the whole truth.

export class Limiter {
  private readonly windows = new Map<string, { start: number; n: number }>();

  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(key, { start: now, n: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return { success: true };
    }
    w.n++;
    return { success: w.n <= this.perMinute };
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(k);
  }
}
