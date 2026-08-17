'use client';

/**
 * AgentProfileForm
 *
 * Shared create / edit form for `AiAgentProfile`. Raw RHF + Zod with a
 * sticky action bar; every non-trivial field is wrapped in `<FieldHelp>`
 * per `.context/ui/contextual-help.md`.
 *
 * Profiles supply default text for three inheritable agent fields —
 * persona, brand voice, guardrails. An agent attached to the profile
 * picks each field up unless it sets its own value (mode='override') or
 * appends to it (mode='append'). Composition order in the rendered
 * system prompt is fixed by `composeSections`:
 *
 *   [Persona] -> systemInstructions -> [Guardrails] -> [Brand Voice]
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Check, Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { agentProfileFormSchema } from '@/lib/validations/orchestration';
import { useTimeout } from '@/lib/hooks/use-timeout';

export interface AgentProfileRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  persona: string | null;
  brandVoiceInstructions: string | null;
  guardrails: string | null;
  /** Optional summary returned by the list/detail endpoints. */
  agents?: { id: string; slug: string; name: string; isActive: boolean }[];
  agentCount?: number;
}

type FormData = z.infer<typeof agentProfileFormSchema>;

interface Props {
  mode: 'create' | 'edit';
  profile?: AgentProfileRow;
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function AgentProfileForm({ mode, profile }: Props) {
  const router = useRouter();
  const schedule = useTimeout();
  const isEdit = mode === 'edit';

  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(agentProfileFormSchema),
    mode: 'onTouched',
    defaultValues: {
      name: profile?.name ?? '',
      slug: profile?.slug ?? '',
      description: profile?.description ?? '',
      persona: profile?.persona ?? '',
      brandVoiceInstructions: profile?.brandVoiceInstructions ?? '',
      guardrails: profile?.guardrails ?? '',
    },
  });

  const nameValue = watch('name');

  // Auto-derive the slug from the name on create, until the operator
  // edits the slug input explicitly.
  function onNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setValue('name', value, { shouldValidate: true });
    if (!isEdit && !slugTouched) {
      setValue('slug', deriveSlug(value), { shouldValidate: true });
    }
  }

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);

    // Trim and normalise empty strings to null for nullable text fields.
    const payload = {
      name: data.name,
      ...(isEdit ? {} : { slug: data.slug }),
      description: data.description?.trim() ? data.description.trim() : null,
      persona: data.persona?.trim() ? data.persona : null,
      brandVoiceInstructions: data.brandVoiceInstructions?.trim()
        ? data.brandVoiceInstructions
        : null,
      guardrails: data.guardrails?.trim() ? data.guardrails : null,
    };

    try {
      if (isEdit && profile) {
        await apiClient.patch<AgentProfileRow>(
          API.ADMIN.ORCHESTRATION.agentProfileById(profile.id),
          {
            body: payload,
          }
        );
        setSaved(true);
        schedule(() => setSaved(false), 2500);
      } else {
        const created = await apiClient.post<AgentProfileRow>(
          API.ADMIN.ORCHESTRATION.AGENT_PROFILES,
          { body: payload }
        );
        router.push(`/admin/orchestration/agent-profiles/${created.id}`);
      }
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save the profile. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <div>
          <h1 className="text-xl font-semibold">{isEdit ? profile?.name : 'New agent profile'}</h1>
          {isEdit && profile?.slug && (
            <p className="text-muted-foreground font-mono text-xs">{profile.slug}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/agent-profiles">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting || saved}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? 'Save changes' : 'Create profile'}
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="profile-name">
            Name{' '}
            <FieldHelp title="Profile name">
              A short label, shown in the agent form&apos;s profile dropdown. Example:
              &ldquo;Support team&rdquo;, &ldquo;VIP concierge&rdquo;.
            </FieldHelp>
          </Label>
          <Input
            id="profile-name"
            {...register('name')}
            value={nameValue}
            onChange={onNameChange}
            placeholder="e.g. Support team"
            aria-invalid={!!errors.name}
          />
          {errors.name && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.name.message}</p>
          )}
        </div>

        <div>
          <Label htmlFor="profile-slug">
            Slug{' '}
            <FieldHelp title="URL identifier">
              Lowercase identifier used in admin URLs. Auto-derived from the name on create; fixed
              after creation (rename = new profile + re-point agents).
            </FieldHelp>
          </Label>
          <Input
            id="profile-slug"
            {...register('slug')}
            onChange={(e) => {
              setSlugTouched(true);
              setValue('slug', e.target.value, { shouldValidate: true });
            }}
            disabled={isEdit}
            placeholder="support-team"
            className="font-mono"
            aria-invalid={!!errors.slug}
          />
          {errors.slug && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.slug.message}</p>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor="profile-description">
          Description{' '}
          <FieldHelp title="Internal note">
            Optional one-liner describing who this profile is for. Operator-facing only — never sent
            to the LLM.
          </FieldHelp>
        </Label>
        <Input
          id="profile-description"
          {...register('description')}
          placeholder="Shared persona / voice / guardrails for the support team"
          aria-invalid={!!errors.description}
        />
        {errors.description && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            {errors.description.message}
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="profile-persona">
          Persona{' '}
          <FieldHelp title="Who the agent is">
            Identity, role, perspective, backstory. Composed into the LLM&apos;s system message
            under a <code>[Persona]</code> header before the agent&apos;s instructions. Example:
            &ldquo;You are Sky, a calm senior support specialist with five years of SaaS
            experience.&rdquo; Up to 10 000 characters.
          </FieldHelp>
        </Label>
        <Textarea
          id="profile-persona"
          {...register('persona')}
          rows={6}
          placeholder="You are Sky, a calm senior support specialist..."
          aria-invalid={!!errors.persona}
        />
        {errors.persona && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.persona.message}</p>
        )}
      </div>

      <div>
        <Label htmlFor="profile-voice">
          Brand voice{' '}
          <FieldHelp title="How the agent should sound">
            Tone, register, style — adjectives and short rules. Composed under a{' '}
            <code>[Brand Voice]</code> header at the end of the system message so it stays close to
            the model&apos;s working window. Example: &ldquo;Friendly, concise, never use jargon;
            address users by their first name when known.&rdquo;
          </FieldHelp>
        </Label>
        <Textarea
          id="profile-voice"
          {...register('brandVoiceInstructions')}
          rows={5}
          placeholder="Friendly, concise, never use jargon..."
          aria-invalid={!!errors.brandVoiceInstructions}
        />
        {errors.brandVoiceInstructions && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
            {errors.brandVoiceInstructions.message}
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="profile-guardrails">
          Guardrails{' '}
          <FieldHelp title="What the agent must not do">
            Refusals, escalation triggers, topic boundaries. Composed under a{' '}
            <code>[Guardrails]</code> header after instructions. Example: &ldquo;Never give medical
            or legal advice. Escalate billing disputes over $500 to a human.&rdquo; This is
            in-prompt steering — for hard enforcement use the workflow guard step.
          </FieldHelp>
        </Label>
        <Textarea
          id="profile-guardrails"
          {...register('guardrails')}
          rows={5}
          placeholder="Never give medical or legal advice..."
          aria-invalid={!!errors.guardrails}
        />
        {errors.guardrails && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors.guardrails.message}</p>
        )}
      </div>

      {isEdit && profile?.agents && profile.agents.length > 0 && (
        <div className="rounded-md border p-4">
          <h2 className="text-sm font-medium">
            Agents using this profile ({profile.agents.length})
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Changes here affect any inheriting field on each of these agents.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {profile.agents.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/orchestration/agents/${a.id}/edit`} className="hover:underline">
                  {a.name}
                </Link>{' '}
                <span className="text-muted-foreground font-mono text-xs">({a.slug})</span>
                {!a.isActive && (
                  <span className="text-muted-foreground ml-2 text-xs">(inactive)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
