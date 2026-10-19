// The one Workers runtime module the Hub shell imports (the rest of the package is plain TypeScript, so it runs in Node too).
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: import('./runtime.js').HubState, env: Env);
    protected ctx: import('./runtime.js').HubState;
    protected env: Env;
  }
}
