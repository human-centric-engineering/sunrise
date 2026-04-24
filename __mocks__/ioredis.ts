/**
 * Manual mock for ioredis (optional peer dependency).
 *
 * ioredis is not installed in this project — it is only required at runtime
 * when `RATE_LIMIT_STORE=redis` is configured. This stub allows the
 * RedisRateLimitStore to be imported and tested in unit tests without a
 * real Redis connection.
 *
 * Tests configure mock behaviour by mutating the exported `ioredisState`
 * object before constructing a RedisRateLimitStore instance.
 */

/** Mutable state that tests can configure to control mock behaviour. */
export interface IoredisState {
  /** Queue of values to return from eval() calls (FIFO). Falls back to 1. */
  evalResults: unknown[];
  /** Registered event handlers — populated by the mock client's on() calls. */
  onHandlers: Record<string, (err: Error) => void>;
  /** When true, the Redis constructor throws instead of returning a client. */
  constructorShouldThrow: boolean;
  /** When set, the next eval() call rejects with this error instead of resolving. */
  evalShouldReject: Error | null;
}

export const ioredisState: IoredisState = {
  evalResults: [],
  onHandlers: {},
  constructorShouldThrow: false,
  evalShouldReject: null,
};

const mockClient = {
  eval: (..._args: unknown[]) => {
    if (ioredisState.evalShouldReject) {
      const err = ioredisState.evalShouldReject;
      ioredisState.evalShouldReject = null;
      return Promise.reject(err);
    }
    const result = ioredisState.evalResults.length > 0 ? ioredisState.evalResults.shift() : 1;
    return Promise.resolve(result);
  },
  del: (_key: string) => Promise.resolve(1 as unknown),
  on: (event: string, cb: (err: Error) => void) => {
    ioredisState.onHandlers[event] = cb;
  },
};

// Must be a regular function (not arrow) so it can be called with `new`.
// When a constructor function returns an object, `new` returns that object.
function Redis(this: unknown, url: string, _options?: unknown): typeof mockClient {
  if (ioredisState.constructorShouldThrow) {
    throw new Error(`ioredis constructor failed for ${url}`);
  }
  return mockClient;
}

export default Redis;
