/**
 * Extract a `workflow-definition` fenced code block from assistant text
 * and return the raw JSON string if it contains a valid workflow shape.
 */
export function extractWorkflowDefinition(text: string): string | null {
  const match = /```workflow-definition\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) return null;

  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'steps' in parsed &&
      Array.isArray((parsed as Record<string, unknown>).steps)
    ) {
      return match[1];
    }
  } catch {
    // Invalid JSON — ignore
  }
  return null;
}
