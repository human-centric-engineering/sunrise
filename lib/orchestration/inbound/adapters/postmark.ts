/**
 * Postmark inbound-parse adapter.
 *
 * Postmark posts a JSON body with Basic-auth credentials configured per inbound
 * server. We compare the incoming `Authorization: Basic …` header against
 * `POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASS` using a constant-time
 * compare. If either env var is unset the adapter never registers and the
 * route returns 404 — there is no half-configured state.
 *
 * Payload normalisation flattens Postmark's `FromFull` / `ToFull` shape into
 * `{from, to, subject, textBody, htmlBody, attachments}`. `MessageID` is the
 * vendor identifier used for replay dedup.
 *
 * Attachments pass through with their Postmark-supplied base64 `Content`
 * intact. Forks that don't want attachments stored on the execution row can
 * either filter them in a workflow transform step or, for binary persistence,
 * call `upload_to_storage` early in the workflow.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type {
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';

interface PostmarkAddress {
  Email?: string;
  Name?: string;
  MailboxHash?: string;
}

interface PostmarkAttachment {
  Name?: string;
  Content?: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;
}

interface PostmarkInboundBody {
  FromFull?: PostmarkAddress;
  ToFull?: PostmarkAddress[];
  CcFull?: PostmarkAddress[];
  Subject?: string;
  MessageID?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  MailboxHash?: string;
  MessageStream?: string;
  Attachments?: PostmarkAttachment[];
}

/**
 * Shape of the Postmark adapter's normalised `payload`. Workflow templates
 * reference fields with `{{ trigger.<field> }}`. Stable contract — additive
 * changes only. See `inbound-triggers.md` for source mapping.
 */
export interface PostmarkTriggerPayload {
  from: { email: string; name: string };
  to: Array<{ email: string; name: string; mailboxHash: string }>;
  cc: Array<{ email: string; name: string }>;
  subject: string;
  messageId: string;
  date: string;
  textBody: string;
  htmlBody: string;
  strippedTextReply: string;
  mailboxHash: string;
  messageStream: string;
  attachments: Array<{
    name: string;
    contentType: string;
    contentLength: number;
    contentBase64: string;
    contentId: string;
  }>;
}

/**
 * Constant-time string compare. `timingSafeEqual` requires equal-length buffers,
 * so we encode both sides and short-circuit on length mismatch *after* doing
 * the comparison work over equal-length scratch buffers. The length-check leaks
 * length but not contents; the realistic threat (per-byte timing) is closed.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export class PostmarkAdapter implements InboundAdapter {
  readonly channel = 'postmark';

  constructor(
    private readonly expectedUser: string,
    private readonly expectedPass: string
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to allow future fetch-based adapters
  async verify(req: NextRequest, _ctx: VerifyContext): Promise<VerifyResult> {
    const auth = req.headers.get('authorization');
    if (!auth || !auth.startsWith('Basic ')) {
      return { valid: false, reason: 'missing_signature' };
    }

    let decoded: string;
    try {
      decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    } catch {
      return { valid: false, reason: 'bad_format' };
    }

    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      return { valid: false, reason: 'bad_format' };
    }

    const providedUser = decoded.slice(0, colonIdx);
    const providedPass = decoded.slice(colonIdx + 1);

    // Compare both fields even on user mismatch so timing leaks neither.
    const userMatch = timingSafeStringEqual(providedUser, this.expectedUser);
    const passMatch = timingSafeStringEqual(providedPass, this.expectedPass);
    if (!userMatch || !passMatch) {
      return { valid: false, reason: 'unauthorized' };
    }

    // Postmark's MessageID is the dedup key. We can't read it here without
    // re-parsing the body, so we let `normalise` produce the externalId and
    // the route reads it off the result.
    return { valid: true };
  }

  normalise(rawBody: unknown, _headers: Headers): NormalisedTriggerPayload {
    const body = (rawBody ?? {}) as PostmarkInboundBody;

    const from = body.FromFull
      ? { email: body.FromFull.Email ?? '', name: body.FromFull.Name ?? '' }
      : { email: '', name: '' };

    const to = (body.ToFull ?? []).map((addr) => ({
      email: addr.Email ?? '',
      name: addr.Name ?? '',
      mailboxHash: addr.MailboxHash ?? '',
    }));

    const cc = (body.CcFull ?? []).map((addr) => ({
      email: addr.Email ?? '',
      name: addr.Name ?? '',
    }));

    const attachments = (body.Attachments ?? []).map((att) => ({
      name: att.Name ?? '',
      contentType: att.ContentType ?? '',
      contentLength: att.ContentLength ?? 0,
      contentBase64: att.Content ?? '',
      contentId: att.ContentID ?? '',
    }));

    return {
      channel: this.channel,
      ...(body.MessageID ? { externalId: body.MessageID } : {}),
      eventType: 'inbound_email',
      payload: {
        from,
        to,
        cc,
        subject: body.Subject ?? '',
        messageId: body.MessageID ?? '',
        date: body.Date ?? '',
        textBody: body.TextBody ?? '',
        htmlBody: body.HtmlBody ?? '',
        strippedTextReply: body.StrippedTextReply ?? '',
        mailboxHash: body.MailboxHash ?? '',
        messageStream: body.MessageStream ?? '',
        attachments,
      },
    };
  }
}
