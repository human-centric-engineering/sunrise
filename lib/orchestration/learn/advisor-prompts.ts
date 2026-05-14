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
 * get three.
 *
 * Editorial stance: every prompt should anchor on a real-world
 * problem someone might want Sunrise to solve — tenant repairs,
 * planning permission, mortgage case prep, energy bill disputes,
 * post-surgery rehab, garden advice, freelance admin, community
 * coordination — rather than abstract agentic theory. The goal is to
 * help operators move from "deterministic software engineering"
 * thinking to "agentic semantic" thinking by pattern-matching their
 * own problem onto these examples. See
 * `.context/orchestration/meta/business-applications.md` and
 * `.context/orchestration/meta/commercial-proposition.md` for the
 * scenarios these prompts draw from.
 *
 * Each pattern includes at least one prompt that surfaces its
 * headline trade-off — additive latency, error propagation, drift,
 * write-tool risk, doom loops, the RAG triad, etc. — drawn from the
 * "Build Considerations & Trade-offs" section of each pattern in the
 * Gulli Agentic Design Patterns reference (the `considerations`
 * chunks in `prisma/seeds/data/chunks/chunks.json`). These prompts
 * are the bridge from deterministic to semantic thinking — they
 * surface the cost/quality/risk decisions an old-world engineer
 * doesn't yet know they need to make.
 *
 * New prompts are welcome — keep the structure (one question per
 * entry, tag the dominant pattern, ground it in a concrete scenario,
 * and where it fits, name the trade-off).
 */
export const ADVISOR_PROMPTS: readonly AdvisorPrompt[] = [
  // 1 — Prompt Chaining
  {
    patternNumber: 1,
    prompt:
      'From an agentic design perspective, if I want to help a homeowner apply for planning permission step by step, is prompt chaining the right pattern to reach for — or am I better off with one richer prompt?',
  },
  {
    patternNumber: 1,
    prompt:
      "When designing an agentic workflow that turns a tenant's free-text repair description into a structured work order, walk me through what a three-step prompt chain would actually do at each stage.",
  },
  {
    patternNumber: 1,
    prompt:
      "If I'm building a customer-complaint agent, how would I chain the prompts so the flow goes empathy reply → root-cause check → proposed resolution, and what does each step hand to the next?",
  },
  {
    patternNumber: 1,
    prompt:
      'In an agentic onboarding flow that chains five prompts together, errors at step one keep poisoning step five — where should I insert validation gates to stop the garbage-in / garbage-out cascade?',
  },

  // 2 — Routing
  {
    patternNumber: 2,
    prompt:
      'When designing an agentic front door for tenants — one assistant that hands off to repairs, rent queries, or noise-complaint specialists — how does the routing layer actually decide which path to take?',
  },
  {
    patternNumber: 2,
    prompt:
      "From an agent-orchestration perspective, if I'm building an insurance-broker agent, should I route incoming enquiries by product type, by customer situation, or by LLM-classified intent — and what are the trade-offs of each approach?",
  },
  {
    patternNumber: 2,
    prompt:
      'When my agentic router occasionally misclassifies a billing query as a technical issue, should the routing step itself use a small cheap model, and how do I measure how often it gets the call wrong?',
  },
  {
    patternNumber: 2,
    prompt:
      'Through the lens of agentic design, when is deterministic rule-based routing actually safer than LLM-based routing — especially for regulated domains like financial or legal advice?',
  },

  // 3 — Parallelisation
  {
    patternNumber: 3,
    prompt:
      "When designing an agentic mortgage-broker workflow that checks three lenders' eligibility criteria in parallel, how do I structure the fan-out / fan-in pattern so I can aggregate the results into a single recommendation?",
  },
  {
    patternNumber: 3,
    prompt:
      'From an agentic orchestration perspective, when a customer complaint comes in, can I run knowledge-base lookup, account lookup, and policy lookup as parallel branches — and what does the agent do while they are all in flight?',
  },
  {
    patternNumber: 3,
    prompt:
      'In an agentic workflow with three parallel lender checks, if one branch times out, should the agent fail the whole case (fail-all), proceed with the two that returned (best-effort), or retry — and what is the cost-versus-quality trade-off of each?',
  },

  // 4 — Reflection
  {
    patternNumber: 4,
    prompt:
      'When building an agent that drafts a mortgage suitability report, I want it to self-review the draft before showing the client — how do I add a reflection step that catches real issues rather than just rewording?',
  },
  {
    patternNumber: 4,
    prompt:
      'From an agentic design perspective, when should a tenant-rights agent reflect on its own draft letter and revise it before sending — and what specifically should the reflection step be checking for?',
  },
  {
    patternNumber: 4,
    prompt:
      "In an agentic system with reflection enabled, my self-review loop occasionally critiques a perfectly good answer into a worse one — how do I cap reflection cycles or detect 'degeneracy' so the agent stops second-guessing itself?",
  },

  // 5 — Tool Use
  {
    patternNumber: 5,
    prompt:
      'When designing a refund-handling agent, walk me through what tools (capabilities) it actually needs — order lookup, refund issue, replacement order, escalation — and how the agent decides which to call when.',
  },
  {
    patternNumber: 5,
    prompt:
      "From an agentic design perspective, if I'm building a booking agent for an independent tattoo studio, what set of tools should it have — Instagram DM intake, Stripe deposit handling, calendar slot booking — and how granular should each one be?",
  },
  {
    patternNumber: 5,
    prompt:
      "When designing an agentic energy-billing assistant that can both look up a customer's bill and apply a credit, what tools does it need — and where do I draw the line on what the agent can do unilaterally versus what needs human approval?",
  },
  {
    patternNumber: 5,
    prompt:
      "In an agentic system, what changes when a refund tool moves from read-only ('see this customer's order') to write ('issue £50 back to their card') — what guardrails, approvals, and budget limits do I now need to wrap around it?",
  },

  // 6 — Planning
  {
    patternNumber: 6,
    prompt:
      'When designing an agentic wedding-planner that has to coordinate venue, caterer, and photographer around one date, how does the agent build its plan up front, and how does it adapt when one vendor falls through?',
  },
  {
    patternNumber: 6,
    prompt:
      "From an agentic design perspective, how does a post-knee-replacement rehab agent plan a twelve-week exercise programme up front and then adapt the plan as the patient's recovery progresses or stalls?",
  },
  {
    patternNumber: 6,
    prompt:
      'In an agentic planning loop, my wedding-planner agent keeps replanning around the same impossible date — how do I detect that it is stuck and force it to either give up, escalate, or try a fundamentally different approach?',
  },

  // 7 — Multi-Agent Collaboration
  {
    patternNumber: 7,
    prompt:
      'When architecting an agentic mortgage-case workflow, should it be one capable agent doing fact-find, criteria check, and report drafting — or three specialist agents handing off to each other? What are the trade-offs?',
  },
  {
    patternNumber: 7,
    prompt:
      'In an agentic customer-support setup, when is it worth introducing a dedicated triage agent that hands off to billing and technical specialists, versus letting one general agent handle everything?',
  },
  {
    patternNumber: 7,
    prompt:
      'From an agent-orchestration cost perspective, a five-agent debate looks impressive on paper but burns tokens fast — when does a single specialist agent with the right tools actually beat a team of agents talking to each other?',
  },

  // 8 — Memory Management
  {
    patternNumber: 8,
    prompt:
      "When designing an agentic gardening advisor that remembers a customer's plot dimensions, soil type, and growing goals across visits, where does that knowledge actually live — short-term context, per-user memory, or the knowledge base?",
  },
  {
    patternNumber: 8,
    prompt:
      'From an agentic design perspective, how should a financial-planner agent remember that a client is self-employed with two children so the next conversation picks up without the client having to repeat themselves?',
  },
  {
    patternNumber: 8,
    prompt:
      "In an agentic system that retains client pension details across years, how do I design 'forgetting' mechanisms for GDPR compliance without losing the relationship context that makes the agent useful?",
  },

  // 9 — Learning & Adaptation
  {
    patternNumber: 9,
    prompt:
      'From an agentic design perspective, how can a customer-support agent get measurably better from past resolutions over time without retraining the underlying model?',
  },
  {
    patternNumber: 9,
    prompt:
      "When designing a leadership-coaching agent that adapts to each individual client's tone and progress, how does that adaptation actually work in practice without fine-tuning a custom model per user?",
  },
  {
    patternNumber: 9,
    prompt:
      'In an agentic system that learns from user feedback, bad signal can poison the agent over months — how do I version learned behaviours and roll back drift before quality degrades irrecoverably?',
  },

  // 10 — State Management (MCP)
  {
    patternNumber: 10,
    prompt:
      "When designing an agentic concierge for a B&B, what state does the agent need to keep across a guest's three-night stay — and what should reset between guests?",
  },
  {
    patternNumber: 10,
    prompt:
      "From an agent-orchestration perspective, how do I share customer-profile state across a billing agent and a technical-support agent so the customer doesn't have to re-identify themselves at the handoff?",
  },
  {
    patternNumber: 10,
    prompt:
      "In an agentic architecture, when does standing up a Model Context Protocol (MCP) server beat just stuffing the customer record into the prompt on every turn — what discovery and reusability do I gain that plain function-calling doesn't give me?",
  },

  // 11 — Goal Setting & Monitoring
  {
    patternNumber: 11,
    prompt:
      "When designing an agentic churn-outreach campaign, I want the agent to stop messaging the moment a customer responds — how do I encode that goal so the agent monitors its own progress and knows when it's done?",
  },
  {
    patternNumber: 11,
    prompt:
      'From an agentic design perspective, how does an autonomous research agent know when it has gathered enough evidence to stop investigating and start writing the briefing?',
  },
  {
    patternNumber: 11,
    prompt:
      "In an agentic system that chases overdue freelance invoices, how do I keep the agent from declaring success too early on one hand, and from getting stuck in a 'doom loop' sending reminder after reminder on the other?",
  },

  // 12 — Exception Handling & Recovery
  {
    patternNumber: 12,
    prompt:
      'From an agentic design perspective, when the billing API returns nothing useful, should the agent fall back to a guess, ask the customer to clarify, or escalate to a human — and how does it decide which?',
  },
  {
    patternNumber: 12,
    prompt:
      'When designing an agentic smart-home troubleshooter, how do I stop it spiralling through retry → different retry → yet another retry forever? What does an explicit Detection → Handling → Recovery sequence look like in practice?',
  },
  {
    patternNumber: 12,
    prompt:
      'In an agentic workflow that interacts with a planning officer, when should the agent fail loudly (so a human notices) versus quietly retry — and how do I encode that judgement?',
  },

  // 13 — Human-in-the-Loop
  {
    patternNumber: 13,
    prompt:
      'When designing an agentic refund handler, walk me through where the human-approval gates go — which decisions stay fully automatic, which need a manager to sign off, and how do I draw that threshold?',
  },
  {
    patternNumber: 13,
    prompt:
      'From an agent-orchestration perspective, when should a council planning pre-screening agent route a case to a human officer instead of advising the applicant directly — what signals should trigger the handoff?',
  },
  {
    patternNumber: 13,
    prompt:
      'In an agentic system, a human refund-approval gate adds minutes of latency — should the approval block the customer conversation, or fire asynchronously (e.g. via Slack) so the customer keeps moving while a manager reviews?',
  },

  // 14 — Knowledge Retrieval (RAG)
  {
    patternNumber: 14,
    prompt:
      "When designing an agentic planning advisor backed by my council's policy documents, how do I make sure responses cite the right source document and section, not just a vaguely related one?",
  },
  {
    patternNumber: 14,
    prompt:
      "From an agentic RAG design perspective, walk me through a retrieval pipeline that grounds every answer in a single landlord's tenancy policy documents — chunking, embedding, retrieval, generation.",
  },
  {
    patternNumber: 14,
    prompt:
      'In an agentic tenant-rights advisor, how do I stop the agent inventing case law when retrieval comes back empty — and what should it actually say to the user in that case?',
  },
  {
    patternNumber: 14,
    prompt:
      "When evaluating an agentic RAG advisor grounded in tenancy policy, how do I score retrieval quality (did it find the right clause?) and generation quality (did it use the clause correctly?) separately — the 'RAG triad' idea?",
  },

  // 15 — Inter-Agent Communication (A2A)
  {
    patternNumber: 15,
    prompt:
      'When designing an agent-to-agent handoff between a fact-find agent and a suitability-report agent, should the first agent pass the full transcript, a summary, or structured fields — and how do I avoid information loss at the boundary?',
  },
  {
    patternNumber: 15,
    prompt:
      "From an agent-orchestration perspective, when a complaint agent escalates to a human reviewer, what context does the reviewer need that the customer didn't actually repeat in the conversation?",
  },
  {
    patternNumber: 15,
    prompt:
      'In an agentic system, when does a standardised agent-to-agent (A2A) handshake protocol pay off over just passing JSON between two agents I happen to own — and what does an Agent Card actually buy me?',
  },

  // 16 — Resource-Aware Optimisation
  {
    patternNumber: 16,
    prompt:
      'From an agentic resource-optimisation perspective, can I send 70% of planning questions to a budget LLM and only escalate the tricky boundary cases to a frontier model — what does that tiered routing look like in practice?',
  },
  {
    patternNumber: 16,
    prompt:
      'When designing a free-tier agentic garden advisor, walk me through a budget cap that degrades gracefully when the monthly limit is exceeded rather than just refusing service.',
  },
  {
    patternNumber: 16,
    prompt:
      'In an agentic support system, when an agent has burned 90% of its monthly token budget, which capabilities should it still allow, which should it pause, and how does the user experience that gracefully?',
  },

  // 17 — Reasoning Techniques
  {
    patternNumber: 17,
    prompt:
      "From an agentic design perspective, when does exposing the agent's chain-of-thought reasoning genuinely help a tenant understand the answer, and when does it just add latency and confusion?",
  },
  {
    patternNumber: 17,
    prompt:
      'When designing a mortgage-broker agent that should think step by step before flagging eligibility issues, how do I actually encourage that reasoning behaviour — system-prompt instructions, response schema, or something else?',
  },
  {
    patternNumber: 17,
    prompt:
      'In an agentic system, when does forcing chain-of-thought reasoning slow my mortgage agent down more than it improves the answer — and when is the ReAct loop (Reason → Act → Observe) actually the right shape instead?',
  },

  // 18 — Guardrails & Safety
  {
    patternNumber: 18,
    prompt:
      'From an agentic guardrails perspective, how do I stop a tenant-rights agent from giving advice that crosses the line into regulated legal practice — what does layered defence look like for that?',
  },
  {
    patternNumber: 18,
    prompt:
      'When designing an agentic financial-educator that should inform but never advise, what guardrails — input, behavioural, output — keep it from straying into regulated financial advice territory?',
  },
  {
    patternNumber: 18,
    prompt:
      "From an agent-orchestration perspective, how should a SEND-advice agent respond when a parent describes a safeguarding concern in the conversation — what's the right output-guard behaviour, and where does it route?",
  },
  {
    patternNumber: 18,
    prompt:
      'In an agentic system, guardrails add latency to every reply — how do I layer input validation, behavioural prompting, output filtering, and tool restrictions for defence in depth without making the chat feel sluggish?',
  },

  // 19 — Evaluation & Monitoring
  {
    patternNumber: 19,
    prompt:
      'When designing an evaluation harness for an agentic citation-grounded customer-support agent, what specifically should I assess — final answers, citations, retrieval quality, or full trajectories?',
  },
  {
    patternNumber: 19,
    prompt:
      'From an agentic evaluation perspective, for a knowledge-grounded advisor, which scoring metric matters most — faithfulness, groundedness, or relevance — and when does each one dominate?',
  },
  {
    patternNumber: 19,
    prompt:
      'In an agentic system, should I evaluate my rehab agent on just its final answer or on the full trajectory of steps it took to get there — and when is LLM-as-a-judge worth its own evaluation cost?',
  },

  // 20 — Prioritisation
  {
    patternNumber: 20,
    prompt:
      'When designing an agentic inbox-triage assistant for a freelance consultant, how should the agent decide which enquiries are worth a discovery call and which to politely defer?',
  },
  {
    patternNumber: 20,
    prompt:
      'From an agentic design perspective, walk me through a prioritisation policy for a community-fridge coordination agent — how does it rank surplus food donations against collection requests when both are time-sensitive?',
  },
  {
    patternNumber: 20,
    prompt:
      "In an agentic workflow, if a triage agent's task queue keeps shifting as new items arrive, when should it dynamically re-prioritise mid-task — and when should it finish the current task before re-ranking?",
  },

  // 21 — Exploration & Discovery
  {
    patternNumber: 21,
    prompt:
      'From an agentic design perspective, when should a market-research agent keep exploring sources versus call it done and finalise the briefing — what stopping criteria should it be monitoring?',
  },
  {
    patternNumber: 21,
    prompt:
      'When designing an exploratory agentic research workflow, walk me through how to stop the agent burning budget chasing dead-end leads — when should it abandon a thread versus dig deeper?',
  },
  {
    patternNumber: 21,
    prompt:
      "In an agentic system, how do I sandbox an exploratory research agent with explicit token budgets, time limits, and scope constraints so it can't burn the month's spend chasing a curiosity?",
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
