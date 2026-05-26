declare module 'jsdom' {
  interface JSDOMOptions {
    url?: string;
    contentType?: string;
    referrer?: string;
    runScripts?: 'dangerously' | 'outside-only';
    resources?: 'usable';
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string | Buffer, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
  }
}
