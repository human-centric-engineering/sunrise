'use client';

/**
 * CostMethodology — educational panel explaining how costs are calculated,
 * what is measured vs estimated, tokenomics trends, and workflow cost
 * guidance.
 *
 * Always visible (not collapsible) because this is the "explain your
 * numbers" section that builds trust in the data.
 */

import { AlertCircle, TrendingDown, Zap, Workflow } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function CostMethodology() {
  return (
    <Card data-testid="cost-methodology">
      <CardHeader>
        <CardTitle className="text-base">How costs are calculated</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* What's real vs estimate */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <AlertCircle className="h-4 w-4 text-blue-500" />
            What is measured vs estimated
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/30">
              <p className="mb-1 text-xs font-semibold text-green-700 uppercase dark:text-green-400">
                Measured (exact)
              </p>
              <ul className="space-y-1 text-sm text-green-900 dark:text-green-100">
                <li>Token counts (reported by the LLM provider in every API response)</li>
                <li>Which model handled each request</li>
                <li>Timestamp and agent attribution</li>
              </ul>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
              <p className="mb-1 text-xs font-semibold text-amber-700 uppercase dark:text-amber-400">
                Estimated (close approximation)
              </p>
              <ul className="space-y-1 text-sm text-amber-900 dark:text-amber-100">
                <li>Per-token rates (from OpenRouter, refreshed every 24h)</li>
                <li>Tier breakdown on the trend chart (proportional split, not per-day actual)</li>
                <li>Projected monthly spend (linear extrapolation from current run rate)</li>
              </ul>
            </div>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Your actual provider invoice may differ slightly from these figures. Per-token rates can
            lag up to 24 hours behind a provider price change. For precise billing reconciliation,
            cross-reference with your provider dashboard (Anthropic Console, OpenAI Usage, etc.).
          </p>
        </section>

        {/* Tokenomics education */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <TrendingDown className="h-4 w-4 text-violet-500" />
            Tokenomics: understanding LLM pricing
          </h3>
          <div className="space-y-2 text-sm">
            <p>
              LLM pricing is measured in <strong>tokens</strong> — roughly 0.75 words per token for
              English text. Every API call has two costs: <strong>input</strong> (your prompt +
              context) and <strong>output</strong> (the model&apos;s response). Output tokens
              typically cost 3–5x more than input tokens.
            </p>
            <div className="rounded-md border p-3">
              <p className="mb-2 text-xs font-semibold uppercase">
                Industry pricing trends (as of April 2026)
              </p>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>
                  <strong>Prices are falling fast</strong> — frontier model costs have dropped ~10x
                  in the past 2 years. Budget models that once cost $1/M tokens now cost
                  $0.10–$0.25/M.
                </li>
                <li>
                  <strong>Output is the expensive part</strong> — a model at $3/M input might charge
                  $15/M output. Workflows that generate long responses cost proportionally more.
                </li>
                <li>
                  <strong>Context length matters</strong> — sending 100k tokens of context on every
                  turn adds up quickly. RAG retrieval that sends only relevant chunks saves
                  significant input cost vs. stuffing entire documents.
                </li>
                <li>
                  <strong>Local models are free at runtime</strong> — once deployed, local models
                  have zero per-token cost. The trade-off is capability and speed.
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* Quick cost guidance */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Zap className="h-4 w-4 text-amber-500" />
            Quick cost guide by use case
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th className="pr-4 pb-2">Use case</th>
                  <th className="pr-4 pb-2">Recommended tier</th>
                  <th className="pr-4 pb-2">Typical cost per request</th>
                  <th className="pb-2">Notes</th>
                </tr>
              </thead>
              <tbody className="text-xs">
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium">Simple classification / routing</td>
                  <td className="py-2 pr-4">Budget</td>
                  <td className="py-2 pr-4 font-mono">$0.0001–$0.001</td>
                  <td className="text-muted-foreground py-2">Short prompt, short output</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium">Chat turn (typical)</td>
                  <td className="py-2 pr-4">Mid</td>
                  <td className="py-2 pr-4 font-mono">$0.002–$0.02</td>
                  <td className="text-muted-foreground py-2">~1k input, ~500 output tokens</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium">RAG with retrieval</td>
                  <td className="py-2 pr-4">Mid</td>
                  <td className="py-2 pr-4 font-mono">$0.005–$0.05</td>
                  <td className="text-muted-foreground py-2">Depends on chunk count injected</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-medium">Multi-step reasoning / tool loops</td>
                  <td className="py-2 pr-4">Frontier</td>
                  <td className="py-2 pr-4 font-mono">$0.05–$0.50</td>
                  <td className="text-muted-foreground py-2">Multiple turns compound context</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-medium">Document summarization (long)</td>
                  <td className="py-2 pr-4">Mid / Frontier</td>
                  <td className="py-2 pr-4 font-mono">$0.01–$0.20</td>
                  <td className="text-muted-foreground py-2">Large input, shorter output</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Workflow cost hints */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Workflow className="h-4 w-4 text-emerald-500" />
            Estimating workflow costs
          </h3>
          <div className="space-y-2 text-sm">
            <p>
              A workflow&apos;s cost per execution depends on the number of LLM steps, which tier
              each step uses, and how much context passes between steps. As a rough guide:
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border p-2.5">
                <p className="font-medium">Simple workflow (2–3 LLM steps)</p>
                <p className="text-muted-foreground text-xs">e.g. classify → draft → review</p>
                <p className="mt-1 font-mono text-xs">~$0.005–$0.05 per run</p>
              </div>
              <div className="rounded-md border p-2.5">
                <p className="font-medium">Complex workflow (5–8 LLM steps)</p>
                <p className="text-muted-foreground text-xs">
                  e.g. research → plan → draft → critique → revise → format
                </p>
                <p className="mt-1 font-mono text-xs">~$0.10–$1.00 per run</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Tip: Use budget-tier models for classification and routing steps, and reserve frontier
              models for steps that need reasoning or creativity. This can cut workflow costs by
              50–80% with minimal quality impact on structured tasks.
            </p>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
