// `cloudflare:workers` exists only inside workerd. The OAuth provider imports
// its base classes to recognise class-style handlers; the core passes plain
// objects, so empty classes are enough.

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const env = {};
