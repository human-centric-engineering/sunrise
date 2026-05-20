/**
 * Agent profile inheritance resolver.
 *
 * Given an agent and (optionally) the `AiAgentProfile` it inherits from,
 * computes the effective text for each of the three inheritable system-
 * prompt sections — persona, brand voice, and guardrails — plus the
 * agent's own (never-inherited) systemInstructions. Returns a source
 * map so callers (the admin form's effective-prompt preview, debug
 * traces, etc.) can show where each section came from.
 *
 * Per-field resolution:
 *
 *   const agentText   = trim(agent.X)        || null
 *   const profileText = trim(profile?.X)     || null
 *   const mode        = agent.XMode ?? 'override'
 *
 *   if (agentText && profileText && mode === 'append')
 *     -> `${profileText}\n\n${agentText}`     // source: 'profile+agent'
 *   if (agentText)                            // source: 'agent'
 *     -> agentText
 *   if (profileText)                          // source: 'profile'
 *     -> profileText
 *   else                                      // source: 'none'
 *     -> null
 *
 * `composeSystemPromptString` joins the resolved sections in the canonical
 * order persona → instructions → guardrails → brand voice. Both the chat
 * streaming handler and the workflow `agent_call` executor call this so
 * the same agent produces the same system prompt in both runtimes.
 *
 * Pure and isomorphic — no Prisma, no logger, no server-only imports. The
 * admin agent form imports this directly to power the live "Effective
 * prompt" preview without a round-trip.
 */

export type FieldMode = 'override' | 'append';

export interface AgentPromptFields {
  systemInstructions: string;
  persona?: string | null;
  brandVoiceInstructions?: string | null;
  guardrails?: string | null;
  /** Defaults to 'override' when unset. Only consulted when the matching text column is populated. */
  personaMode?: FieldMode | null;
  voiceMode?: FieldMode | null;
  guardrailsMode?: FieldMode | null;
}

export interface ProfilePromptFields {
  id: string;
  name: string;
  persona?: string | null;
  brandVoiceInstructions?: string | null;
  guardrails?: string | null;
}

/**
 * Where a resolved section's text originated. `profile+agent` is only
 * produced when the agent picked append mode AND both sides contributed.
 */
export type PromptSource = 'agent' | 'profile' | 'profile+agent' | 'none';

export interface ResolvedAgentPrompt {
  persona: string | null;
  systemInstructions: string;
  guardrails: string | null;
  brandVoiceInstructions: string | null;
  sources: {
    persona: PromptSource;
    /** systemInstructions is never inherited — always agent-only. */
    systemInstructions: 'agent';
    guardrails: PromptSource;
    brandVoiceInstructions: PromptSource;
    profileId: string | null;
    profileName: string | null;
  };
}

function trimToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface ResolvedField {
  value: string | null;
  source: PromptSource;
}

function resolveField(
  agentText: string | null | undefined,
  profileText: string | null | undefined,
  mode: FieldMode | null | undefined
): ResolvedField {
  const a = trimToNull(agentText);
  const p = trimToNull(profileText);
  const effectiveMode: FieldMode = mode === 'append' ? 'append' : 'override';

  if (a && p && effectiveMode === 'append') {
    return { value: `${p}\n\n${a}`, source: 'profile+agent' };
  }
  if (a) return { value: a, source: 'agent' };
  if (p) return { value: p, source: 'profile' };
  return { value: null, source: 'none' };
}

export function resolveEffectivePrompt(
  agent: AgentPromptFields,
  profile: ProfilePromptFields | null
): ResolvedAgentPrompt {
  const persona = resolveField(agent.persona, profile?.persona, agent.personaMode);
  const guardrails = resolveField(agent.guardrails, profile?.guardrails, agent.guardrailsMode);
  const voice = resolveField(
    agent.brandVoiceInstructions,
    profile?.brandVoiceInstructions,
    agent.voiceMode
  );

  return {
    persona: persona.value,
    systemInstructions: agent.systemInstructions,
    guardrails: guardrails.value,
    brandVoiceInstructions: voice.value,
    sources: {
      persona: persona.source,
      systemInstructions: 'agent',
      guardrails: guardrails.source,
      brandVoiceInstructions: voice.source,
      profileId: profile?.id ?? null,
      profileName: profile?.name ?? null,
    },
  };
}

/**
 * Join the four sections into the single string that becomes the
 * `system` message content for the LLM call. Order:
 *
 *   [Persona] -> systemInstructions -> [Guardrails] -> [Brand Voice]
 *
 * Persona first establishes identity before the task. Brand voice last
 * leans on recency bias to anchor tone in the model's working window.
 * Sections with null text are simply omitted (no empty headers).
 *
 * Shared by `composeSystemPromptString` (operating on a resolved prompt)
 * and `message-builder.ts` (which already receives the resolved values
 * from the caller and composes the chat system message in-place).
 */
export function composeSections(opts: {
  persona?: string | null;
  systemInstructions: string;
  guardrails?: string | null;
  brandVoiceInstructions?: string | null;
}): string {
  const parts: string[] = [];
  if (opts.persona) parts.push(`[Persona]\n${opts.persona}`);
  parts.push(opts.systemInstructions);
  if (opts.guardrails) parts.push(`[Guardrails]\n${opts.guardrails}`);
  if (opts.brandVoiceInstructions) {
    parts.push(`[Brand Voice]\n${opts.brandVoiceInstructions}`);
  }
  return parts.join('\n\n');
}

export function composeSystemPromptString(resolved: ResolvedAgentPrompt): string {
  return composeSections({
    persona: resolved.persona,
    systemInstructions: resolved.systemInstructions,
    guardrails: resolved.guardrails,
    brandVoiceInstructions: resolved.brandVoiceInstructions,
  });
}
