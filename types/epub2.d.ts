/**
 * Hand-written types for `epub2@3.0.2`.
 *
 * The package ships its own `.d.ts`, but they are unusable here: they
 * `import Promise from 'bluebird'` and `xml2js`, neither of which ships or has
 * installed typings, so every signature that touches them degrades to `any` —
 * and `recommendedTypeChecked`'s `no-unsafe-*` rules reject that. Hence this
 * shadow declaration.
 *
 * **It must describe the library as it actually behaves.** The previous version
 * declared `parse(): Promise<void>` and `getChapterRaw(id): Promise<string>`.
 * Neither is true — both are callback-driven and return `this` / `void` — and
 * the untruth was not cosmetic: `@typescript-eslint/await-thenable` (an error
 * under `recommendedTypeChecked`) exists to catch `await` on a non-thenable,
 * and this file is the only reason it stayed silent on `await epub.parse()`.
 * The parser therefore read `metadata`, `flow` and `toc` one microtask into a
 * parse that had not started, and returned an empty document for every EPUB
 * ever ingested, with no warning (#606).
 *
 * So: if you add a member here, copy its shape from
 * `node_modules/epub2/index.d.ts` and `lib/epub.d.ts` rather than from what
 * would be convenient at the call site. A wrong signature here switches off the
 * only check that can see the mistake.
 */
declare module 'epub2' {
  interface Chapter {
    id: string;
    title?: string;
    order?: number;
  }

  interface Metadata {
    title?: string;
    creator?: string;
    description?: string;
    language?: string;
    publisher?: string;
    date?: string;
  }

  class EPub {
    constructor(epubPath: string);

    metadata: Metadata;
    flow: Chapter[];
    toc: Array<{ id: string; title: string; order: number }>;

    /**
     * Begins parsing and returns the instance — NOT a promise. Completion is
     * signalled by the `end` event. Awaiting this resolves immediately, while
     * `metadata` / `flow` / `toc` are all still empty. Use
     * {@link EPub.createAsync} instead.
     */
    parse(): this;

    /** Callback-style. The promise-returning form is `getChapterRawAsync`. */
    getChapterRaw(chapterId: string, callback: (error: Error | null, text?: string) => void): void;

    /** Promise-returning chapter fetch — the raw XHTML, unprocessed. */
    getChapterRawAsync(chapterId: string): Promise<string>;

    /**
     * Construct and parse in one step, resolving only once the `end` event has
     * fired. This is the entry point to use; it is the only one that
     * guarantees the instance is populated when you read it.
     */
    static createAsync(epubPath: string): Promise<EPub>;
  }

  export default EPub;
}
