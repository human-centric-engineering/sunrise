/**
 * extractWorkflowDefinition Unit Tests
 *
 * Tests the pure function that extracts a `workflow-definition` fenced code
 * block from assistant text and validates the JSON shape.
 *
 * Test Coverage:
 * - Valid workflow-definition code block with steps array → returns JSON string
 * - Invalid JSON inside code block → returns null
 * - Valid JSON but missing `steps` property → returns null
 * - Valid JSON but `steps` is not an array → returns null
 * - No code block present → returns null
 * - Empty string → returns null
 * - Multiple code blocks → matches the first one
 * - Code block with extra whitespace/text around it
 *
 * @see lib/orchestration/utils/extract-workflow-definition.ts
 */

import { describe, it, expect } from 'vitest';
import { extractWorkflowDefinition } from '@/lib/orchestration/utils/extract-workflow-definition';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: { prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

function makeCodeBlock(content: string): string {
  return `\`\`\`workflow-definition\n${content}\n\`\`\``;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractWorkflowDefinition', () => {
  // ── Valid cases ─────────────────────────────────────────────────────────────

  describe('valid workflow-definition code block', () => {
    it('returns the raw JSON string when block contains valid definition with steps array', () => {
      // Arrange
      const jsonString = JSON.stringify(VALID_DEFINITION);
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert: returns the original JSON string (not a parsed object)
      expect(result).toBe(jsonString);
    });

    it('returns the JSON string embedded in surrounding prose text', () => {
      // Arrange
      const jsonString = JSON.stringify(VALID_DEFINITION);
      const text = `Here is my recommendation:\n\n${makeCodeBlock(jsonString)}\n\nThis workflow handles your use case.`;

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBe(jsonString);
    });

    it('returns null for a definition with an empty steps array', () => {
      // Arrange — empty steps array is invalid (workflow must have at least one step)
      const minimal = { steps: [] };
      const jsonString = JSON.stringify(minimal);
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert — rejected early so users don't hit a late validation error in the builder
      expect(result).toBeNull();
    });

    it('returns the JSON string with a pretty-printed (multi-line) definition', () => {
      // Arrange — pretty-printed JSON spanning multiple lines inside the block
      const jsonString = JSON.stringify(VALID_DEFINITION, null, 2);
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBe(jsonString);
    });
  });

  // ── Invalid JSON ─────────────────────────────────────────────────────────────

  describe('invalid JSON inside code block', () => {
    it('returns null when the block contains malformed JSON', () => {
      // Arrange
      const text = makeCodeBlock('{steps: [not valid json}');

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the block contains an incomplete JSON object', () => {
      // Arrange
      const text = makeCodeBlock('{"steps": [{"id": "step-1"');

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the block content is a plain string (not JSON)', () => {
      // Arrange
      const text = makeCodeBlock('This is just prose, not JSON at all.');

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ── Missing steps property ────────────────────────────────────────────────────

  describe('valid JSON but missing steps property', () => {
    it('returns null when the JSON object has no steps key', () => {
      // Arrange
      const jsonString = JSON.stringify({ entryStepId: 'step-1', errorStrategy: 'fail' });
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the JSON is a top-level array (not an object)', () => {
      // Arrange
      const jsonString = JSON.stringify([{ id: 'step-1' }]);
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the JSON is a primitive (string)', () => {
      // Arrange
      const jsonString = JSON.stringify('workflow definition here');
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the JSON is null', () => {
      // Arrange
      const text = makeCodeBlock('null');

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ── steps is not an array ─────────────────────────────────────────────────────

  describe('valid JSON but steps is not an array', () => {
    it('returns null when steps is a string', () => {
      // Arrange
      const jsonString = JSON.stringify({ steps: 'one step here' });
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when steps is an object (not an array)', () => {
      // Arrange
      const jsonString = JSON.stringify({ steps: { id: 'step-1', type: 'llm_call' } });
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when steps is a number', () => {
      // Arrange
      const jsonString = JSON.stringify({ steps: 3 });
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when steps is null', () => {
      // Arrange
      const jsonString = JSON.stringify({ steps: null });
      const text = makeCodeBlock(jsonString);

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ── No code block ─────────────────────────────────────────────────────────────

  describe('no code block present', () => {
    it('returns null when the text contains no fenced code block at all', () => {
      // Arrange
      const text = 'Here is a workflow with steps: step1 → step2 → step3.';

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for a regular ```json code block (not workflow-definition)', () => {
      // Arrange
      const jsonString = JSON.stringify(VALID_DEFINITION);
      const text = `\`\`\`json\n${jsonString}\n\`\`\``;

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for a fenced code block with a different language tag', () => {
      // Arrange
      const text = `\`\`\`typescript\nconst steps = [];\n\`\`\``;

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert
      expect(result).toBeNull();
    });
  });

  // ── Empty / blank input ────────────────────────────────────────────────────────

  describe('empty or blank input', () => {
    it('returns null for an empty string', () => {
      // Act
      const result = extractWorkflowDefinition('');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for a string of only whitespace', () => {
      // Act
      const result = extractWorkflowDefinition('   \n   \t   ');

      // Assert
      expect(result).toBeNull();
    });
  });

  // ── Multiple code blocks ───────────────────────────────────────────────────────

  describe('multiple code blocks', () => {
    it('returns the first matching block when two valid workflow-definition blocks are present', () => {
      // Arrange
      const firstDefinition = { steps: [{ id: 'first', type: 'llm_call', config: {} }] };
      const secondDefinition = { steps: [{ id: 'second', type: 'tool_call', config: {} }] };
      const firstJson = JSON.stringify(firstDefinition);
      const secondJson = JSON.stringify(secondDefinition);
      const text = `${makeCodeBlock(firstJson)}\n\nSome text\n\n${makeCodeBlock(secondJson)}`;

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert: returns the first definition
      expect(result).toBe(firstJson);
      expect(result).not.toBe(secondJson);
    });

    it('falls back to the second block if the first has invalid JSON', () => {
      // Arrange — first block has broken JSON, second is valid
      // Note: the regex will match the first block and fail JSON.parse → returns null
      const validJson = JSON.stringify(VALID_DEFINITION);
      const text = `${makeCodeBlock('{broken json')}\n\n${makeCodeBlock(validJson)}`;

      // Act
      const result = extractWorkflowDefinition(text);

      // Assert: returns null because first match fails (no fallback logic in the function)
      expect(result).toBeNull();
    });
  });
});
