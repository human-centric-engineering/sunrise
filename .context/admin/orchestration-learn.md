# Learning Interface

Admin pages for exploring agentic design patterns and testing knowledge. Lives at `/admin/orchestration/learn` and `/admin/orchestration/learn/patterns/[number]`.

## Pages

| Path                                          | Component                                                  | Type   | Purpose                                |
| --------------------------------------------- | ---------------------------------------------------------- | ------ | -------------------------------------- |
| `/admin/orchestration/learn`                  | `app/admin/orchestration/learn/page.tsx`                   | Server | Learning hub with tabbed layout        |
| `/admin/orchestration/learn/patterns/:number` | `app/admin/orchestration/learn/patterns/[number]/page.tsx` | Server | Pattern detail with markdown + mermaid |

## Learning Hub

Tabs: **Patterns** (active), **Advisor**, **Quiz**.

The Patterns tab fetches from `GET /api/v1/admin/orchestration/knowledge/patterns` and renders a card grid. Each card links to the pattern detail page.

### Components

| Component         | Type   | File                                                         |
| ----------------- | ------ | ------------------------------------------------------------ |
| `LearningTabs`    | Client | `components/admin/orchestration/learn/learning-tabs.tsx`     |
| `PatternCardGrid` | Client | `components/admin/orchestration/learn/pattern-card-grid.tsx` |
| `ChatInterface`   | Client | `components/admin/orchestration/chat/chat-interface.tsx`     |

### Deep-linking

The learn page accepts searchParams to pre-select tab and inject context:

- `?tab=advisor` — opens the Advisor tab directly
- `?contextType=pattern&contextId=5` — forwards context to the advisor's `ChatInterface`, enabling the agent to know which pattern the user is asking about

Used by the "Discuss this pattern" button on pattern detail pages.

## Advisor Tab

The advisor tab embeds a `<ChatInterface>` component connected to the `pattern-advisor` agent. It provides AI-powered guidance on selecting and combining agentic design patterns.

### Features

- **Starter prompts**: Five questions sampled randomly on mount from the 68-prompt pool in `lib/orchestration/learn/advisor-prompts.ts`. Every one of the 21 agentic design patterns is represented in the pool. The five are re-sampled when the operator clears the conversation so revisits get a fresh set
- **Suggest a prompt button**: A lightbulb icon in the input row (appears once the conversation has at least one message) fills the textarea with a random pool entry. Operators can re-roll until they find a useful question. Wired via `<ChatInterface suggestionPool={ADVISOR_PROMPT_STRINGS}>`
- **Streaming chat**: SSE-based real-time responses with capability invocations
- **Workflow recommendations**: When the advisor outputs a `workflow-definition` code block, a "Create this workflow" button appears
- **Builder handoff**: Clicking the button navigates to `/admin/orchestration/workflows/new?definition=<encoded>`, pre-populating the workflow builder canvas
- **Pattern context**: When opened from a pattern detail page, `contextType` and `contextId` are forwarded to the chat stream for context-aware responses
- **Voice input**: When the `pattern-advisor` agent has `enableVoiceInput: true` (set on the agent form's General tab), a microphone button renders between the input and Send. Transcripts are appended to whatever the operator has typed so dictation and typing can mix. The page server-fetches the agent record via `GET /agents?q=pattern-advisor&limit=10` (filtered to the exact slug) so the toggle is read fresh on every page load; a missing or fetch-failed record falls back to text-only chat

### Workflow detection

The `onStreamComplete` callback scans completed assistant messages for a fenced code block tagged ` ```workflow-definition `. The JSON is validated (must have a `steps` array) before the "Create this workflow" button appears.

## Quiz Tab

The quiz tab embeds a `<ChatInterface>` connected to the `quiz-master` agent for interactive testing on agentic design patterns.

### Features

- **Starter prompts**: "Start a quiz — I'm a beginner", "Start a quiz — I'm intermediate", "Test me on Pattern 14 (RAG)", "Quiz me on workflow composition"
- **Adaptive difficulty**: The agent adjusts question difficulty based on consecutive correct/incorrect answers
- **Knowledge-grounded**: Uses `search_knowledge_base` and `get_pattern_detail` to ground explanations in the actual pattern content
- **Score badge**: A `<Badge>` above the chat displays the running score (e.g. `3/5`), parsed from the agent's responses via regex matching of "Score: X/Y" or "Score: X out of Y" patterns (requires "Score:" prefix to avoid false positives on arbitrary fractions). A `<FieldHelp>` popover explains the badge to new users
- **Score persistence**: Quiz scores are saved to the database via `POST /api/v1/admin/orchestration/quiz-scores`. On mount, the latest persisted score is loaded via `GET` so scores survive page navigations
- **Voice input**: Same affordance as the advisor tab — when the `quiz-master` agent has `enableVoiceInput: true`, the mic button appears so the operator can answer aloud. Server-fetched on the LearnPage in parallel with the advisor record

### Question types

Multiple choice, scenario-based, trade-off analysis, true/false with explanation, and anti-pattern identification. After 10 questions the agent provides a summary with areas of strength, areas to study, and specific pattern numbers to review.

### Card grid layout

`grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3`. Each card shows pattern name, description snippet, and pattern number badge.

## Pattern Detail

Fetches from `GET /api/v1/admin/orchestration/knowledge/patterns/:number`. Renders each chunk section with markdown content. Mermaid code blocks are extracted and rendered client-side.

### Action buttons

The pattern detail header includes two CTA buttons:

- **"Use this pattern"** — navigates to the workflow builder with a single-step workflow pre-populated from the step registry. For patterns that map to multiple step types (e.g., Pattern #1 → LLM Call + Chain Step), a dropdown menu lets the user choose. Component: `UsePatternButton` (`components/admin/orchestration/learn/use-pattern-button.tsx`).
- **"Discuss this pattern"** — navigates to `/admin/orchestration/learn?tab=advisor&contextType=pattern&contextId={num}`, opening the advisor chatbot with pattern context injected. Component: `DiscussPatternButton` (`components/admin/orchestration/learn/discuss-pattern-button.tsx`).

### Related patterns

Cross-references to other patterns are extracted from chunk content via regex (`extractRelatedPatterns` in `lib/orchestration/utils/extract-related-patterns.ts`). Rendered as clickable badge chips linking to the referenced pattern detail pages. Component: `RelatedPatterns` (`components/admin/orchestration/learn/related-patterns.tsx`).

### Components

| Component               | Type              | File                                                               |
| ----------------------- | ----------------- | ------------------------------------------------------------------ |
| `PatternContent`        | Client            | `components/admin/orchestration/learn/pattern-content.tsx`         |
| `MermaidDiagram`        | Client            | `components/admin/orchestration/learn/mermaid-diagram.tsx`         |
| `UsePatternButton`      | Client            | `components/admin/orchestration/learn/use-pattern-button.tsx`      |
| `DiscussPatternButton`  | Server-compatible | `components/admin/orchestration/learn/discuss-pattern-button.tsx`  |
| `RelatedPatterns`       | Server-compatible | `components/admin/orchestration/learn/related-patterns.tsx`        |
| `PatternDetailSections` | Client            | `components/admin/orchestration/learn/pattern-detail-sections.tsx` |

`PatternContent` uses `react-markdown` with a custom `code` component that intercepts `language-mermaid` blocks and renders them via `MermaidDiagram`.

`MermaidDiagram` dynamically imports `mermaid`, renders via `mermaid.render()` in a `useEffect`, and falls back to a raw code block on syntax errors.

## Data flow

1. Server page calls `serverFetch()` → API route → `listPatterns()` / `getPatternDetail()`
2. Passes data to client component islands as props
3. Fetch failures return empty arrays — pages always render

## Related

- [`orchestration-knowledge-ui.md`](./orchestration-knowledge-ui.md) — Knowledge Base management page
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
