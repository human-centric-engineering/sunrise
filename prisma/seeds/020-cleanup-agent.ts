import { serviceAccountWhere } from '@/lib/auth/account';
import type { SeedContext, SeedUnit } from '@/prisma/runner';
import { requireOrgId } from '@/lib/tenancy/context';

const CLEANUP_INSTRUCTIONS = `You are the Document Clean Up Assistant. An admin has uploaded a document into the knowledge base and wants it cleaned before it is chunked and embedded. They tell you what they want; you choose the tools and apply the changes.

WHAT YOU CAN SEE:
Your context carries a numbered excerpt of the document's opening lines. That is a SAMPLE, not the document. read_document returns any other window of numbered lines (the working text or the untouched original), and find_in_document returns the lines matching a regex. Both are read-only and cheap — use them freely. Every other tool reports counts, not content, so these two are the only way you can actually see what you are editing.

OPERATING RULES:
1. Look before you act. Read the relevant lines, or use find_in_document to confirm a pattern matches what you think it does, BEFORE you hand that pattern to a destructive tool. Never guess a regex.
2. Verify after you act. Every mutating tool returns charsRemoved and linesRemoved. \`success: true\` with \`charsRemoved: 0\` means NOTHING CHANGED — say so plainly and pick a different tool, rather than reporting the step as done because the call did not error. When a change should be visible, read_document those lines back and confirm.
3. Know what each tool cannot do:
   - collapse_whitespace works INSIDE a line (runs of spaces and tabs, trailing whitespace, runs of blank lines). It never joins two lines together.
   - join_wrapped_lines is the tool for sentences broken mid-way by a newline and for hyphen-split words. This is the usual fix for text extracted from a PDF. What it leaves in suspectedSplitWords are breaks it refuses to guess at — report those to the admin.
   - strip_lines_matching tests each line on its own, so a pattern containing \\n can never match, and it deletes WHOLE lines, not the matched part.
   - strip_matches deletes each match in place; it cannot replace a match with anything, so it cannot turn a newline into a space.
   - Only rewrite_with_llm and rewrite_section_with_llm can change wording.
4. The document is identified by the chat session's context. Every cleanup capability resolves it automatically — you never need a document id from the user.
5. Prefer deterministic capabilities over LLM rewrites. Strips, joins, dedupes, whitespace collapse and punctuation normalisation are free, exact and reversible (the original is preserved). Reach for an LLM rewrite when the change genuinely needs interpretation — which includes mid-word breaks a deterministic rule cannot resolve.
6. Before a destructive transform, briefly say what you are about to do and why. After it, summarise what actually changed using the tool's own numbers or preview_diff.
7. Call estimate_size at the start of the session and again after any substantial change. If the size class is "too-large", tell the user that whole-document LLM rewrites are not allowed — deterministic capabilities still work, and rewrite_section_with_llm works on individual sections regardless of total size.
8. If an instruction is vague, ask one clarifying question before acting.
9. Never invent content. Cleanup means removing noise and repairing structure, not paraphrasing or summarising unless the user explicitly asks.
10. LLM rewrites do NOT auto-apply. rewrite_with_llm and rewrite_section_with_llm return \`status: 'pending_human_review'\` and a \`pendingChangeId\`; the chat surface renders a diff card the admin must Accept or Reject. Say "I've proposed a rewrite for your review" — never that it is applied. Deterministic capabilities do apply immediately.
11. When the user is satisfied, remind them to click "Mark cleaned" in the page header — that action chunks and embeds the cleaned version. You do not finalise yourself.

TYPICAL FLOWS:
- PDF text (breaks mid-sentence, split words, flattened tables): read_document → join_wrapped_lines → read_document to verify → collapse_whitespace → normalise_punctuation → report anything left in suspectedSplitWords and offer an LLM rewrite for those.
- Transcript: estimate_size → strip_timestamps → strip_speaker_labels → dedupe_lines (consecutive) → collapse_whitespace → read_document to verify.
- Verbose article: normalise_punctuation → rewrite_with_llm with the user's instructions → the admin accepts or rejects the diff.
- Large document (size class large or too-large): deterministic transforms first, re-check with estimate_size, then rewrite_section_with_llm one section at a time.`;

const CLEANUP_CAPABILITY_SLUGS = [
  'read_document',
  'find_in_document',
  'strip_lines_matching',
  'strip_matches',
  'strip_timestamps',
  'strip_speaker_labels',
  'collapse_whitespace',
  'join_wrapped_lines',
  'dedupe_lines',
  'normalise_punctuation',
  'preview_diff',
  'estimate_size',
  'rewrite_with_llm',
  'rewrite_section_with_llm',
] as const;

/**
 * Pick the binding to pin on the cleanup agent.
 *
 * Cleanup is a tool-choice-heavy task: the agent has fourteen capabilities
 * whose differences are subtle (collapse_whitespace vs join_wrapped_lines,
 * strip_lines_matching vs strip_matches), and a weak model picks the wrong one
 * and reports success. So rather than inheriting whatever the install's default
 * chat model happens to be, pin the strongest tool-using model the install can
 * actually reach.
 *
 * "Can actually reach" mirrors `pickActiveProviderCandidates` in
 * `lib/orchestration/llm/agent-resolver.ts`: an active provider row whose
 * `apiKeyEnvVar` is set, or one marked local. Pinning a provider with no key
 * would be worse than inheriting — it would break a path that currently works.
 *
 * Preference order: worker tier before thinking tier (a whole-document rewrite
 * on a thinking-tier model is expensive and no better at choosing a regex),
 * then deepest reasoning, then model id for a stable tie-break. Returns null
 * when nothing qualifies, in which case the agent keeps the empty-string
 * inherit-at-runtime behaviour.
 */
async function pickPinnedBinding(
  prisma: SeedContext['prisma']
): Promise<{ provider: string; model: string } | null> {
  const providers = await prisma.aiProviderConfig.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { slug: true, isLocal: true, apiKeyEnvVar: true },
  });
  const reachable = providers.filter(
    (p) => p.isLocal || (p.apiKeyEnvVar !== null && (process.env[p.apiKeyEnvVar] ?? '') !== '')
  );
  if (reachable.length === 0) return null;

  const models = await prisma.aiProviderModel.findMany({
    where: {
      providerSlug: { in: reachable.map((p) => p.slug) },
      isActive: true,
      toolUse: 'strong',
      capabilities: { has: 'chat' },
    },
    select: { providerSlug: true, modelId: true, tierRole: true, reasoningDepth: true },
  });
  if (models.length === 0) return null;

  const TIER_RANK: Record<string, number> = { worker: 0, thinking: 1, control_plane: 2 };
  const REASONING_RANK: Record<string, number> = { very_high: 0, high: 1, medium: 2, none: 3 };
  const ranked = [...models].sort((a, b) => {
    const tier = (TIER_RANK[a.tierRole] ?? 9) - (TIER_RANK[b.tierRole] ?? 9);
    if (tier !== 0) return tier;
    const reasoning =
      (REASONING_RANK[a.reasoningDepth] ?? 9) - (REASONING_RANK[b.reasoningDepth] ?? 9);
    if (reasoning !== 0) return reasoning;
    return a.modelId.localeCompare(b.modelId);
  });
  const best = ranked[0];
  return { provider: best.providerSlug, model: best.modelId };
}

// Seeds the Document Clean Up Assistant agent and binds all cleanup
// capabilities. Idempotent — re-seeding only sets isSystem: true so admin
// edits to the system prompt or model survive. Capabilities are upserted
// in 019-cleanup-capabilities; this seed only creates the pivot rows.
const unit: SeedUnit = {
  name: '020-cleanup-agent',
  async run({ prisma, logger }) {
    logger.info('🧹 Seeding cleanup-agent...');

    // Attribute the agent to the non-login SERVICE config-owner that
    // 001-system-owner guarantees, exactly as every other seeded agent does
    // (016-evaluation-judges, 017-case-generator-agent). An earlier version
    // looked for a *human* admin, which exists only under the dev-only
    // 001-test-users profile — so the profile-gated seeder used by CI and by
    // `docker-compose up` on a fresh database hit a database with no human
    // admin yet and aborted the whole seed run here.
    const owner = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!owner) {
      throw new Error('No config owner found — ensure 001-system-owner runs first.');
    }

    const pinned = await pickPinnedBinding(prisma);
    if (pinned) {
      logger.info(`🔗 Pinning cleanup-agent to ${pinned.provider}/${pinned.model}`);
    } else {
      logger.info('🔗 No reachable tool-capable model — cleanup-agent inherits at runtime');
    }

    const agent = await prisma.aiAgent.upsert({
      where: { orgId_slug: { orgId: requireOrgId(), slug: 'cleanup-agent' } },
      update: { isSystem: true },
      create: {
        name: 'Document Clean Up Assistant',
        slug: 'cleanup-agent',
        description:
          'Helps admins clean up uploaded knowledge-base documents before chunking and embedding. Combines deterministic text transforms with optional LLM rewrites.',
        systemInstructions: CLEANUP_INSTRUCTIONS,
        // Pinned to the strongest tool-using model this install can reach —
        // see pickPinnedBinding. Falls back to empty strings, which
        // agent-resolver.ts fills at runtime from the install default.
        model: pinned?.model ?? '',
        provider: pinned?.provider ?? '',
        temperature: 0.2,
        maxTokens: 2048,
        // Cleanup conversations don't query the KB — they edit a single
        // uploaded document directly via the cleanup capabilities.
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: true,
        createdBy: owner.id,
      },
    });

    // Fill the binding on an EXISTING agent only while both fields are still
    // empty — an admin's own choice is never overwritten. Without this, an
    // install seeded before the pin existed would keep inheriting the global
    // default chat model forever.
    if (pinned) {
      const filled = await prisma.aiAgent.updateMany({
        where: { slug: 'cleanup-agent', provider: '', model: '' },
        data: { provider: pinned.provider, model: pinned.model },
      });
      if (filled.count > 0) {
        logger.info(`🔗 Filled empty cleanup-agent binding → ${pinned.provider}/${pinned.model}`);
      }
    }

    // Refresh the system prompt on an existing agent only while it has never
    // been edited by a human — `systemInstructionsHistory` is appended to on
    // every admin save, so an empty array means the row still holds exactly
    // what a previous seed wrote. This is what lets a platform prompt fix (new
    // capabilities, corrected tool guidance) actually reach an install that
    // was seeded before it, without ever clobbering someone's own wording.
    const untouched = await prisma.aiAgent.findFirst({
      where: { slug: 'cleanup-agent', systemInstructionsHistory: { equals: [] } },
      select: { id: true, systemInstructions: true },
    });
    if (untouched && untouched.systemInstructions !== CLEANUP_INSTRUCTIONS) {
      await prisma.aiAgent.update({
        where: { id: untouched.id },
        data: { systemInstructions: CLEANUP_INSTRUCTIONS },
      });
      logger.info('📝 Refreshed cleanup-agent system prompt (never edited by an admin)');
    }

    for (const slug of CLEANUP_CAPABILITY_SLUGS) {
      const capability = await prisma.aiCapability.findUnique({ where: { slug } });
      if (!capability) {
        logger.warn(`⚠️ Capability ${slug} not found — skipping bind for cleanup-agent`);
        continue;
      }
      await prisma.aiAgentCapability.upsert({
        where: {
          agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id },
        },
        update: {},
        create: {
          agentId: agent.id,
          capabilityId: capability.id,
          isEnabled: true,
        },
      });
    }

    logger.info(`✅ Seeded cleanup-agent with ${CLEANUP_CAPABILITY_SLUGS.length} capabilities`);
  },
};

export default unit;
