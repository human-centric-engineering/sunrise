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

    parse(): Promise<void>;
    getChapterRaw(chapterId: string): Promise<string>;
  }

  export default EPub;
}
