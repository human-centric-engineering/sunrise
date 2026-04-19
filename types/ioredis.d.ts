declare module 'ioredis' {
  interface RedisOptions {
    maxRetriesPerRequest?: number;
    enableReadyCheck?: boolean;
    lazyConnect?: boolean;
  }

  class Redis {
    constructor(url: string, options?: RedisOptions);
    on(event: string, callback: (err: Error) => void): void;
    eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
    del(key: string): Promise<number>;
    disconnect(): void;
  }

  export default Redis;
}
