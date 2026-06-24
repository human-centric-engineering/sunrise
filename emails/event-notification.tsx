import * as React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Hr,
  Button,
  Link,
} from '@react-email/components';
import { BRAND } from '@/lib/brand';

/**
 * Generic event-notification email template.
 *
 * One template covers every wired event type (`budget_exceeded`,
 * `workflow_failed`, `agent_updated`, ...). The dispatcher passes the
 * same `{ event, timestamp, data }` payload it would have JSON-POSTed
 * to a webhook receiver; we render it as a readable email instead.
 *
 * Layout:
 *   - Header: friendly event title
 *   - One-sentence summary (event-specific)
 *   - Key/value table of non-action top-level fields
 *   - `changes` block (rendered as field: from → to) when present
 *   - Action buttons for approval events (approveUrl / rejectUrl)
 *   - Sunrise footer
 */

export interface EventNotificationProps {
  /** Wire-format event name, e.g. `agent_updated`. */
  event: string;
  /** ISO timestamp from the dispatcher. */
  timestamp: string;
  /** Same payload shape the webhook receiver would have seen. */
  data: Record<string, unknown>;
}

interface ChangeEntry {
  from: unknown;
  to: unknown;
}

// ─── Event metadata ─────────────────────────────────────────────────────────

const EVENT_TITLES: Record<string, string> = {
  budget_exceeded: 'Budget exceeded',
  workflow_failed: 'Workflow failed',
  approval_required: 'Approval required',
  circuit_breaker_opened: 'Provider circuit breaker opened',
  agent_updated: 'Agent updated',
  execution_crashed: 'Workflow execution crashed',
};

function summaryFor(event: string, data: Record<string, unknown>): string {
  const agentName = stringOrUndef(data.agentName);
  const workflowName = stringOrUndef(data.workflowName) ?? stringOrUndef(data.workflowSlug);
  const actor = stringOrUndef(data.actorUserName) ?? stringOrUndef(data.actorUserId);
  const providerSlug = stringOrUndef(data.providerSlug);
  const errorMsg = stringOrUndef(data.error);

  switch (event) {
    case 'budget_exceeded':
      return agentName
        ? `Agent “${agentName}” reached its monthly budget.`
        : 'An agent reached its monthly budget.';
    case 'workflow_failed':
      return workflowName
        ? `Workflow “${workflowName}” failed${errorMsg ? `: ${errorMsg}` : '.'}`
        : `A workflow failed${errorMsg ? `: ${errorMsg}` : '.'}`;
    case 'approval_required':
      return workflowName
        ? `Workflow “${workflowName}” is paused and needs approval.`
        : 'A workflow is paused and needs approval.';
    case 'circuit_breaker_opened':
      return providerSlug
        ? `The circuit breaker for provider “${providerSlug}” has tripped open. Requests to that provider are blocked until the cooldown elapses.`
        : 'A provider circuit breaker has tripped open.';
    case 'agent_updated':
      return agentName
        ? `Agent “${agentName}” was updated${actor ? ` by ${actor}` : ''}.`
        : `An agent was updated${actor ? ` by ${actor}` : ''}.`;
    case 'execution_crashed':
      return workflowName
        ? `Workflow “${workflowName}” crashed mid-execution${errorMsg ? `: ${errorMsg}` : '.'}`
        : `A workflow execution crashed${errorMsg ? `: ${errorMsg}` : '.'}`;
    default:
      return `Event “${event}” fired.`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function formatValue(v: unknown): string {
  if (v === null) return '—';
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

function isChangesShape(v: unknown): v is Record<string, ChangeEntry> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      'from' in (entry as Record<string, unknown>) &&
      'to' in (entry as Record<string, unknown>)
  );
}

// Fields rendered as their own visual blocks rather than in the generic
// key/value table.
const SPECIAL_KEYS = new Set(['changes', 'approveUrl', 'rejectUrl']);

// Keys that are noisy / redundant in a human-readable email. The opaque
// IDs are still useful for receivers that want to script against the
// event, but for an email the display-name fields convey the same info.
const DEEMPHASISED_KEYS = new Set([
  'actorUserId',
  'agentId',
  'workflowId',
  'executionId',
  'subscriptionId',
  'tokenExpiresAt',
]);

// ─── Component ──────────────────────────────────────────────────────────────

export function EventNotification({
  event,
  timestamp,
  data,
}: EventNotificationProps): React.ReactElement {
  const title = EVENT_TITLES[event] ?? humaniseEventName(event);
  const summary = summaryFor(event, data);
  const formattedWhen = formatTimestamp(timestamp);

  const changes = data.changes;
  const renderChanges = isChangesShape(changes) ? changes : null;

  const approveUrl = stringOrUndef(data.approveUrl);
  const rejectUrl = stringOrUndef(data.rejectUrl);

  // Top-level fields shown in the key/value table. Order is the entries'
  // insertion order in `data` minus the special-cased keys.
  const tableEntries = Object.entries(data).filter(([key, value]) => {
    if (SPECIAL_KEYS.has(key)) return false;
    if (value === null || value === undefined) return false;
    return true;
  });

  return (
    <Html lang="en">
      <Head />
      <Preview>{summary}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={section}>
            <Text style={heading}>{title}</Text>
            <Text style={timestampLine}>
              {BRAND.name} · {formattedWhen}
            </Text>

            <Text style={summaryText}>{summary}</Text>

            {(approveUrl || rejectUrl) && (
              <Section style={actionRow}>
                {approveUrl && (
                  <Button href={approveUrl} style={primaryButton}>
                    Approve
                  </Button>
                )}
                {rejectUrl && (
                  <Button href={rejectUrl} style={secondaryButton}>
                    Reject
                  </Button>
                )}
              </Section>
            )}

            <Hr style={divider} />

            <Text style={subhead}>Details</Text>
            <table style={kvTable} cellPadding={0} cellSpacing={0}>
              <tbody>
                {tableEntries.map(([key, value]) => {
                  const deemphasised = DEEMPHASISED_KEYS.has(key);
                  return (
                    <tr key={key}>
                      <td style={{ ...kvKey, ...(deemphasised ? kvKeyMuted : {}) }}>
                        {humaniseFieldKey(key)}
                      </td>
                      <td style={{ ...kvValue, ...(deemphasised ? kvValueMuted : {}) }}>
                        {formatValue(value)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {renderChanges && Object.keys(renderChanges).length > 0 && (
              <>
                <Hr style={divider} />
                <Text style={subhead}>Changes</Text>
                <table style={kvTable} cellPadding={0} cellSpacing={0}>
                  <tbody>
                    {Object.entries(renderChanges).map(([field, { from, to }]) => (
                      <tr key={field}>
                        <td style={kvKey}>{humaniseFieldKey(field)}</td>
                        <td style={kvValue}>
                          <span style={changeFrom}>{formatValue(from)}</span>
                          <span style={changeArrow}> → </span>
                          <span style={changeTo}>{formatValue(to)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Section>

          <Text style={footer}>
            You&apos;re receiving this because you subscribed to <code>{event}</code> via{' '}
            <Link href="" style={footerLink}>
              {BRAND.name} event subscriptions
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default EventNotification;

// ─── Formatting helpers ─────────────────────────────────────────────────────

function humaniseEventName(event: string): string {
  // budget_exceeded → "Budget Exceeded"
  return event
    .split(/[_.]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function humaniseFieldKey(key: string): string {
  // camelCase → "Camel case"
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : key;
}

function formatTimestamp(iso: string): string {
  // Render in UTC so renderers don't disagree on locale formatting.
  try {
    return new Date(iso).toUTCString();
  } catch {
    return iso;
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const main: React.CSSProperties = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const container: React.CSSProperties = {
  margin: '0 auto',
  padding: '32px 16px',
  maxWidth: '600px',
};

const section: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  padding: '32px',
  border: '1px solid #e5e7eb',
};

const heading: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: 600,
  color: '#111827',
  margin: '0 0 4px',
};

const timestampLine: React.CSSProperties = {
  fontSize: '12px',
  color: '#6b7280',
  margin: '0 0 16px',
};

const summaryText: React.CSSProperties = {
  fontSize: '15px',
  lineHeight: '24px',
  color: '#1f2937',
  margin: '0',
};

const subhead: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#6b7280',
  margin: '16px 0 8px',
};

const divider: React.CSSProperties = {
  borderColor: '#e5e7eb',
  margin: '24px 0',
};

const kvTable: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const kvKey: React.CSSProperties = {
  fontSize: '13px',
  color: '#374151',
  padding: '4px 12px 4px 0',
  width: '38%',
  verticalAlign: 'top',
};

const kvValue: React.CSSProperties = {
  fontSize: '13px',
  color: '#111827',
  padding: '4px 0',
  verticalAlign: 'top',
  wordBreak: 'break-word',
};

const kvKeyMuted: React.CSSProperties = {
  color: '#9ca3af',
};

const kvValueMuted: React.CSSProperties = {
  color: '#9ca3af',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
};

const changeFrom: React.CSSProperties = {
  color: '#b91c1c',
  textDecoration: 'line-through',
  marginRight: '2px',
};

const changeArrow: React.CSSProperties = {
  color: '#6b7280',
};

const changeTo: React.CSSProperties = {
  color: '#15803d',
  fontWeight: 500,
};

const actionRow: React.CSSProperties = {
  margin: '16px 0 0',
};

const primaryButton: React.CSSProperties = {
  backgroundColor: '#111827',
  color: '#ffffff',
  padding: '10px 18px',
  borderRadius: '6px',
  fontSize: '14px',
  fontWeight: 500,
  textDecoration: 'none',
  display: 'inline-block',
  marginRight: '8px',
};

const secondaryButton: React.CSSProperties = {
  backgroundColor: '#ffffff',
  color: '#111827',
  padding: '10px 18px',
  borderRadius: '6px',
  fontSize: '14px',
  fontWeight: 500,
  textDecoration: 'none',
  display: 'inline-block',
  border: '1px solid #d1d5db',
};

const footer: React.CSSProperties = {
  fontSize: '12px',
  color: '#9ca3af',
  textAlign: 'center',
  margin: '16px 0 0',
};

const footerLink: React.CSSProperties = {
  color: '#6b7280',
};
