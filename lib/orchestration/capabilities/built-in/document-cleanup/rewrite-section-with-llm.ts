import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { primaryCallContext } from '@/lib/orchestration/llm/provider-eligibility';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { resolveCleanupTarget } from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';
import { requireEditableTarget } from '@/lib/orchestration/knowledge/edit-lock';

const schema = z.object({
  sectionMarker: z.string().min(1).max(200),
  instructions: z.string().min(1).max(2000),
});

type Args = z.infer<typeof schema>;

interface Data {
  pendingChangeId: string;
  sectionMarker: string;
  instructions: string;
  inputTokens: number;
  outputTokens: number;
  summary: {
    charsBefore: number;
    charsAfter: number;
    deltaPct: number;
  };
  status: 'pending_human_review';
}

const SYSTEM_PROMPT = `You are a document cleanup assistant. You will be given ONE section of a document and instructions for how to clean it up. Apply the instructions faithfully and return ONLY the cleaned section — no preamble, no commentary, no markdown code fences. Do not add or restate the section heading; just return the cleaned body text.`;

// Find the body of the section whose heading-line contains the marker.
// Returns [matchStart, bodyStart, bodyEnd] or null. Heading lines are Markdown
// headings (#, ##, ...) or lines composed entirely of the marker text.
function findSection(
  content: string,
  marker: string
): { headingLine: string; bodyStart: number; bodyEnd: number } | null {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeading = /^#{1,6}\s/.test(line) || line.trim() === marker;
    if (isHeading && line.includes(marker)) {
      const bodyStart = offset + line.length + 1;
      let bodyEnd = content.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,6}\s/.test(lines[j])) {
          bodyEnd = bodyStart + lines.slice(i + 1, j).join('\n').length;
          break;
        }
      }
      return { headingLine: line, bodyStart, bodyEnd };
    }
    offset += line.length + 1;
  }
  return null;
}

export class RewriteSectionWithLlmCapability extends BaseCapability<Args, Data> {
  readonly slug = 'rewrite_section_with_llm';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'rewrite_section_with_llm',
    description:
      'Use an LLM to rewrite a single section of the document. The section is located by finding a Markdown heading (or standalone line) that contains the given marker text. Works even when the whole document is too large for rewrite_with_llm because only the matched section is sent to the LLM.',
    parameters: {
      type: 'object',
      properties: {
        sectionMarker: {
          type: 'string',
          description:
            'Text used to locate the section heading (case-sensitive substring match against heading lines).',
        },
        instructions: {
          type: 'string',
          description: 'What to do with the matched section. Plain natural language.',
        },
      },
      required: ['sectionMarker', 'instructions'],
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');

    const lock = await requireEditableTarget(target.documentId, context.userId);
    if (!lock.ok) {
      return this.error('The document is being edited by another admin.', 'target_locked');
    }

    const located = findSection(target.content, args.sectionMarker);
    if (!located) {
      return this.error(
        `No heading containing "${args.sectionMarker}" found in the document.`,
        'section_not_found'
      );
    }

    const agent = await prisma.aiAgent.findUnique({
      where: { id: context.agentId },
      select: { provider: true, model: true, temperature: true, fallbackProviders: true },
    });
    if (!agent) {
      return this.error('Agent not found.', 'agent_misconfigured');
    }

    // Same resolver the chat loop uses — see the note in rewrite-with-llm.ts:
    // the cleanup agent ships with provider/model empty by design, so reading
    // the row directly made this path dead on every default install.
    let binding;
    try {
      binding = await resolveAgentProviderAndModel(agent, 'chat');
    } catch (err) {
      logger.error('rewrite_section_with_llm: no usable provider binding', { err });
      return this.error(
        'No LLM provider is configured for this install, so an LLM rewrite is not available. Deterministic cleanups still work.',
        'agent_misconfigured'
      );
    }

    const sectionBody = target.content.slice(located.bodyStart, located.bodyEnd);

    let provider;
    try {
      provider = await getProvider(binding.providerSlug, primaryCallContext(binding.provenance));
    } catch (err) {
      logger.error('rewrite_section_with_llm: provider load failed', {
        err,
        slug: binding.providerSlug,
      });
      return this.error(`Provider "${binding.providerSlug}" unavailable.`, 'provider_unavailable');
    }

    const response = await provider.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `INSTRUCTIONS:\n${args.instructions}\n\n---\nSECTION HEADING:\n${located.headingLine}\n\nSECTION BODY:\n${sectionBody}`,
        },
      ],
      { model: binding.model, temperature: agent.temperature ?? 0.2 }
    );

    const rewritten = response.content.trim();
    if (rewritten.length === 0) {
      return this.error('LLM returned empty content.', 'empty_response');
    }

    // Whether to re-append a trailing newline depends on the section body
    // being replaced, not the whole document — using the document's overall
    // trailing newline here would insert a duplicate blank line before the
    // next heading on every non-final section of a newline-terminated doc.
    const next =
      target.content.slice(0, located.bodyStart) +
      rewritten +
      (sectionBody.endsWith('\n') ? '\n' : '') +
      target.content.slice(located.bodyEnd);

    // Mixed agent/human model: section LLM rewrites emit a pending change
    // tagged with the sectionMarker so the diff card on the chat surface
    // can scope its preview to the changed section.
    const pending = await prisma.aiKnowledgeDocumentPendingChange.create({
      data: {
        documentId: target.documentId,
        source: 'rewrite_section_with_llm',
        beforeContent: target.content,
        afterContent: next,
        sectionMarker: args.sectionMarker,
        instructions: args.instructions,
        actorId: context.userId ?? null,
      },
    });

    const charsBefore = target.content.length;
    const charsAfter = next.length;
    return this.success({
      pendingChangeId: pending.id,
      sectionMarker: args.sectionMarker,
      instructions: args.instructions,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      status: 'pending_human_review',
      summary: {
        charsBefore,
        charsAfter,
        deltaPct: charsBefore === 0 ? 0 : ((charsAfter - charsBefore) / charsBefore) * 100,
      },
    });
  }
}
