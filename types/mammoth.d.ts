declare module 'mammoth' {
  interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  interface InputOptions {
    buffer: Buffer;
  }

  export function convertToMarkdown(input: InputOptions): Promise<ConvertResult>;
  export function extractRawText(input: InputOptions): Promise<ConvertResult>;
}
