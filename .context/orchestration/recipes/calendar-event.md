# Recipe: Calendar Event

Create a calendar event via a hosted calendar REST API. Most useful for booking confirmations, scheduled follow-ups, and "block time on Alice's calendar" agent flows.

> ⚠ **OAuth credential management is the developer's responsibility.** Calendar APIs need short-lived bearer tokens that are refreshed against a long-lived refresh token. The recipe handles the per-request bearer use; the refresh loop must be wired separately (a cron-triggered workflow or a sidecar service). See [Common variants](#9-common-variants).

## 1. When to use this recipe

- Agent needs to create a single calendar event in response to a conversation: "book the meeting", "schedule the follow-up", "add the consultation to my calendar"
- The calendar provider exposes a REST endpoint to create events (Google Calendar, Microsoft Graph, CalDAV)
- The OAuth refresh flow already exists somewhere (cron workflow, manual rotation, or a stand-alone token-refresh service)

**Don't use this recipe for:** availability search ("when am I free?") — that's a separate read-mostly endpoint and a separate binding. Also not for recurring event management — recurrence rules add a state machine the LLM tool call shouldn't navigate alone.

## 2. What you ship

- An entry in `ORCHESTRATION_ALLOWED_HOSTS` for the provider's API host
- One env var with the **current** access token (rotated by the refresh job)
- A separate cron-triggered workflow or external service that refreshes the access token before it expires
- A binding of `call_external_api` to the agent
- Agent prompt guidance that constrains who/when

## 3. Allowlist hosts

| Vendor          | Add to `ORCHESTRATION_ALLOWED_HOSTS` |
| --------------- | ------------------------------------ |
| Google Calendar | `www.googleapis.com`                 |
| Microsoft Graph | `graph.microsoft.com`                |
| CalDAV (varies) | `<your CalDAV server hostname>`      |

## 4. Credential setup

| Vendor          | Env vars                                                                                                         | Format                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Google Calendar | `GOOGLE_CALENDAR_ACCESS_TOKEN` (rotated) + `GOOGLE_CALENDAR_REFRESH_TOKEN` (long-lived, used by the refresh job) | `ya29.a0Af_...` for access; `1//0...` for refresh         |
| Microsoft Graph | `MS_GRAPH_ACCESS_TOKEN` (rotated) + tenant + client credentials for refresh                                      | JWT                                                       |
| CalDAV          | `CALDAV_BASIC_AUTH`                                                                                              | `username:password` (use Basic auth) — refresh not needed |

The capability binding only references the **access token** env var. A separate component is responsible for keeping that env var fresh.

### How to refresh

Two viable patterns:

- **Cron-triggered workflow** that runs every ~50 minutes (Google access tokens expire after 60), calls the OAuth refresh endpoint, and writes the new token to a key/value store. The Sunrise app reads from that store at request time
- **Sidecar service** that holds the refresh token and exposes a local-only HTTP endpoint the Sunrise app calls to fetch a fresh access token. Removes the env-var-rotation problem at the cost of one more deployable

Either way: the access token in env is the boundary. The capability never sees a refresh token; refresh-flow secrets live elsewhere.

## 5. Capability binding

Worked example: Google Calendar — create an event on the primary calendar.

```json
{
  "allowedUrlPrefixes": ["https://www.googleapis.com/calendar/v3/calendars/primary/events"],
  "auth": {
    "type": "bearer",
    "secret": "GOOGLE_CALENDAR_ACCESS_TOKEN"
  },
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": {
    "type": "jmespath",
    "expression": "{id: id, htmlLink: htmlLink, status: status, start: start, end: end}"
  },
  "timeoutMs": 15000,
  "maxResponseBytes": 16384
}
```

For multiple calendars (e.g. a service-account agent that books across team members), bind a separate `call_external_api` instance per calendar with `allowedUrlPrefixes` pinned to that calendar's URL. Don't try to make one binding cover all calendars by setting a wide prefix — that defeats the URL-prefix safety check.

## 6. Agent prompt guidance

Append to the agent's system instructions:

```
You can create calendar events on the primary calendar via the `call_external_api` tool. Call:
  - url: https://www.googleapis.com/calendar/v3/calendars/primary/events
  - method: POST
  - body: {
      "summary": "<short event title>",
      "description": "<optional longer description>",
      "start": { "dateTime": "<ISO 8601 with timezone>", "timeZone": "<IANA timezone>" },
      "end": { "dateTime": "<ISO 8601 with timezone>", "timeZone": "<IANA timezone>" },
      "attendees": [{ "email": "<attendee email>" }]
    }

POLICY:
  - Always confirm the date, time, duration, and attendees with the user before calling the tool.
  - Use the user's stated timezone; if not stated, ask.
  - Do not double-book — if the user asks for a time, check availability first (separate `freebusy_check` tool, if bound).
  - Never book events more than 6 months in the future.
```

## 7. Worked example

User: _"Schedule a 30-minute consultation with bob@example.com tomorrow at 2pm Europe/London."_

Agent confirms: _"Just to confirm: 30-minute consultation, tomorrow (Saturday 3 May 2026) 14:00–14:30 Europe/London, with bob@example.com?"_

User: _"Yes."_

LLM emits:

```json
{
  "tool": "call_external_api",
  "args": {
    "url": "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    "method": "POST",
    "body": {
      "summary": "Consultation with Bob",
      "start": { "dateTime": "2026-05-03T14:00:00", "timeZone": "Europe/London" },
      "end": { "dateTime": "2026-05-03T14:30:00", "timeZone": "Europe/London" },
      "attendees": [{ "email": "bob@example.com" }]
    }
  }
}
```

Capability dispatcher sends:

```http
POST /calendar/v3/calendars/primary/events HTTP/1.1
Host: www.googleapis.com
Authorization: Bearer ya29.a0Af_...
Content-Type: application/json

{"summary":"Consultation with Bob","start":{"dateTime":"2026-05-03T14:00:00","timeZone":"Europe/London"},"end":{...},"attendees":[...]}
```

Google response (200):

```json
{
  "kind": "calendar#event",
  "id": "abcd1234efgh5678",
  "status": "confirmed",
  "htmlLink": "https://calendar.google.com/calendar/event?eid=...",
  "start": { "dateTime": "2026-05-03T14:00:00+01:00" },
  "end": { "dateTime": "2026-05-03T14:30:00+01:00" }
}
```

After response transform: `{ status: 200, body: { id, htmlLink, status, start, end } }`.

Agent: _"Booked. Confirmation: https://calendar.google.com/calendar/event?eid=… Bob will get an invite."_

## 8. Vendor variants

### Microsoft Graph

```json
{
  "allowedUrlPrefixes": [
    "https://graph.microsoft.com/v1.0/me/events",
    "https://graph.microsoft.com/v1.0/users/<userId>/events"
  ],
  "auth": { "type": "bearer", "secret": "MS_GRAPH_ACCESS_TOKEN" },
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": {
    "type": "jmespath",
    "expression": "{id: id, webLink: webLink, start: start, end: end}"
  },
  "timeoutMs": 15000,
  "maxResponseBytes": 16384
}
```

Body shape uses `subject`, `start: { dateTime, timeZone }`, `end: { ... }`, `attendees: [{ emailAddress: { address } }]`.

### CalDAV

CalDAV uses HTTP `PUT` of a `.ics` file body to a calendar URL. The recipe applies but the body is iCalendar text, not JSON, and the response is empty 201 Created. Set `Content-Type: text/calendar` in `forcedHeaders` and let the LLM emit the iCalendar body as a string. Most teams find this awkward enough that they front CalDAV with a small adapter service and use the recipe against the adapter.

## 9. Common variants

- **Free/busy lookup.** Separate read-mostly capability — bind a second `call_external_api` instance with `allowedUrlPrefixes: ['https://www.googleapis.com/calendar/v3/freeBusy']`. Less sensitive (read-only); doesn't need approval gating
- **Recurring events.** Add `recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]` to the body. The LLM is bad at constructing RRULE strings — keep it to canned templates the system prompt offers
- **Event modification / deletion.** PATCH or DELETE on `/events/{id}`. The URL prefix needs `/events/` (with the slash) to allow event IDs after. Higher risk — gate with `requiresApproval: true`
- **Multiple calendars / service-account model.** When an agent books on behalf of multiple users, the OAuth model gets significantly more involved. At that point a dedicated `GoogleCalendarCapability` class with proper service-account flow is worth the implementation cost — recipes are no longer the right tool

## 10. Anti-patterns

- ❌ **Wiring the OAuth refresh inside the capability.** Refresh has retries, jitter, exclusive locking — that's a job for a workflow or sidecar, not an agent tool call
- ❌ **Storing the refresh token in the capability `customConfig`.** Refresh tokens have refresh-token power; they should live in a credentials manager, never in DB columns next to per-call config
- ❌ **Letting the LLM book events arbitrarily far in the future.** Prompt guidance + a workflow-level validator (out of scope here) should cap horizon. A confused LLM has been known to book events in 2087
- ❌ **Ignoring time zones.** The LLM will happily emit `2026-05-03T14:00:00` with no timezone — Google will interpret as the calendar's default timezone, which is rarely what the user meant. Always require `timeZone` in the prompt and re-confirm
- ❌ **Treating a successful 200 as "the attendee is going".** Google sends invites; attendees may decline. The agent should not promise attendance
- ❌ **Using a personal Gmail account's OAuth tokens for production.** Personal account tokens are tied to a single human; if they leave, the integration breaks silently. Use a workspace service account or a dedicated bot account

## 11. Test plan

1. Set up an OAuth refresh path (cron workflow or sidecar) writing to `GOOGLE_CALENDAR_ACCESS_TOKEN` env var
2. Add `www.googleapis.com` to `ORCHESTRATION_ALLOWED_HOSTS`
3. Bind `call_external_api` to a test agent with §5 binding
4. Update agent prompt per §6
5. Open a chat: _"Schedule a 15-minute test event tomorrow at 10am Europe/London"_
6. **Verify:**
   - Event appears on the calendar
   - Trace shows request + response, **not the access token**
7. **Negative tests:**
   - Let the access token expire and confirm the call returns `auth_failed` (Google returns 401, mapped through HTTP module). Confirm the refresh workflow then writes a new token and the next call succeeds
   - Ask the agent to PUT to `https://www.googleapis.com/calendar/v3/calendars/primary/events/<existing-id>` — should be rejected with `url_not_allowed` (POST-only binding)
   - Ask the agent to book with `bob@evil.com` as attendee 100 times (DoS-via-LLM check) — outbound rate limiter should kick in

## 12. Related

- [Recipes index](./index.md)
- [`call_external_api` capability](../capabilities.md)
- [Scheduling & webhooks](../scheduling.md) — for the cron-triggered token refresh workflow
- Sibling: [chat-notification.md](./chat-notification.md) — also a "single-shot post" pattern but for chat platforms
