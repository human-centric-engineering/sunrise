/**
 * Regression guard for the inbound-trigger starter workflow definition.
 *
 * The "Create a workflow (pre-filled for inbound)" CTA on
 * `/admin/orchestration/triggers/new` encodes
 * `INBOUND_TRIGGER_STARTER_DEFINITION` into the `?definition=` query
 * param the workflow new page consumes. The workflow new page silently
 * falls back to an empty builder when the encoded definition fails
 * `workflowDefinitionSchema.safeParse` — so a future edit that pushes a
 * field past its constraint (e.g. step description > 500 chars) would
 * silently break the pre-fill without any test failure.
 *
 * @see lib/orchestration/admin/inbound-trigger-starter.ts
 */

import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import {
  INBOUND_TRIGGER_STARTER_DEFINITION,
  INBOUND_TRIGGER_STARTER_HREF,
} from '@/lib/orchestration/admin/inbound-trigger-starter';

describe('INBOUND_TRIGGER_STARTER_DEFINITION', () => {
  it('parses clean against workflowDefinitionSchema (no silent fallback to empty builder)', () => {
    const result = workflowDefinitionSchema.safeParse(INBOUND_TRIGGER_STARTER_DEFINITION);
    if (!result.success) {
      throw new Error(
        `Starter definition failed schema validation — the workflow new page would silently render an empty builder. Errors: ${JSON.stringify(result.error.flatten(), null, 2)}`
      );
    }
    expect(result.success).toBe(true);
  });

  it('keeps the step description under the 500-char schema cap', () => {
    const desc = INBOUND_TRIGGER_STARTER_DEFINITION.steps[0].description ?? '';
    expect(desc.length).toBeLessThanOrEqual(500);
  });

  it('uses chat_turn so multi-turn conversation context loads automatically', () => {
    // The starter ships chat_turn (not llm_call) so out-of-the-box the
    // agent sees the full conversation history on every fire — no
    // `tool_call`-to-load-history workaround needed. Catches a future
    // edit that silently regresses to llm_call.
    expect(INBOUND_TRIGGER_STARTER_DEFINITION.steps[0].type).toBe('chat_turn');
  });

  it('reads canonical inbound trigger fields the adapters always set', () => {
    // Workflows pre-wired for inbound MUST consume the same fields the
    // inbound route writes into `payload` + `triggerMeta`. If someone
    // renames trigger.text → trigger.message in the adapters (or breaks
    // the conversationId injection in the route handler), the starter
    // silently produces empty strings — catch that here.
    const step = INBOUND_TRIGGER_STARTER_DEFINITION.steps[0];
    const config = step.config as { message?: unknown; conversationId?: unknown };
    expect(config.message).toBe('{{trigger.text}}');
    expect(config.conversationId).toBe('{{trigger.conversationId}}');
  });
});

describe('INBOUND_TRIGGER_STARTER_HREF', () => {
  it('points at the workflow new page with a `definition` query param', () => {
    expect(INBOUND_TRIGGER_STARTER_HREF).toMatch(
      /^\/admin\/orchestration\/workflows\/new\?definition=/
    );
  });

  it('round-trips: decode + parse yields the original definition', () => {
    const param = INBOUND_TRIGGER_STARTER_HREF.split('?definition=')[1];
    if (!param) throw new Error('href is missing the definition param');
    const decoded = JSON.parse(decodeURIComponent(param));
    expect(decoded).toEqual(INBOUND_TRIGGER_STARTER_DEFINITION);
  });
});
