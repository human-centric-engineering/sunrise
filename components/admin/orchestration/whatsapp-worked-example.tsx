'use client';

/**
 * WhatsAppWorkedExample
 *
 * Scannable worked example on the New Inbound Trigger page so operators
 * see what a real WhatsApp workflow looks like end-to-end before they
 * wire one up.
 *
 * Three sections, all collapsed by default so the page stays scannable
 * for operators who already know the model:
 *
 *   1. Why a user reaches us via WhatsApp (the human side)
 *   2. End-to-end flow (inbound → workflow steps → outbound)
 *   3. Input / output / persistence / side-effect map
 *
 * Deliberately domain-agnostic: no specific industry / persona is named.
 * Operators in housing, customer support, healthcare intake, mutual
 * aid, B&B booking, etc. should all see their own use case mapped onto
 * the same shape (the persona changes; the platform-side flow does
 * not). Field names + adapter slug carry over to SMS, Slack, and
 * Postmark too.
 */

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export function WhatsAppWorkedExample() {
  return (
    <div className="bg-card rounded-lg border p-6">
      <div className="mb-4">
        <h3 className="text-base font-semibold">
          Worked example — answering an inbound WhatsApp message
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          A concrete picture of what an inbound-trigger-driven workflow looks like end-to-end. Use
          it to sanity-check your own design before clicking Create. The shape carries over to SMS,
          Slack, and Postmark with minor field renames — only the dispatch adapter and a few field
          names change.
        </p>
      </div>

      {/* Upfront callout — how multi-turn context works */}
      <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-50/50 p-3 text-xs dark:bg-emerald-950/20">
        <p className="text-foreground mb-1 font-semibold">Multi-turn context (how it works)</p>
        <p className="text-muted-foreground">
          The platform automatically remembers conversation <em>identity</em> — every future message
          from the same number lands on the same <code>AiConversation</code> row, with{' '}
          <code>lastInboundAt</code> and <code>smsOptedOut</code> carried forward. For multi-turn{' '}
          <em>content</em>, use the <code>chat_turn</code> step: it loads prior{' '}
          <code>AiMessage</code> rows for the conversation and the LLM sees the full history. The
          &quot;Create a workflow (pre-filled for inbound)&quot; CTA on the New Trigger page seeds a
          workflow with <code>chat_turn</code> already wired, so memory works out of the box. The
          older <code>llm_call</code> step is single-shot (no history) — pick it only when the
          workflow really is stateless. The streaming chat handler that backs the admin chat and
          embed widget also loads history automatically; <code>chat_turn</code> brings the same
          behaviour to inbound-trigger-driven workflows.
        </p>
      </div>

      <Accordion type="multiple" className="w-full">
        {/* 1. Why a user shows up on WhatsApp */}
        <AccordionItem value="why">
          <AccordionTrigger className="text-sm font-medium">
            1. Why a user engages via WhatsApp
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              An end user wants to ask your service a question or report a problem. They open
              WhatsApp and message your business number because:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong className="text-foreground">No signup, no email, no login.</strong> WhatsApp
                is already installed and the number is already verified. Friction is near-zero
                compared with a web form behind a partner-site auth flow.
              </li>
              <li>
                <strong className="text-foreground">Privacy + plausible deniability.</strong> For
                sensitive topics, users often won&apos;t leave email trails or visit specialist
                websites from a shared device. WhatsApp messages feel personal and ephemeral.
              </li>
              <li>
                <strong className="text-foreground">Asynchronous + free.</strong> Unlike SMS,
                WhatsApp doesn&apos;t cost the user money internationally or on PAYG. Unlike a phone
                call, there&apos;s no being-on-hold and no language-fluency pressure.
              </li>
              <li>
                <strong className="text-foreground">Media-rich.</strong> They can photograph the
                document, the screen error, the broken thing. SMS strips most of this; WhatsApp
                preserves it natively.
              </li>
              <li>
                <strong className="text-foreground">Where they already live.</strong> For huge
                slices of the global audience, WhatsApp is the default messaging surface. Meeting
                them there beats teaching them a new tool.
              </li>
            </ul>
            <p className="pt-1 text-xs italic">
              The same logic applies wherever the audience is &quot;people, not desktops&quot; —
              customer support, intake flows, proactive outreach, complaint handling, appointment
              confirmations, mutual-aid coordination, follow-up questions on services already
              delivered.
            </p>
          </AccordionContent>
        </AccordionItem>

        {/* 2. Workflow flow */}
        <AccordionItem value="flow">
          <AccordionTrigger className="text-sm font-medium">
            2. End-to-end flow — what fires when the message arrives
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-3 text-sm">
            <div className="bg-muted/40 rounded border p-3 font-mono text-xs">
              📱 &quot;Hi — I tried to use your service yesterday but I&apos;m stuck on the second
              step. Photo attached. Can you tell me what to do?&quot;
              <br />
              <span className="text-muted-foreground/70">
                — sent to your Meta WhatsApp business number from +44 7400 123 456, with one JPEG
                attachment
              </span>
            </div>

            <ol className="list-decimal space-y-2 pl-5">
              <li>
                <strong className="text-foreground">
                  Inbound trigger fires (platform, not your workflow).
                </strong>{' '}
                Meta POSTs the webhook → Sunrise verifies the <code>X-Hub-Signature-256</code> HMAC
                → the WhatsApp Cloud adapter normalises the nested Meta envelope into{' '}
                <code>
                  &#123;text, from, channel:&apos;whatsapp&apos;, provider:&apos;meta&apos;,
                  attachment&#125;
                </code>
                . An <code>AiConversation</code> row is found-or-created keyed on{' '}
                <code>(channel, fromAddress)</code> and <code>lastInboundAt</code> updates. The
                conversation id lands on <code>triggerMeta.conversationId</code> for the workflow to
                pass into <code>send_message_to_channel</code> later.
              </li>
              <li>
                <strong className="text-foreground">Step 1 — classify intent</strong> (
                <code>llm_call</code>). Routes to one of a handful of categories you define for your
                domain — e.g. <code>question</code>, <code>complaint</code>, <code>followup</code>,{' '}
                <code>spam</code>, <code>other</code>. Reads <code>trigger.text</code> only; fast
                and cheap.
              </li>
              <li>
                <strong className="text-foreground">Step 2 — read the attachment</strong> (
                <code>tool_call</code> against a vision capability, conditional). If the inbound
                carried an image or document, fetch it and pass it to the LLM so it can describe
                what&apos;s in the photo and reference that in the reply. Meta media URLs need a
                short-lived Graph fetch — wire your vision capability accordingly.
              </li>
              <li>
                <strong className="text-foreground">Step 3 — retrieve grounding context</strong> (
                <code>rag_retrieve</code> via <code>search_knowledge_base</code>). Pulls the most
                relevant pages from your published knowledge base — policies, FAQ, product docs,
                prior decisions, regulatory references, internal SOPs. Results carry source
                citations the next step preserves.
              </li>
              <li>
                <strong className="text-foreground">Step 4 — draft reply</strong> (
                <code>llm_call</code> with the citation-emitting prompt). Outputs a concise,
                WhatsApp-friendly reply that answers the question, names the relevant sources, and
                tells the user any specific evidence they should provide if they need to follow up.
                Citations stay inline as <code>[N]</code> markers.
              </li>
              <li>
                <strong className="text-foreground">Step 5 — human review gate</strong> (
                <code>human_approval</code>, optional). If the classifier or the LLM flagged the
                situation as higher-stakes (regulated topic, low-confidence answer, sensitive
                domain), pause for a human to review the draft before it goes out. Most messages
                auto-skip this gate.
              </li>
              <li>
                <strong className="text-foreground">Step 6 — send the reply</strong> (
                <code>tool_call</code> invoking <code>send_message_to_channel</code> with{' '}
                <code>conversationId: &#123;&#123;trigger.conversationId&#125;&#125;</code> and{' '}
                <code>message: &#123;&#123;steps.draft_reply.output&#125;&#125;</code>). The
                capability looks up the conversation, resolves the Meta outbound adapter, posts to
                Meta&apos;s Graph API, and logs a per-message cost row.
              </li>
            </ol>

            <div className="bg-muted/40 rounded border p-3 font-mono text-xs">
              💬 Reply lands on the user&apos;s phone seconds later, citing the relevant pages from
              your knowledge base.
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* 3. Input/output map */}
        <AccordionItem value="io">
          <AccordionTrigger className="text-sm font-medium">
            3. Input / output / persistence map
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-3 text-sm">
            <div>
              <div className="text-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                Inbound (what the workflow receives)
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>
                  <code>trigger.text</code> — the user&apos;s typed message
                </li>
                <li>
                  <code>trigger.from</code> — sender&apos;s phone in E.164 (e.g.{' '}
                  <code>+447400123456</code>)
                </li>
                <li>
                  <code>trigger.channel</code> = <code>whatsapp_cloud</code> (adapter slug)
                </li>
                <li>
                  <code>trigger.attachment</code> — Meta media id + mime type + caption (set only
                  for image / audio / video / document messages)
                </li>
                <li>
                  <code>triggerMeta.conversationId</code> — added by the route handler after the
                  resolver upserts the <code>AiConversation</code> row
                </li>
              </ul>
            </div>

            <div>
              <div className="text-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                Outbound (what the workflow sends)
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>
                  One WhatsApp message back to the user, via <code>send_message_to_channel</code> →
                  Meta Graph API.
                </li>
                <li>
                  Optional follow-up later (e.g. &quot;did this help?&quot; or a status update) via
                  a scheduled trigger. Within Meta&apos;s 24-hour conversation window this is a
                  free-form text; outside it must use a pre-approved template.
                </li>
              </ul>
            </div>

            <div>
              <div className="text-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                Persisted (what the platform writes to the DB)
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>
                  <code>AiConversation</code> — one row per (channel, fromAddress); reused on every
                  future message from this number, even if you swap providers.
                </li>
                <li>
                  <code>AiMessage</code> — one row per inbound + outbound turn, including citation
                  footnotes from RAG.
                </li>
                <li>
                  <code>AiWorkflowExecution</code> — one row per fired workflow, with the full
                  step-by-step trace, status, and total cost.
                </li>
                <li>
                  <code>AiOutboundMessage</code> — ledger row for the dispatch (UNIQUE dedup key,
                  vendor transaction id, status). Prevents double-sends on workflow retry.
                </li>
                <li>
                  <code>AiCostLog</code> — LLM costs under <code>chat</code> /{' '}
                  <code>tool_call</code>, vendor dispatch cost under <code>outbound_message</code>.
                  Visible on the Costs dashboard split by channel.
                </li>
              </ul>
            </div>

            <div>
              <div className="text-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                Side effects to know about
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>
                  <strong className="text-foreground">STOP keyword.</strong> If the user ever
                  replies with <code>STOP</code> / <code>UNSUBSCRIBE</code>, the resolver flips{' '}
                  <code>smsOptedOut = true</code> on the conversation and all future outbound is
                  refused with <code>recipient_opted_out</code>. Required by TCPA / PECR.
                </li>
                <li>
                  <strong className="text-foreground">
                    WhatsApp&apos;s 24-hour conversation window.
                  </strong>{' '}
                  Free-form replies are only allowed within 24 hours of the user&apos;s last
                  inbound. Outside that window, you must use a pre-approved Meta template — the
                  capability enforces this and returns{' '}
                  <code>whatsapp_window_expired_template_required</code> if you don&apos;t supply
                  one.
                </li>
                <li>
                  <strong className="text-foreground">Per-recipient throttle.</strong> Default 5
                  messages per conversation per hour. Stops a runaway loop from bombarding a real
                  person.
                </li>
                <li>
                  <strong className="text-foreground">PII redaction.</strong> The platform masks
                  phone numbers and message bodies on durable audit rows; full content stays on the
                  conversation row protected by the existing access controls.
                </li>
              </ul>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
