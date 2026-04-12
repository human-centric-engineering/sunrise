# Learning Interface

Admin pages for exploring agentic design patterns and testing knowledge. Lives at `/admin/orchestration/learn` and `/admin/orchestration/learn/patterns/[number]`.

## Pages

| Path                                          | Component                                                  | Type   | Purpose                                |
| --------------------------------------------- | ---------------------------------------------------------- | ------ | -------------------------------------- |
| `/admin/orchestration/learn`                  | `app/admin/orchestration/learn/page.tsx`                   | Server | Learning hub with tabbed layout        |
| `/admin/orchestration/learn/patterns/:number` | `app/admin/orchestration/learn/patterns/[number]/page.tsx` | Server | Pattern detail with markdown + mermaid |

## Learning Hub

Tabs: **Patterns** (active), **Advisor** (placeholder), **Quiz** (placeholder).

The Patterns tab fetches from `GET /api/v1/admin/orchestration/knowledge/patterns` and renders a card grid. Each card links to the pattern detail page.

### Components

| Component         | Type              | File                                                         |
| ----------------- | ----------------- | ------------------------------------------------------------ |
| `LearningTabs`    | Client            | `components/admin/orchestration/learn/learning-tabs.tsx`     |
| `PatternCardGrid` | Server-compatible | `components/admin/orchestration/learn/pattern-card-grid.tsx` |

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

1. Server page calls `serverFetch()` → API route → `listPatterns()` / `getPatternDetail()`
2. Passes data to client component islands as props
3. Fetch failures return empty arrays — pages always render

## Related

- [`orchestration-knowledge-ui.md`](./orchestration-knowledge-ui.md) — Knowledge Base management page
- [`../orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base services
- [`../orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP endpoints
