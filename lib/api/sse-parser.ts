/**
 * Shared SSE frame parser.
 *
 * Parses a single SSE text block (lines separated by `\n`, blocks by `\n\n`)
 * into a typed `{ type, data }` object. Used by ChatInterface, EvaluationRunner,
 * and any future SSE consumers.
 */

export interface ParsedSseEvent {
  type: string;
  data: Record<string, unknown>;
}

export function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n');
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / keepalive
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    return { type: eventType, data };
  } catch {
    return null;
  }
}
