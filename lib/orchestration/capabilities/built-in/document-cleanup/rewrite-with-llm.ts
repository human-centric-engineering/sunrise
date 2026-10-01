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
import { getDocumentSizeReport } from '@/lib/orchestration/knowledge/size-report';

const schema = z.object({
  instructions: z.string().min(1).max(2000),
});

type Args = z.infer<typeof schema>;

interface Data {
  pendingChangeId: string;
  instructions: string;
  inputTokens: number;
  outputTokens: number;
  summary: {
    charsBefore: number;
    charsAfter: number;
    deltaPct: number;
  };
  /** Human guidance for the agent: don't claim the rewrite is applied yet. */
  status: 'pending_human_review';
}

const SYSTEM_PROMPT = `You are a document cleanup assistant. The user will give you a document and instructions for how to clean it up. Apply the instructions faithfully and return ONLY the cleaned document — no preamble, no commentary, no markdown code fences. Preserve the document's meaning and factual content. Remove only what the instructions specify or clear noise (filler words, repetition, formatting artefacts) the instructions imply.`;

export class RewriteWithLlmCapability extends BaseCapability<Args, Data> {
  readonly slug = 'rewrite_with_llm';
  protected readonly schema = schema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'rewrite_with_llm',
    description:
      'Use an LLM to rewrite the entire document according to natural-language instructions (e.g. "remove filler words and tighten verbose sentences"). Expensive — consumes tokens proportional to document length. Refuses when document is too large (size class "too-large"); run deterministic strips first or use rewrite_section_with_llm.',
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description:
            'What to do with the document. Plain natural language. Be specific (e.g. "remove all filler words like um, uh, you know") — vague instructions produce vague results.',
        },
      },
      required: ['instructions'],
    },
  };

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const target = await resolveCleanupTarget(context);
    if (!target) return this.error('Not in a Document Clean Up session.', 'not_cleanup_session');

    const lock = await requireEditableTarget(target.documentId, context.userId);
    if (!lock.ok) {
      return this.error('The document is being edited by another admin.', 'target_locked');
    }

    const size = getDocumentSizeReport(target.content);
    if (!size.llmRewriteAllowed) {
      return this.error(
        `Document is too large for whole-doc LLM rewrite (${size.tokenCount} tokens, class ${size.sizeClass}). Use deterministic capabilities or rewrite_section_with_llm on individual sections.`,
        'document_too_large'
      );
    }

    const agent = await prisma.aiAgent.findUnique({
      where: { id: context.agentId },
      select: { provider: true, model: true, temperature: true, fallbackProviders: true },
    });
    if (!agent) {
      return this.error('Agent not found.', 'agent_misconfigured');
    }

    // Resolve through the same seam the chat loop uses. Reading
    // agent.provider/model directly would fail on every default install: the
    // cleanup agent is seeded with both fields EMPTY so it inherits whatever
    // provider the install is configured with, which made this capability —
    // and the whole LLM half of Document Clean Up — permanently unavailable.
    let binding;
    try {
      binding = await resolveAgentProviderAndModel(agent, 'chat');
    } catch (err) {
      logger.error('rewrite_with_llm: no usable provider binding', { err });
      return this.error(
        'No LLM provider is configured for this install, so an LLM rewrite is not available. Deterministic cleanups still work.',
        'agent_misconfigured'
      );
    }

    let provider;
    try {
      provider = await getProvider(binding.providerSlug, primaryCallContext(binding.provenance));
    } catch (err) {
      logger.error('rewrite_with_llm: provider load failed', { err, slug: binding.providerSlug });
      return this.error(`Provider "${binding.providerSlug}" unavailable.`, 'provider_unavailable');
    }

    const response = await provider.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `INSTRUCTIONS:\n${args.instructions}\n\n---\nDOCUMENT:\n${target.content}`,
        },
      ],
      { model: binding.model, temperature: agent.temperature ?? 0.2 }
    );

    const next = response.content.trim();
    if (next.length === 0) {
      return this.error('LLM returned empty content.', 'empty_response');
    }

    // Mixed agent/human model: LLM rewrites no longer auto-apply. We write a
    // pending change for the admin to Accept or Reject via the diff card the
    // chat surface renders against this capability_result event.
    const pending = await prisma.aiKnowledgeDocumentPendingChange.create({
      data: {
        documentId: target.documentId,
        source: 'rewrite_with_llm',
        beforeContent: target.content,
        afterContent: next,
        instructions: args.instructions,
        actorId: context.userId ?? null,
      },
    });

    const charsBefore = target.content.length;
    const charsAfter = next.length;
    return this.success({
      pendingChangeId: pending.id,
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
