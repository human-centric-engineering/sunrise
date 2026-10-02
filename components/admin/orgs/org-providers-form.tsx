'use client';

/**
 * OrgProvidersForm — an org's approved providers and jurisdictions (§120 t-745)
 *
 * The admin UI for `GET`/`PUT /api/v1/admin/orgs/[id]/providers`. A platform
 * admin ticks the providers the org may use and, optionally, the
 * jurisdictions it is held to; a save replaces the whole policy. The page is
 * platform-admin only because the admin tree is.
 *
 * Two states it says rather than hides:
 *  - **Not enforced** (`TENANCY_MODE=single`): the policy is stored and every
 *    org may still use every provider, so the form stays editable and says so.
 *  - **The install org**: unrestricted by rule, with no set to edit, so the
 *    form is replaced by a sentence.
 */

import { useState } from 'react';
import { z } from 'zod';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

/** `GET /api/v1/admin/orgs/[id]/providers`, as the route reports it. */
export interface OrgProviderPolicyView {
  orgId: string;
  unrestricted: boolean;
  enforced: boolean;
  /** Each grant's provider row, with its slug — `null` once that row is deleted. */
  approved: { id: string; slug: string | null }[];
  jurisdictions: string[] | null;
}

/** The provider fields the form lists. */
export interface OrgProviderOption {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  jurisdiction: string | null;
}

export interface OrgProvidersFormProps {
  orgId: string;
  policy: OrgProviderPolicyView;
  providers: OrgProviderOption[];
}

/** A 400's per-field messages, as `validateRequestBody` reports them. */
const fieldErrorsSchema = z.object({
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
});

/**
 * What a failed save says. A validation error's top-level message is only
 * "Invalid request body"; the field messages say which code was wrong and what
 * a valid one looks like, so they are shown instead when present.
 */
function describeSaveError(err: unknown): string {
  if (!(err instanceof APIClientError)) return 'Could not save the approved providers';
  const parsed = fieldErrorsSchema.safeParse(err.details);
  if (!parsed.success || parsed.data.errors.length === 0) return err.message;
  return [...new Set(parsed.data.errors.map((issue) => issue.message))].join(' ');
}

/** `"eu, us"` → `["eu", "us"]`; the API upper-cases and validates each code. */
function parseJurisdictions(text: string): string[] {
  return text
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

export function OrgProvidersForm({ orgId, policy: initial, providers }: OrgProvidersFormProps) {
  const [policy, setPolicy] = useState(initial);
  const [approvedIds, setApprovedIds] = useState(
    () => new Set(initial.approved.map((grant) => grant.id))
  );
  const [restricted, setRestricted] = useState(initial.jurisdictions !== null);
  const [jurisdictionText, setJurisdictionText] = useState(
    (initial.jurisdictions ?? []).join(', ')
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (policy.unrestricted) {
    return (
      <p className="text-muted-foreground text-sm">
        This is the install organisation. It may use every provider by rule, so it has no approved
        set to edit.
      </p>
    );
  }

  // A grant whose provider row was deleted is inert; a save (which names
  // providers by slug) drops it.
  const orphaned = policy.approved.filter((grant) => grant.slug === null).length;
  // A save replaces the whole policy, so a grant for a provider this list
  // does not show (one created since the page loaded) is carried over by slug
  // rather than silently revoked.
  const listed = new Set(providers.map((p) => p.id));
  const unlisted = policy.approved.flatMap((grant) =>
    grant.slug !== null && !listed.has(grant.id) ? [grant.slug] : []
  );
  // Nothing typed yet is not "restricted to nothing": the save refuses an
  // empty list, so no provider is flagged as outside it until a code is named.
  const codes = restricted ? parseJurisdictions(jurisdictionText) : [];
  const allowed = codes.length > 0 ? new Set(codes.map((code) => code.toUpperCase())) : null;

  const toggle = (id: string, on: boolean) => {
    setSaved(false);
    setApprovedIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await apiClient.put<OrgProviderPolicyView>(API.ADMIN.orgProviders(orgId), {
        body: {
          approved: [
            ...providers.filter((p) => approvedIds.has(p.id)).map((p) => p.slug),
            ...unlisted,
          ],
          jurisdictions: restricted ? parseJurisdictions(jurisdictionText) : null,
        },
      });
      setPolicy(updated);
      setApprovedIds(new Set(updated.approved.map((grant) => grant.id)));
      setRestricted(updated.jurisdictions !== null);
      setJurisdictionText((updated.jurisdictions ?? []).join(', '));
      setSaved(true);
    } catch (err) {
      setError(describeSaveError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {!policy.enforced && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Provider policy is not enforced on this install (it runs single-tenant): every
          organisation may use every provider. What you save here is stored, and applies once
          multi-tenancy is enabled.
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">
          Approved providers{' '}
          <FieldHelp title="Which providers this organisation may use">
            <p>
              An organisation may call only the providers ticked here — every other call is refused,
              and its agents cannot be saved naming one. A new organisation starts with none.
            </p>
            <p className="mt-2">
              A grant follows the provider itself, so renaming a provider keeps it. An inactive
              provider can be approved ahead of being switched on.
            </p>
          </FieldHelp>
        </legend>
        {providers.length === 0 ? (
          <p className="text-muted-foreground text-sm">No providers are configured yet.</p>
        ) : (
          <div className="space-y-2 rounded-md border p-3">
            {providers.map((p) => {
              const outside =
                allowed !== null &&
                approvedIds.has(p.id) &&
                (p.jurisdiction === null || !allowed.has(p.jurisdiction.toUpperCase()));
              return (
                <label key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300"
                    checked={approvedIds.has(p.id)}
                    onChange={(e) => toggle(p.id, e.target.checked)}
                  />
                  {p.name}
                  <span className="text-muted-foreground font-mono text-xs">{p.slug}</span>
                  {p.jurisdiction && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {p.jurisdiction}
                    </Badge>
                  )}
                  {!p.isActive && (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                      inactive
                    </Badge>
                  )}
                  {outside && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      · outside the jurisdictions below, so still refused
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {orphaned > 0 && (
          <p className="text-muted-foreground text-xs">
            {orphaned} grant{orphaned === 1 ? ' names a provider' : 's name providers'} that has
            since been deleted. {orphaned === 1 ? 'It grants' : 'They grant'} nothing, and saving
            removes {orphaned === 1 ? 'it' : 'them'}.
          </p>
        )}
      </fieldset>

      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <Switch
            id="restrict-jurisdictions"
            checked={restricted}
            onCheckedChange={(on) => {
              setSaved(false);
              setRestricted(on);
            }}
          />
          <Label htmlFor="restrict-jurisdictions">
            Restrict to jurisdictions{' '}
            <FieldHelp title="Holding an organisation to jurisdictions">
              <p>
                When on, the organisation may use an approved provider only if the provider&apos;s
                recorded jurisdiction is one listed here. A provider with no jurisdiction recorded
                does not match — record it on the provider&apos;s own page.
              </p>
              <p className="mt-2">
                Codes are short and case-insensitive, separated by commas: for example{' '}
                <code>EU, UK</code>.
              </p>
            </FieldHelp>
          </Label>
        </div>
        {restricted && (
          <Input
            id="jurisdictions"
            aria-label="Jurisdictions"
            placeholder="EU, UK"
            value={jurisdictionText}
            onChange={(e) => {
              setSaved(false);
              setJurisdictionText(e.target.value);
            }}
            className="max-w-sm font-mono"
          />
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save approved providers'}
        </Button>
        {saved && <span className="text-sm text-green-600">Saved</span>}
        {error && (
          <span role="alert" className="text-destructive text-sm">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
