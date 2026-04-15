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

| Component         | Type              | File                                                         |
| ----------------- | ----------------- | ------------------------------------------------------------ |
| `LearningTabs`    | Client            | `components/admin/orchestration/learn/learning-tabs.tsx`     |
| `PatternCardGrid` | Server-compatible | `components/admin/orchestration/learn/pattern-card-grid.tsx` |
| `ChatInterface`   | Client            | `components/admin/orchestration/chat/chat-interface.tsx`     |

## Advisor Tab

The advisor tab embeds a `<ChatInterface>` component connected to the `pattern-advisor` agent. It provides AI-powered guidance on selecting and combining agentic design patterns.

### Features

- **Starter prompts**: Pre-defined questions displayed when no messages exist
- **Streaming chat**: SSE-based real-time responses with capability invocations
- **Workflow recommendations**: When the advisor outputs a `workflow-definition` code block, a "Create this workflow" button appears
- **Builder handoff**: Clicking the button navigates to `/admin/orchestration/workflows/new?definition=<encoded>`, pre-populating the workflow builder canvas

### Workflow detection

The `onStreamComplete` callback scans completed assistant messages for a fenced code block tagged ` ```workflow-definition `. The JSON is validated (must have a `steps` array) before the "Create this workflow" button appears.

## Quiz Tab

The quiz tab embeds a `<ChatInterface>` connected to the `quiz-master` agent for interactive testing on agentic design patterns.

### Features

- **Starter prompts**: "Start a quiz — I'm a beginner", "Start a quiz — I'm intermediate", "Test me on Pattern 14 (RAG)", "Quiz me on workflow composition"
- **Adaptive difficulty**: The agent adjusts question difficulty based on consecutive correct/incorrect answers
- **Knowledge-grounded**: Uses `search_knowledge_base` and `get_pattern_detail` to ground explanations in the actual pattern content
- **Score badge**: A `<Badge>` above the chat displays the running score (e.g. `3/5`), parsed best-effort from the agent's responses via regex matching of "Score: X/Y" or "X out of Y" patterns

### Question types

Multiple choice, scenario-based, trade-off analysis, true/false with explanation, and anti-pattern identification. After 10 questions the agent provides a summary with areas of strength, areas to study, and specific pattern numbers to review.

### Card grid layout

`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`. Each card shows pattern name, description snippet, complexity badge, and section count. Complexity badge variants: beginner=default, intermediate=secondary, advanced=destructive.

## Pattern Detail

Fetches from `GET /api/v1/admin/orchestration/knowledge/patterns/:number`. Renders each chunk section with markdown content. Mermaid code blocks are extracted and rendered client-side.

### Components

| Component        | Type   | File                                                       |
| ---------------- | ------ | ---------------------------------------------------------- |
| `PatternContent` | Client | `components/admin/orchestration/learn/pattern-content.tsx` |
| `MermaidDiagram` | Client | `components/admin/orchestration/learn/mermaid-diagram.tsx` |

`PatternContent` uses `react-markdown` with a custom `code` component that intercepts `language-mermaid` blocks and renders them via `MermaidDiagram`.

`MermaidDiagram` dynamically imports `mermaid`, renders via `mermaid.render()` in a `useEffect`, and falls back to a raw code block on syntax errors.

## Data flow

1. Server page calls `listPatterns()` / `getPatternDetail()` directly (see `.context/architecture/data-fetching.md`)
2. Passes data to client component islands as props
3. Fetch failures return empty arrays — pages always render

## Related

- [`orchestration-knowledge-ui.md`](./orchestration-knowledge-ui.md) — Knowledge Base management page
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
