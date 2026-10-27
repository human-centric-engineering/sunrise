'use client';

/**
 * The agent form's code execution setting: the provider's own sandbox, where
 * the model runs code while it answers (`AiAgent.providerTools.codeExecution`).
 *
 * Beside `WebSearchFields`, and like it not shared with the `llm_call` step
 * editor: a step has no provider tools. Controlled: the caller owns the whole
 * `providerTools` value, and this changes only its own key.
 */

import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { withProviderTool } from '@/lib/orchestration/llm/model-params';
import type { ProviderTools } from '@/lib/orchestration/llm/types';

export interface CodeExecutionFieldProps {
  /** Prefix for the input id, so two instances on a page don't collide. */
  idPrefix: string;
  value: ProviderTools | null;
  onChange: (next: ProviderTools | null) => void;
  disabled?: boolean;
}

export function CodeExecutionField({
  idPrefix,
  value,
  onChange,
  disabled = false,
}: CodeExecutionFieldProps) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-3">
      <Label htmlFor={`${idPrefix}-code-execution`}>
        Code execution{' '}
        <FieldHelp title="Provider code execution">
          <p>
            Lets the model write and run code (Python and shell commands) in a sandbox the provider
            hosts, to calculate, analyse data or check its work. The sandbox has no internet. What
            the code prints reaches the model, and each run shows in the conversation trace.
          </p>
          <p className="mt-2">
            Files the code makes aren&rsquo;t passed on to users, though a reply may mention one. On
            Anthropic, Sunrise deletes them from your organisation&rsquo;s Anthropic file storage
            straight after each step.
          </p>
          <p className="mt-2">
            The provider bills the sandbox by time: Anthropic $0.05 an hour after 1,550 free hours a
            month per organisation, OpenAI $0.03 per 20 minutes. Neither reports the time, so cost
            tracking counts each sandbox a reply uses as its measured run time, and at least 5
            minutes. That is an estimate, and Anthropic&rsquo;s free hours aren&rsquo;t taken off.
          </p>
          <p className="mt-2">
            Works on Claude Opus, Sonnet and Haiku 4.5 and later, and on OpenAI models from gpt-4o
            on (not gpt-4.1-nano, o1 or o3-mini) when the provider is OpenAI itself. Other providers
            and models ignore it. OpenAI doesn&rsquo;t run code at Minimal reasoning effort, and
            neither provider does when the agent asks for structured output. On Anthropic, code
            execution isn&rsquo;t covered by zero data retention.
          </p>
        </FieldHelp>
      </Label>
      <Switch
        id={`${idPrefix}-code-execution`}
        checked={value?.codeExecution !== undefined}
        disabled={disabled}
        onCheckedChange={(on) => onChange(withProviderTool(value, 'codeExecution', on ? {} : null))}
      />
    </div>
  );
}
