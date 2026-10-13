/**
 * Shorten URL-bearing values in an execution trace before it is shown (t-777).
 *
 * A trace entry stores the step's config as `input` and the step's result as
 * `output`. For a `send_notification` or `external_call` step that includes a
 * full webhook or API URL, and many services (Slack, Discord, Telegram) put the
 * secret that lets anyone post to the channel inside that address. t-773 kept
 * those URLs out of the logs; this keeps them out of the admin trace view, the
 * Markdown report, the executions list and the run streams, and from the
 * step configs on the approver's status page (whose outputs the chat
 * approval cards use as the workflow's result).
 *
 * **Applied where the trace is served, never where it is persisted.** The
 * persisted trace has to keep the working URL: later steps read
 * `{{steps.<id>.output.url}}`, and a resumed run rebuilds its step outputs
 * from the persisted trace.
 *
 * **Matched by key, not by content.** A string under a key ending in `url`
 * or `urls` (`url`, `webhookUrl`, `allowedUrls`…), or an `external_call`
 * source's `reference`, that parses as an http(s)
 * URL becomes its `loggableUrl()` form: origin plus collapsed path, with no
 * query, fragment or userinfo. URLs inside free text, such as a model's answer
 * or a citation, are content the reader came to see and are left as written.
 * A value that does not parse (a `{{template}}`) is left as written too.
 *
 * Pure function — no DB, no I/O.
 */

import { loggableUrl } from '@/lib/logging/redact-path';

/**
 * A key whose value is an address (`url`, `webhookUrl`, `source_url`,
 * `callbackURL`), or a list of them (`urls`, `allowedUrls`).
 */
const URL_KEY = /urls?$/i;

/**
 * Whether `key` of `record` holds an address to reduce. A provenance source's
 * `reference` is one only for an `external_call` source, whose `reference` is
 * the URL the step hit and can carry an API key
 * (`lib/orchestration/provenance/types.ts`). A `web_search` source's
 * `reference` is a public page the reader follows as a citation link, and is
 * left as written, like any URL in content.
 */
function isUrlKey(record: object, key: string): boolean {
  if (URL_KEY.test(key)) return true;
  return key === 'reference' && Reflect.get(record, 'source') === 'external_call';
}

/**
 * How deep the walk follows nested objects and arrays. Past it an object is
 * replaced rather than passed on unread, so a URL nested deeper cannot slip
 * through. Step configs and outputs sit far shallower than this.
 */
const MAX_DEPTH = 32;
const DEPTH_LIMIT = '[depth limit]';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, depth: number, underUrlKey: boolean): unknown {
  if (typeof value === 'string') {
    return underUrlKey && isHttpUrl(value) ? loggableUrl(value.trim()) : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  // A Date, a Prisma Decimal or another class instance in a live step output
  // keeps its own `toJSON`; copying its entries would turn it into `{}`.
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return DEPTH_LIMIT;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, depth + 1, underUrlKey));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = walk(item, depth + 1, isUrlKey(value, key));
  }
  return out;
}

/**
 * A copy of `value` with every URL-bearing value shortened (see the module
 * comment). Strings are only ever replaced by strings, so the shape of `value`
 * is preserved, except past `MAX_DEPTH`, where an object becomes a string.
 *
 * @example
 * withDisplayUrls({ webhookUrl: 'https://hooks.slack.com/services/T0/B0/Xk9fQ2mZp4LrT7vB1nWc8sYd' });
 * // { webhookUrl: 'https://hooks.slack.com/services/T0/B0/[param]' }
 */
export function withDisplayUrls<T>(value: T): T {
  // The walk replaces strings with strings and copies everything else, so
  // the result has the shape of its input (bar the depth cap above).
  return walk(value, 0, false) as T;
}

/**
 * {@link withDisplayUrls} applied to every event of an engine run streamed to
 * the browser (`step_completed.output`, `workflow_completed.output`…), so the
 * builder's live view hides what the trace view hides. Closing the returned
 * stream closes the source, as `for await` does.
 */
export async function* withDisplayUrlsStream<T>(events: AsyncIterable<T>): AsyncIterable<T> {
  for await (const event of events) yield withDisplayUrls(event);
}
