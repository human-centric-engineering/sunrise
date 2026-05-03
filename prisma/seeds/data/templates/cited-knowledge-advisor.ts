/**
 * Recipe 11: Cited Knowledge Advisor
 *
 * Patterns: Tool Use (5) + RAG (14) + Guardrails (18) + Human-in-the-Loop (13).
 *
 * Flow: search the knowledge base via the citation-emitting capability →
 * draft an answer that must reference the returned chunks via inline `[N]`
 * markers → guard the draft against uncited or hallucinated claims → pause
 * for optional human review on high-stakes domains. The guard's `fail`
 * branch produces an honest "could not ground this answer in cited sources"
 * fallback the operator can show the user instead of an unsupported claim.
 *
 * Showcases: the `search_knowledge_base` capability's citation pipeline
 * (see lib/orchestration/chat/citations.ts) used as a workflow step rather
 * than only as a chat tool. Suitable for advisor-style agents in legal,
 * financial, medical, and regulatory domains where a verifiable source
 * trail is non-negotiable.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const CITED_KNOWLEDGE_ADVISOR_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-cited-knowledge-advisor',
  name: 'Cited Knowledge Advisor',
  shortDescription:
    'Searches the knowledge base, drafts an answer with mandatory inline citations, fails closed on uncited claims, and optionally pauses for expert review.',
  patterns: [
    { number: 5, name: 'Tool Use' },
    { number: 13, name: 'Human-in-the-Loop' },
    { number: 14, name: 'RAG' },
    { number: 18, name: 'Guardrails' },
  ],
  flowSummary:
    'A Tool Call invokes search_knowledge_base, which assigns monotonic [N] citation markers to retrieved chunks. An LLM Call drafts an answer that must reference those markers inline. A Guard step fails closed on uncited or hallucinated claims — on pass the workflow pauses for optional Human Approval; on fail it generates an honest "no grounded answer available" notice instead of an unsupported claim.',
  useCases: [
    {
      title: 'Tenant rights advisor',
      scenario:
        'Renter asks about a deposit dispute or eviction notice. Search the housing-law knowledge base, draft a reply citing each statute or guidance section [1][2], block the response if any legal claim is uncited, and require a caseworker to review before sending.',
    },
    {
      title: 'Mortgage broker case preparation',
      scenario:
        'Adviser asks about lender criteria for a self-employed applicant. Search the lender-criteria corpus, draft a suitability summary with explicit citations to each lender policy excerpt, fail closed if any claim is unsupported, and require broker sign-off before the suitability report is generated.',
    },
    {
      title: 'Patient information assistant',
      scenario:
        'Patient asks about a treatment pathway or medication. Search the clinical-guidance knowledge base, draft an information sheet citing each NHS or NICE guidance source, block uncited clinical claims, and require clinician approval before the patient sees it.',
    },
    {
      title: 'Regulatory compliance Q&A',
      scenario:
        'Compliance officer asks how a new rule applies to an existing process. Search the regulatory corpus, draft an answer citing each rule excerpt, fail closed on any uncited regulatory claim, and require senior compliance approval before circulating internally.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'search_kb',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'search_kb',
        name: 'Search knowledge base (with citations)',
        type: 'tool_call',
        config: {
          capabilitySlug: 'search_knowledge_base',
        },
        nextSteps: [{ targetStepId: 'draft_answer' }],
      },
      {
        id: 'draft_answer',
        name: 'Draft answer with citations',
        type: 'llm_call',
        config: {
          prompt:
            'You are a domain advisor. Answer the question using ONLY the retrieved chunks below. Every factual claim MUST cite the chunk it comes from using the inline marker [N] supplied with the chunk. Do not invent claims that are not supported by a cited chunk; if the corpus does not cover the question, say so plainly.\n\nQuestion:\n{{input}}\n\nRetrieved chunks (each prefixed with its citation marker):\n{{search_kb.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'citation_guard' }],
      },
      {
        id: 'citation_guard',
        name: 'Citation guard',
        type: 'guard',
        config: {
          rules:
            'Block this draft if any factual claim lacks an inline [N] citation marker, if any [N] marker references a chunk that was not in the retrieval result, or if the draft asserts information that is not supported by one of the retrieved chunks. Permit the draft only when every substantive claim is grounded in a cited chunk.',
          mode: 'llm',
          failAction: 'block',
          temperature: 0.1,
        },
        nextSteps: [
          { targetStepId: 'expert_review', condition: 'pass' },
          { targetStepId: 'no_grounded_answer', condition: 'fail' },
        ],
      },
      {
        id: 'no_grounded_answer',
        name: 'Generate no-grounded-answer notice',
        type: 'llm_call',
        config: {
          prompt:
            'The previous draft was blocked by the citation guard because some claims were uncited or unsupported. Write a short, honest reply that (1) acknowledges the corpus does not cover the question well enough to answer with confidence, (2) states what was searched, and (3) suggests next steps the user can take (e.g. consult a human expert).\n\nGuard result:\n{{citation_guard.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [],
      },
      {
        id: 'expert_review',
        name: 'Expert review before send',
        type: 'human_approval',
        config: {
          prompt:
            'Review the cited answer below before it is shown to the end user. Verify each [N] citation matches its chunk and that the answer is fit for purpose in your domain.',
          timeoutMinutes: 60,
          notificationChannel: 'in-app',
        },
        nextSteps: [],
      },
    ],
  },
};
