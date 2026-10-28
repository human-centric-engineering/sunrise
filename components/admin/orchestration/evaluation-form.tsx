'use client';

/**
 * EvaluationForm (Phase 7 Session 7.1)
 *
 * Create form for a new evaluation session. Selects an agent, sets a title
 * and optional description, then POST /evaluations and redirects to the
 * runner page.
 *
 * Pattern: raw react-hook-form + zodResolver, FieldHelp on every field.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Loader2, Plus } from 'lucide-react';

import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

// ─── Schema ─────────────────────────────────────────────────────────────────

const evaluationFormSchema = z.object({
  agentId: z.string().min(1, 'Agent is required'),
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().max(5000).optional(),
});

type EvaluationFormData = z.infer<typeof evaluationFormSchema>;

/**
 * Server path → the field that shows its message. Only fields that render
 * `errors.x` are listed; every other path joins the summary by Save
 * (`.context/ui/form-errors.md`).
 */
const SERVER_FIELDS: Partial<Record<string, keyof EvaluationFormData>> = {
  agentId: 'agentId',
  title: 'title',
  description: 'description',
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentOption {
  id: string;
  name: string;
}

export interface EvaluationFormProps {
  agents: AgentOption[];
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EvaluationForm({ agents }: EvaluationFormProps) {
  const router = useRouter();

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<EvaluationFormData>({
    resolver: zodResolver(evaluationFormSchema),
    defaultValues: { agentId: '', title: '', description: '' },
  });

  const save = useSaveFailure({
    fallback: 'Failed to create evaluation. Please try again.',
    fields: SERVER_FIELDS,
    setError,
  });

  const agentId = watch('agentId');

  const onSubmit = async (data: EvaluationFormData) => {
    try {
      const created = await apiClient.post<{ id: string }>(API.ADMIN.ORCHESTRATION.EVALUATIONS, {
        body: data,
      });
      router.push(`/admin/orchestration/evaluations/${created.id}`);
    } catch (err) {
      save.report(err);
    }
  };

  return (
    <form onSubmit={save.submit(handleSubmit(onSubmit))} className="max-w-xl space-y-6">
      {/* Agent */}
      <div className="space-y-2">
        <Label htmlFor="agentId">
          Agent{' '}
          <FieldHelp title="Agent">
            Select the AI agent you want to evaluate. The evaluation chat session will be connected
            to this agent.
          </FieldHelp>
        </Label>
        <Select value={agentId} onValueChange={(v) => setValue('agentId', v)}>
          <SelectTrigger id="agentId">
            <SelectValue placeholder="Select an agent…" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.agentId && <p className="text-destructive text-sm">{errors.agentId.message}</p>}
      </div>

      {/* Title */}
      <div className="space-y-2">
        <Label htmlFor="title">
          Title{' '}
          <FieldHelp title="Title">
            A short name for this evaluation session. Helps you find it later in the list.
          </FieldHelp>
        </Label>
        <Input id="title" placeholder="e.g. Customer support tone check" {...register('title')} />
        {errors.title && <p className="text-destructive text-sm">{errors.title.message}</p>}
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="description">
          Description{' '}
          <FieldHelp title="Description">
            Optional notes about what you&apos;re testing — focus areas, expected behaviour,
            specific scenarios to cover.
          </FieldHelp>
        </Label>
        <Textarea
          id="description"
          placeholder="What are you evaluating? (optional)"
          rows={3}
          {...register('description')}
        />
        {errors.description && (
          <p className="text-destructive text-sm">{errors.description.message}</p>
        )}
      </div>

      {/* Submit, with a failed save directly above it */}
      <div className="space-y-2">
        <SaveError failure={save.failure} />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Create Evaluation
        </Button>
      </div>
    </form>
  );
}
