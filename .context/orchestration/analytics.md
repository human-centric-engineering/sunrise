# Client Analytics

Analytics dashboard and API for understanding how users interact with AI agents. Provides engagement metrics, popular topics, content gap detection, feedback aggregation, and unanswered question identification.

## Module Layout

```
lib/orchestration/analytics/
├── analytics-service.ts   # Query functions for all analytics dimensions
└── index.ts               # barrel exports

components/admin/orchestration/analytics/
└── analytics-view.tsx     # Client component — full dashboard with filters

app/admin/orchestration/analytics/
└── page.tsx               # Server component — fetches data, passes to view
```

## Admin UI

The analytics dashboard at `/admin/orchestration/analytics` provides:

1. **Filter controls** — date range picker (from/to) and agent selector. Defaults to past 30 days, all agents. Changing filters updates URL search params and refetches server-side.

2. **Engagement cards** — 5 summary cards: Conversations, Messages, Unique Users, Avg Depth, Returning Users.

3. **Conversations Over Time** — bar chart showing daily conversation volume for the selected period. Only rendered when there are 2+ days of data.

4. **Feedback Summary** — overall satisfaction rate with thumbs up/down badges, per-agent breakdown table, and recent negative feedback table (last 10 thumbs-down messages with content and date).

5. **Popular Topics / Content Gaps** — side-by-side tables. Topics shows case-insensitive grouped user messages by frequency. Content Gaps shows topics with high unanswered ratios.

6. **Unanswered Questions** — full-width table of user messages where the assistant hedged, showing the user question, assistant reply, and date.

## API Endpoints

All endpoints require admin auth and accept the same query parameters:

| Param     | Type     | Default     | Description                    |
| --------- | -------- | ----------- | ------------------------------ |
| `from`    | ISO date | 30 days ago | Start of range (inclusive)     |
| `to`      | ISO date | now         | End of range (inclusive)       |
| `agentId` | CUID     | all agents  | Filter to a specific agent     |
| `limit`   | 1-100    | 20          | Max results (where applicable) |

### `GET /api/v1/admin/orchestration/analytics/topics`

Most frequently asked user messages, grouped case-insensitively.

Returns: `{ topics: [{ content, count, lastAsked }] }`

### `GET /api/v1/admin/orchestration/analytics/unanswered`

Conversations where the assistant likely couldn't answer, identified by hedging phrases ("I don't know", "I'm not sure", etc.).

Returns: `{ questions: [{ conversationId, agentId, userMessage, assistantReply, createdAt }] }`

### `GET /api/v1/admin/orchestration/analytics/engagement`

Engagement metrics for the date range.

Returns:

```json
{
  "metrics": {
    "totalConversations": 42,
    "totalMessages": 210,
    "uniqueUsers": 15,
    "avgMessagesPerConversation": 5.0,
    "returningUsers": 8,
    "returningUserRate": 0.533,
    "conversationsByDay": [{ "date": "2026-04-15", "count": 7 }]
  }
}
```

### `GET /api/v1/admin/orchestration/analytics/content-gaps`

Topics with high query volume but low satisfaction — areas where the agent frequently hedges.

Returns: `{ gaps: [{ topic, queryCount, unansweredCount, gapRatio }] }`

Sorted by `gapRatio` descending (highest gap first).

### `GET /api/v1/admin/orchestration/analytics/feedback`

Aggregates message ratings (thumbs up/down) by agent and overall.

Returns:

```json
{
  "feedback": {
    "overall": { "thumbsUp": 8, "thumbsDown": 2, "total": 10, "satisfactionRate": 0.8 },
    "byAgent": [
      {
        "agentId": "...",
        "agentName": "...",
        "thumbsUp": 8,
        "thumbsDown": 2,
        "total": 10,
        "satisfactionRate": 0.8
      }
    ],
    "recentNegative": [
      {
        "messageId": "...",
        "conversationId": "...",
        "agentId": "...",
        "content": "...",
        "ratedAt": "..."
      }
    ]
  }
}
```

## Consumer Feedback Endpoint

### `POST /api/v1/chat/conversations/:id/messages/:messageId/rate`

Allows end-users to rate assistant messages. Requires `withAuth` (not admin).

Body: `{ "rating": 1 }` or `{ "rating": -1 }`

Validates:

- Conversation belongs to the caller
- Message is an `assistant` message in that conversation
- Rating is exactly `1` (thumbs up) or `-1` (thumbs down)

Schema: `AiMessage.rating` (`Int?`, null = unrated) and `AiMessage.ratedAt` (`DateTime?`).

## How It Works

### Topic Grouping

User messages are grouped case-insensitively (lowercased and trimmed) to avoid duplicates like "Reset password" and "reset password" appearing as separate topics. The most recent casing is used as the display label.

### Unanswered Detection

Uses hedging phrase matching on assistant messages:

- "I don't know"
- "I'm not sure"
- "I don't have information"
- "I cannot find"
- "beyond my knowledge"
- "I'm unable to"
- "I do not have"

Preceding user messages are fetched in a single batch query to avoid N+1 performance issues.

This heuristic is complemented by the `rating` field on `AiMessage` — when users submit thumbs-down feedback, the `/analytics/feedback` endpoint provides explicit satisfaction data alongside the heuristic-based detection.

### Content Gap Detection

Examines conversation titles (or first user messages) and checks whether any assistant replies in that conversation contain hedging language. The gap ratio = unanswered / total queries for each topic.

### Validation Schema

`analyticsQuerySchema` in `lib/validations/orchestration.ts` validates all query parameters with Zod coercion for `limit`.
