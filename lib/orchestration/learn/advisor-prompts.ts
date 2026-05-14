/**
 * Starter prompt pool for the Learning Lab pattern-advisor chat.
 *
 * Each entry is tagged with the design-pattern number it primarily
 * exercises so the test harness can assert every one of the 21
 * patterns (see `prisma/seeds/data/chunks/chunks.json`) has at least
 * one entry. The advisor agent is the consumer; the prompts are
 * designed to elicit grounded answers from its knowledge base.
 *
 * Add new prompts here, not inline in `LearningTabs` — both the
 * starter buttons and the in-chat "suggest a prompt" button draw
 * from this single pool.
 */

/** All 21 agentic design patterns, indexed by `patternNumber`. */
export const PATTERN_NAMES: Record<number, string> = {
  1: 'Prompt Chaining',
  2: 'Routing',
  3: 'Parallelisation',
  4: 'Reflection',
  5: 'Tool Use',
  6: 'Planning',
  7: 'Multi-Agent Collaboration',
  8: 'Memory Management',
  9: 'Learning & Adaptation',
  10: 'State Management (MCP)',
  11: 'Goal Setting & Monitoring',
  12: 'Exception Handling & Recovery',
  13: 'Human-in-the-Loop',
  14: 'Knowledge Retrieval (RAG)',
  15: 'Inter-Agent Communication (A2A)',
  16: 'Resource-Aware Optimisation',
  17: 'Reasoning Techniques',
  18: 'Guardrails & Safety',
  19: 'Evaluation & Monitoring',
  20: 'Prioritisation',
  21: 'Exploration & Discovery',
};

export interface AdvisorPrompt {
  /** 1–21, matches the `patternNumber` field in the knowledge-base chunks. */
  patternNumber: number;
  prompt: string;
}

/**
 * 68 starter prompts spanning all 21 patterns. Foundation patterns
 * (1, 2, 5, 14, 18) get four prompts each; the remaining 16 patterns
 * get three. New prompts are welcome — keep the structure (one
 * question per entry, tag the dominant pattern).
 */
export const ADVISOR_PROMPTS: readonly AdvisorPrompt[] = [
  // 1 — Prompt Chaining
  {
    patternNumber: 1,
    prompt: 'When should I break a task into a prompt chain instead of one big prompt?',
  },
  { patternNumber: 1, prompt: 'How do I stop errors compounding across a long prompt chain?' },
  {
    patternNumber: 1,
    prompt: 'Walk me through designing a three-step prompt chain for content review.',
  },
  { patternNumber: 1, prompt: "What's the trade-off between prompt chain length and reliability?" },

  // 2 — Routing
  {
    patternNumber: 2,
    prompt: 'How do I design a router that picks between five specialist agents?',
  },
  {
    patternNumber: 2,
    prompt: 'Should I route on classification confidence or always pick the top match?',
  },
  { patternNumber: 2, prompt: "What's the difference between LLM-based and rule-based routing?" },
  {
    patternNumber: 2,
    prompt: 'How do I handle ambiguous queries that span multiple specialist agents?',
  },

  // 3 — Parallelisation
  { patternNumber: 3, prompt: 'When does parallelising LLM calls actually win me anything?' },
  { patternNumber: 3, prompt: 'Design a fan-out / fan-in pattern for multi-source research.' },
  { patternNumber: 3, prompt: 'How do I aggregate disagreeing outputs from parallel branches?' },

  // 4 — Reflection
  { patternNumber: 4, prompt: "Walk me through adding a self-review step to an agent's output." },
  {
    patternNumber: 4,
    prompt: 'When does reflection improve quality and when is it just extra cost?',
  },
  { patternNumber: 4, prompt: 'How do I stop a reflection loop oscillating between two answers?' },

  // 5 — Tool Use
  {
    patternNumber: 5,
    prompt: 'How do I decide whether a capability should be a tool or a workflow step?',
  },
  { patternNumber: 5, prompt: "What's the right granularity for tool definitions?" },
  { patternNumber: 5, prompt: 'How do I stop the model calling the same tool over and over?' },
  {
    patternNumber: 5,
    prompt: 'Design the tools a refund-processing customer support agent needs.',
  },

  // 6 — Planning
  { patternNumber: 6, prompt: 'When should an agent plan ahead versus react one step at a time?' },
  { patternNumber: 6, prompt: 'How do I let an agent replan when a step fails partway through?' },
  {
    patternNumber: 6,
    prompt: 'Show me a planning pattern for a multi-stage customer onboarding flow.',
  },

  // 7 — Multi-Agent Collaboration
  { patternNumber: 7, prompt: 'How many specialist agents is too many for a single user request?' },
  { patternNumber: 7, prompt: 'Design a manager + worker pattern for an analyst team.' },
  {
    patternNumber: 7,
    prompt: 'When do I need a dedicated coordinator versus peer-to-peer agent chat?',
  },

  // 8 — Memory Management
  {
    patternNumber: 8,
    prompt: 'What belongs in short-term versus long-term memory for a chat agent?',
  },
  {
    patternNumber: 8,
    prompt: 'How do I summarise long conversation history without losing key details?',
  },
  { patternNumber: 8, prompt: 'When should memory be stored per-user versus per-conversation?' },

  // 9 — Learning & Adaptation
  {
    patternNumber: 9,
    prompt: 'How can agents improve from feedback without retraining the model?',
  },
  { patternNumber: 9, prompt: 'What does adaptive prompt tuning look like in practice?' },
  { patternNumber: 9, prompt: 'Design a system that learns user preferences over time.' },

  // 10 — State Management (MCP)
  { patternNumber: 10, prompt: 'How does MCP differ from passing context inline on every call?' },
  { patternNumber: 10, prompt: 'When does an agent need persistent state across sessions?' },
  {
    patternNumber: 10,
    prompt: 'Walk me through wiring an MCP server for a customer record cache.',
  },

  // 11 — Goal Setting & Monitoring
  { patternNumber: 11, prompt: 'How do I encode goals so the agent can monitor its own progress?' },
  {
    patternNumber: 11,
    prompt: 'What metrics tell me an agent is drifting off-task mid-execution?',
  },
  { patternNumber: 11, prompt: 'Design goal-monitoring for a long-running research agent.' },

  // 12 — Exception Handling & Recovery
  { patternNumber: 12, prompt: 'How should an agent recover when a tool returns malformed data?' },
  {
    patternNumber: 12,
    prompt: 'Design a retry strategy that escalates from retry → fallback → human.',
  },
  { patternNumber: 12, prompt: 'When should an agent fail loudly versus quietly degrade?' },

  // 13 — Human-in-the-Loop
  {
    patternNumber: 13,
    prompt: 'When is human approval required and when does it just slow things down?',
  },
  { patternNumber: 13, prompt: 'Design an approval gate for a customer refund agent.' },
  {
    patternNumber: 13,
    prompt: 'How do I show reviewers enough context without overwhelming them?',
  },

  // 14 — Knowledge Retrieval (RAG)
  { patternNumber: 14, prompt: 'How do I size and overlap my chunks for technical documentation?' },
  {
    patternNumber: 14,
    prompt: 'When is hybrid search worth the complexity over pure vector search?',
  },
  {
    patternNumber: 14,
    prompt: 'Design a RAG pipeline that grounds answers to specific document sections.',
  },
  {
    patternNumber: 14,
    prompt: 'How do I stop the model confabulating when retrieval comes back empty?',
  },

  // 15 — Inter-Agent Communication (A2A)
  {
    patternNumber: 15,
    prompt: 'What should one agent pass to another, and what should it leave out?',
  },
  {
    patternNumber: 15,
    prompt: 'Design a handoff protocol between a triage agent and a specialist.',
  },
  {
    patternNumber: 15,
    prompt: 'When should agents share full history versus just resolved facts?',
  },

  // 16 — Resource-Aware Optimisation
  {
    patternNumber: 16,
    prompt: 'How do I route easy queries to a cheap model and hard ones to a strong one?',
  },
  { patternNumber: 16, prompt: 'Design a budget cap that gracefully degrades when exceeded.' },
  {
    patternNumber: 16,
    prompt: "What's a good caching strategy for repeated LLM calls in a workflow?",
  },

  // 17 — Reasoning Techniques
  {
    patternNumber: 17,
    prompt: 'When does chain-of-thought help and when does it just add latency?',
  },
  {
    patternNumber: 17,
    prompt: 'Compare ReAct, Plan-and-Execute, and Tree-of-Thoughts for a research agent.',
  },
  { patternNumber: 17, prompt: 'How do I get more reliable reasoning out of a small model?' },

  // 18 — Guardrails & Safety
  { patternNumber: 18, prompt: 'Design input guardrails for an agent that handles PII.' },
  {
    patternNumber: 18,
    prompt: 'What output guardrails catch hallucinated citations versus prompt injection?',
  },
  {
    patternNumber: 18,
    prompt: 'How do I let an agent refuse off-topic requests without sounding rude?',
  },
  { patternNumber: 18, prompt: 'Walk me through a defense-in-depth guardrail stack.' },

  // 19 — Evaluation & Monitoring
  { patternNumber: 19, prompt: 'Design an evaluation harness for a customer support agent.' },
  {
    patternNumber: 19,
    prompt: 'Which matters most for a RAG agent: faithfulness, groundedness, or relevance?',
  },
  {
    patternNumber: 19,
    prompt: 'How do I detect quality drift in production without manual review?',
  },

  // 20 — Prioritisation
  {
    patternNumber: 20,
    prompt: 'How does an agent prioritise when many tasks compete for attention?',
  },
  { patternNumber: 20, prompt: 'Design a prioritisation policy for an inbox-triage agent.' },
  {
    patternNumber: 20,
    prompt: "What's the trade-off between FIFO, deadline-based, and value-based prioritisation?",
  },

  // 21 — Exploration & Discovery
  {
    patternNumber: 21,
    prompt: 'When should an agent explore options instead of executing a known plan?',
  },
  {
    patternNumber: 21,
    prompt: "Design an exploratory research agent that doesn't waste budget on dead ends.",
  },
  {
    patternNumber: 21,
    prompt: 'How do I balance exploring new options against exploiting known-good ones?',
  },
];

/** Plain string-array view, suitable for `<ChatInterface starterPrompts>`. */
export const ADVISOR_PROMPT_STRINGS: readonly string[] = ADVISOR_PROMPTS.map((p) => p.prompt);

/**
 * Pick `count` distinct prompts from the pool using a Fisher-Yates
 * partial shuffle. Returns the shuffled head as a plain string array.
 * `random` is injectable so tests can pin the shuffle to a fixed
 * sequence; defaults to `Math.random`.
 *
 * Behaviour at boundaries:
 *   - `count <= 0` → empty array
 *   - `count >= pool.length` → every prompt, randomly ordered
 */
export function sampleAdvisorPrompts(count: number, random: () => number = Math.random): string[] {
  if (count <= 0) return [];
  const pool = ADVISOR_PROMPT_STRINGS.slice();
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Pick a single prompt at random. Used by the in-chat "suggest a
 * prompt" button so the operator can grab a fresh question mid-
 * conversation without leaving the page.
 */
export function pickAdvisorPrompt(random: () => number = Math.random): string {
  if (ADVISOR_PROMPT_STRINGS.length === 0) return '';
  const idx = Math.floor(random() * ADVISOR_PROMPT_STRINGS.length);
  return ADVISOR_PROMPT_STRINGS[idx] ?? ADVISOR_PROMPT_STRINGS[0];
}
