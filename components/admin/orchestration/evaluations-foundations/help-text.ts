/**
 * Central UI copy for the Phase 1 dataset-driven evaluation surfaces.
 *
 * Every `<FieldHelp>` body and every newcomer-facing explainer lives
 * here so the tone (plain English, concrete actions, no AI flourishes)
 * is auditable in one place. The user has explicitly asked for "no AI
 * flourishes, plain English, concrete actions" — that rule binds here.
 *
 * Conventions:
 *   - Three-part FieldHelp structure where useful: what it does, when
 *     to change it, default value.
 *   - Examples in inline `code` rather than prose.
 *   - "Why" sentences only when the answer isn't self-evident.
 *
 * Anchor tone (verbatim from components/admin/orchestration/
 * evaluation-form.tsx:121 — the existing project standard):
 *   "A short name for this evaluation session. Helps you find it
 *    later in the list."
 */

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export const datasetHelp = {
  whatIsADataset:
    'A collection of test cases — each one a prompt (the question or input) plus, optionally, the answer you would consider correct. Datasets are the test plan for an evaluation run.',

  name: 'A short name for this dataset. Use something that describes what the cases test — e.g. `Customer-support FAQ — v1`.',

  description:
    'Optional notes — what the cases cover, where they came from, what they leave out. Helps future-you (or a teammate) decide whether this dataset is the right one for a new run.',

  tags: 'Comma-separated labels for filtering datasets in the list later. Lower-case, no spaces inside a tag. Example: `refund-flow, edge-case, tier-1`.',

  uploadFormat:
    'Drop a CSV or JSONL file. CSV needs an `input` column; JSONL needs an `input` field on every line. Both can also carry `expectedOutput`, `metadata`, `tags`, and `referenceCitations`.',

  expectedOutput:
    'Optional. The answer or behaviour you would consider correct. Required only by graders that compare against a reference, like `exact_match` or `contains` — purely model-graded metrics (relevance, custom rubric) work without it.',

  contentHash:
    'A fingerprint of the dataset contents at the moment a run was queued. Editing the dataset later changes this hash, but runs already in flight use the original — your historical results stay comparable.',

  source:
    'How this dataset was created. `upload` means it came from a CSV or JSONL file. `synthetic` is AI-generated cases (Generate cases button). `conversation_capture` and `workflow_capture` are cases lifted from a real chat turn or workflow execution via Save to dataset.',

  goodCase:
    'A good case is short, has one obvious right answer, and tests one thing. Phrase the `input` the way a real user would ask. Put the answer you would accept in `expectedOutput`, exact phrasing if it matters (so `exact_match` can grade it). Add `referenceCitations` only when you want a RAG grader to check the agent grounded its answer in those sources.',

  starterDownload:
    'Downloads a 3-case starter file with the right columns already in place. Open it in a spreadsheet or text editor, swap in your own questions and answers, save, then upload it back here.',

  generateFromDescription:
    'Describe the kind of questions your agent should handle and the AI builds a starter dataset for you. You see the proposed cases before anything is saved.',

  domainPrompt:
    'A 1–3 sentence description of what the agent does and the kind of questions it should handle well. Example: `Customer support agent for a fintech card issuer. Handles declined transactions, lost cards, fee disputes, and refund timelines.` More specific = better cases.',

  seedInputs:
    'Optional. 1–3 real user questions you want the generator to anchor around. The AI will produce variants and adjacent cases that sit close to these — useful when you have a few concrete examples but want breadth.',
} as const;

// ---------------------------------------------------------------------------
// Starter samples — 3 plain-English cases shown in the upload guidance panel
// and emitted by the "Download CSV / JSONL" buttons. Domain-neutral
// (returns / customer support) so they read sensibly without context. Order
// matters: each case demonstrates a different optional field combination.
// ---------------------------------------------------------------------------

export interface DatasetSampleCase {
  input: string;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
  referenceCitations?: Array<{ title: string; uri: string }>;
  tags?: string;
}

export const datasetSamples: readonly DatasetSampleCase[] = [
  {
    input: 'What is the return window for online orders?',
    expectedOutput: '30 days from delivery for unopened items, 14 days for opened items.',
    metadata: { category: 'policy' },
    tags: 'returns, policy',
  },
  {
    input: 'Can I get a refund after using the product for a week?',
    expectedOutput:
      'Yes, within 14 days of delivery if the product is faulty. Otherwise the return window for opened items has passed.',
    referenceCitations: [
      { title: 'Returns Policy — opened items', uri: 'https://example.com/returns#opened' },
    ],
    tags: 'returns, edge-case',
  },
  {
    input: 'Order #ABC-12345 arrived damaged. What should I do?',
    expectedOutput:
      'File a damage claim within 7 days. Include photos of the packaging and the item. We either refund or replace once the claim is approved.',
    metadata: { intent: 'damage_claim', priority: 'high' },
    tags: 'claims, damage',
  },
] as const;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runHelp = {
  whatIsARun:
    "A batch evaluation: every case in a dataset is fired at the subject (an agent), the response is graded against every metric you pick, and you get scores back per case and aggregated. Runs are queued and processed by the maintenance tick in the background — you don't have to keep the tab open.",

  name: 'A short name to find this run in the list later. Example: `Support agent v3 — pre-launch checks`.',

  description:
    'Optional notes — what changed in the subject since the last run, what you expect to see, any caveats.',

  subjectKind:
    'What you are evaluating. **Agent** runs the dataset through one agent like a real user would. **Workflow** subjects land in Phase 3 — the schema is wired but the run-creation form is agent-only for now.',

  subjectAgent: 'The agent the dataset will be fired at. Each case becomes one chat turn.',

  metricsPicker:
    'Pick one or more graders. Each grader scores every response and produces a number plus a one-sentence reason. Heuristic graders (regex, contains, etc.) are cheap and deterministic; model graders (faithfulness, custom rubric, …) call an AI judge and cost money per case.',

  judgeModel:
    "The AI model used by model graders (the ones that score with reasoning). Smaller, cheaper models are noisier but fine for spot-checks; larger models cost more per case. Pick a different provider family than the subject if you want to reduce evaluator bias — e.g. don't let GPT-4o judge GPT-4o.",

  judgeOmission:
    'Leave blank to use the system default judge model (set via `EVALUATION_JUDGE_*` env vars, or your default chat model if those are unset). Most teams never need to override this per-run.',

  totalCostEstimate:
    'Predicted USD cost of running the dataset against the agent + judges you picked. **Empirical** when 3+ past runs match the same agent + judges + dataset — the median per-case cost from those runs, repriced at current rates. **Heuristic** otherwise — a per-call token guess priced at each model. Heuristic graders are free; the subject bills against its usual budget.',

  costEstimateUnknownPricing:
    "One or more models in the mix have no pricing data, so the total is missing a slice. Add a row to the provider model matrix (Costs → Provider models) to set `costPerMillionTokens`, or use a model that's already priced.",
} as const;

// ---------------------------------------------------------------------------
// Graders — per-slug descriptions used in the metric picker
// ---------------------------------------------------------------------------

export const graderHelp = {
  exact_match:
    "Pass / fail check. Output must equal `expectedOutput` byte for byte (whitespace and case are normalised by default — toggleable in config). Use for slot-filling and structured-extraction tests, e.g. 'returns the order number unchanged'.",

  contains:
    "Pass / fail. Output must contain the expected text. Case-insensitive by default. Useful when phrasing varies but a key phrase must appear — e.g. 'response mentions the 30-day window'.",

  regex:
    'Pass / fail. Output must match the supplied regular expression. Use for format checks — ISO dates, currency strings, postcodes, UUIDs.',

  length_between:
    'Pass / fail. Output character count must sit between `min` and `max`. A coarse regression check for "the agent went silent" or "the agent wrote an essay".',

  json_schema:
    "Pass / fail. Output must be valid JSON whose fields match the configured types. Suffix a field with `?` to mark it optional. Use 'strict' to reject extra keys. Common for structured-extraction tests.",

  json_path_equals:
    'Pass / fail. The value at a dotted path inside the parsed JSON output must equal the configured value. Array indices use `[N]`, e.g. `items[0].sku`. Use when only one field in a structured response actually matters.',

  tool_was_called:
    "Pass / fail trajectory check. The named tool / capability must appear in the agent's call sequence at least `min` times. Use to verify the agent actually invokes the tool you expect for a question type — e.g. that the support agent calls `search_knowledge_base` for FAQ questions.",

  citation_count_at_least:
    "Pass / fail. The response must emit at least `min` citations. A cheap 'is the RAG agent grounding its answer in retrieval' signal. Pair with `faithfulness` if you also want the cited sources actually checked.",

  faithfulness:
    "AI-judged 0–1 score. For every `[N]` marker in the answer, does citation `[N]`'s excerpt actually support the claim attached to it? Returns null when the answer has no inline markers (nothing to grade). Use for retrieval-augmented chat where citations are expected.",

  groundedness:
    "AI-judged 0–1 score. Beyond citation markers, are the substantive claims in the answer supported by **any** of the retrieved sources (or clearly common knowledge)? Penalises free-floating assertions. Use as a broader 'hallucination' signal than faithfulness.",

  relevance:
    "AI-judged 0–1 score. Does the answer address what the user actually asked? Ignores citations and grounding. Use as the broadest 'is the agent on-topic' check — works on every response, with or without citations.",

  custom_rubric:
    'AI-judged score on a scale you define. Write a 1–3 sentence rubric describing what counts as a high vs. low score, set the scale (e.g. 1–5), optionally set a pass threshold. Reach for this when none of the built-in metrics fit your test.',

  customRubricPrompt:
    'The rubric the AI judge applies to every response. Describe what counts as a high score and a low score in 1–3 sentences. Example: `Score 5 if the answer cites a specific policy clause; score 1 if it gives generic advice with no clause reference.`',

  customRubricScale:
    'The numeric range the judge picks from. Typical: `1` to `5`. The judge returns an integer (or fraction) inside this range.',

  customRubricThreshold:
    'Optional. If set, scores at or above this value pass; below fail. Useful for CI gating — e.g. `scaleMin=1, scaleMax=5, passThreshold=4`.',
} as const;

// ---------------------------------------------------------------------------
// "Evaluation 101" — empty-state cards
// ---------------------------------------------------------------------------

export const evaluation101 = {
  headline: 'New to running evaluations?',
  intro:
    'Three pieces work together. A dataset is your test plan. A grader is one way of scoring an answer. A run pairs a dataset with one or more graders and fires every case at an agent.',

  datasetsHeading: 'Datasets',
  datasetsBody:
    'A dataset is a list of test cases. Each case has an `input` (the prompt) and optionally an `expectedOutput` (what counts as the right answer). Upload one as a CSV or JSONL file. Reusing the same dataset across runs is how you catch regressions.',
  datasetsCta: 'Upload a dataset',

  gradersHeading: 'Graders',
  gradersBody:
    "There are two flavours. Heuristic graders (`exact_match`, `regex`, `contains`, …) are cheap, deterministic, and don't call an AI. Model graders (`faithfulness`, `relevance`, `custom_rubric`, …) ask an AI judge to score the response with reasoning — slower and they cost money per case, but they handle nuance heuristics can't.",
  gradersCta: 'See the full grader list',

  runsHeading: 'Runs',
  runsBody:
    'A run = a dataset × an agent × a set of graders. Queue one and the worker processes it in the background — you can leave the page. When it completes you get per-metric aggregates (mean, p95, pass rate) and a per-case results table you can drill into.',
  runsCta: 'Create a run',
} as const;
