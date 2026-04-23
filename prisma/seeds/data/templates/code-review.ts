/**
 * Recipe 8: Code Review Agent
 *
 * Patterns: Prompt Chaining (1) + Parallelisation (3) + Guardrails (18)
 * + Reflection (4) + Evaluation (19).
 *
 * Flow: intake the diff → fan out to three specialist analyses (security,
 * style, logic) in parallel → synthesise all findings → guard against
 * critical security issues → refine feedback via a reflect loop → score
 * overall code quality.
 *
 * The guard step branches: if critical vulnerabilities are found, the
 * review skips the feedback-polishing reflect step and goes straight to
 * scoring (so urgent issues surface faster). Clean code passes through
 * the reflect loop for a more polished review.
 *
 * Showcases: chain (intake), parallel (multi-angle analysis),
 * guard (security gate with branching), reflect (feedback refinement),
 * evaluate (quality scoring).
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const CODE_REVIEW_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-code-review',
  name: 'Code Review Agent',
  shortDescription:
    'Parallel-analyses a code diff for security, style, and logic, guards against critical vulnerabilities, and scores overall quality.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 3, name: 'Parallelisation' },
    { number: 4, name: 'Reflection' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation & Monitoring' },
  ],
  flowSummary:
    'A Chain step accepts the diff and metadata, a Parallel step fans out to three specialist LLM calls (security scan, style check, logic review), their findings converge at a synthesis LLM call, a Guard step checks for critical security issues — blocking diffs that contain vulnerabilities from the polishing loop — a Reflect step refines the feedback, and an Evaluate step scores overall code quality.',
  useCases: [
    {
      title: 'Pull request review bot',
      scenario:
        'Accept a diff, parallel-analyse security, style, and logic, synthesise findings, block critical vulnerabilities, refine feedback prose, and score overall code quality.',
    },
    {
      title: 'Vendor code audit',
      scenario:
        'Review third-party code contributions against your standards, check for license compliance, API consistency, and correctness, and block on critical violations.',
    },
    {
      title: 'Student assignment grading',
      scenario:
        'Accept a code submission, parallel-check plagiarism patterns, style adherence, and correctness, synthesise a grade report, guard against integrity violations, and score the submission.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'intake',
    errorStrategy: 'retry',
    steps: [
      {
        id: 'intake',
        name: 'Accept diff',
        type: 'chain',
        config: {
          steps: [],
        },
        nextSteps: [{ targetStepId: 'fanout' }],
      },
      {
        id: 'fanout',
        name: 'Specialist analyses',
        type: 'parallel',
        config: {
          branches: ['security_scan', 'style_check', 'logic_review'],
          timeoutMs: 90000,
          stragglerStrategy: 'wait-all',
        },
        nextSteps: [
          { targetStepId: 'security_scan' },
          { targetStepId: 'style_check' },
          { targetStepId: 'logic_review' },
        ],
      },
      {
        id: 'security_scan',
        name: 'Security scan',
        type: 'llm_call',
        config: {
          prompt:
            'You are a security specialist. Analyse the following code diff for vulnerabilities: injection flaws, hardcoded secrets, insecure dependencies, and OWASP Top 10 issues. List each finding with severity (critical, high, medium, low).\n\nDiff:\n{{input}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'synthesise' }],
      },
      {
        id: 'style_check',
        name: 'Style check',
        type: 'llm_call',
        config: {
          prompt:
            'You are a code style reviewer. Analyse the following diff for naming conventions, formatting, documentation quality, and adherence to clean-code principles. Note any style violations.\n\nDiff:\n{{input}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'synthesise' }],
      },
      {
        id: 'logic_review',
        name: 'Logic review',
        type: 'llm_call',
        config: {
          prompt:
            'You are a senior engineer reviewing code logic. Analyse the following diff for correctness, edge cases, performance issues, and potential regressions. Suggest improvements where appropriate.\n\nDiff:\n{{input}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'synthesise' }],
      },
      {
        id: 'synthesise',
        name: 'Synthesise findings',
        type: 'llm_call',
        config: {
          prompt:
            'Combine the following specialist review findings into a single, structured code review. Group by severity, deduplicate overlapping findings, and provide a clear summary.\n\nSecurity:\n{{security_scan.output}}\n\nStyle:\n{{style_check.output}}\n\nLogic:\n{{logic_review.output}}',
          modelOverride: '',
          temperature: 0.4,
        },
        nextSteps: [{ targetStepId: 'safety_gate' }],
      },
      {
        id: 'safety_gate',
        name: 'Critical vulnerability check',
        type: 'guard',
        config: {
          rules:
            'FAIL if the synthesised review contains any findings with severity "critical" — these represent security vulnerabilities that must block the review from being polished (they need immediate escalation). PASS if all findings are high, medium, or low severity.',
          mode: 'llm',
          failAction: 'block',
          temperature: 0.1,
        },
        nextSteps: [
          { targetStepId: 'refine_feedback', condition: 'pass' },
          { targetStepId: 'quality_score', condition: 'fail' },
        ],
      },
      {
        id: 'refine_feedback',
        name: 'Refine review feedback',
        type: 'reflect',
        config: {
          critiquePrompt:
            'Review the code review feedback. Is it constructive and actionable? Are suggestions specific with code examples? Is the tone professional and encouraging? Revise any feedback that is vague, harsh, or missing concrete suggestions.',
          maxIterations: 2,
        },
        nextSteps: [{ targetStepId: 'quality_score' }],
      },
      {
        id: 'quality_score',
        name: 'Score code quality',
        type: 'evaluate',
        config: {
          rubric:
            'Rate the overall code quality of the reviewed diff. Consider: security (no vulnerabilities), style (clean and consistent), logic (correct and efficient), and test coverage (changes are testable). Score from 1 to 10 where 1 is reject and 10 is exemplary.',
          scaleMin: 1,
          scaleMax: 10,
          threshold: 6,
          temperature: 0.2,
        },
        nextSteps: [],
      },
    ],
  },
};
