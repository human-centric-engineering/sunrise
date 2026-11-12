'use client';

/**
 * OrgPrivacyForm — an org's LLM privacy minimum and protected terms (§127 t-1010)
 *
 * The admin UI for `GET`/`PUT /api/v1/admin/orgs/[id]/privacy`. A save
 * replaces both. Two states it says rather than hides:
 *  - **Never saved**: the org's own name is offered as a first protected term,
 *    as the spec's default; it is stored only when the admin saves.
 *  - **Unreadable**: the stored settings cannot be read, so the privacy layer
 *    refuses every AI call made for the org until they are saved again.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import {
  isTighteningMode,
  PRIVACY_MODE_LABELS,
  PRIVACY_TIGHTENING_MODES,
  type PrivacyTighteningMode,
} from '@/lib/orchestration/privacy/settings-policy';
import {
  MAX_ORG_PROTECTED_TERMS,
  ORG_PROTECTED_TERM_MAX_LENGTH,
  ORG_PROTECTED_TERM_MIN_LENGTH,
  type OrgProtectedTerm,
} from '@/lib/validations/tenancy';

/** `GET /api/v1/admin/orgs/[id]/privacy`, as the route reports it. */
export interface OrgPrivacyView {
  orgId: string;
  /** Whether the org has ever saved these settings. */
  saved: boolean;
  /** The stored settings cannot be read; every call for the org is refused. */
  unreadable: boolean;
  minimumMode: PrivacyTighteningMode | null;
  protectedTerms: OrgProtectedTerm[];
}

export interface OrgPrivacyFormProps {
  orgId: string;
  orgName: string;
  privacy: OrgPrivacyView;
}

const NO_MINIMUM = '__none__';

const TERM_TYPE_LABELS: Record<OrgProtectedTerm['type'], string> = {
  PERSON: 'Person',
  ORG: 'Organisation',
};

/** The terms to show: the stored ones, or the org's own name before a first save. */
function initialTerms(privacy: OrgPrivacyView, orgName: string): OrgProtectedTerm[] {
  if (privacy.saved || privacy.unreadable) return privacy.protectedTerms;
  const name = orgName.trim();
  return name.length >= ORG_PROTECTED_TERM_MIN_LENGTH &&
    name.length <= ORG_PROTECTED_TERM_MAX_LENGTH
    ? [{ value: name, type: 'ORG' }]
    : [];
}

export function OrgPrivacyForm({ orgId, orgName, privacy: initial }: OrgPrivacyFormProps) {
  const [privacy, setPrivacy] = useState(initial);
  const [minimumMode, setMinimumMode] = useState<PrivacyTighteningMode | null>(initial.minimumMode);
  const [terms, setTerms] = useState(() => initialTerms(initial, orgName));
  const [newValue, setNewValue] = useState('');
  const [newType, setNewType] = useState<OrgProtectedTerm['type']>('PERSON');
  const [termError, setTermError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the privacy settings',
    fields: NO_SERVER_FIELDS,
  });

  const changed = () => setSaved(false);

  const addTerm = () => {
    const value = newValue.trim();
    if (value.length === 0) return;
    // The API's own rules, said where the term was typed rather than as a
    // failed save of the whole list.
    if (value.length < ORG_PROTECTED_TERM_MIN_LENGTH) {
      setTermError(`A protected term needs at least ${ORG_PROTECTED_TERM_MIN_LENGTH} characters`);
      return;
    }
    if (value.length > ORG_PROTECTED_TERM_MAX_LENGTH) {
      setTermError(`A protected term must be at most ${ORG_PROTECTED_TERM_MAX_LENGTH} characters`);
      return;
    }
    if (terms.length >= MAX_ORG_PROTECTED_TERMS) {
      setTermError(`At most ${MAX_ORG_PROTECTED_TERMS} protected terms`);
      return;
    }
    const lower = value.toLowerCase();
    if (terms.some((t) => t.type === newType && t.value.toLowerCase() === lower)) {
      setTermError(`${value} is already protected`);
      return;
    }
    setTermError(null);
    changed();
    setTerms((current) => [...current, { value, type: newType }]);
    setNewValue('');
  };

  const removeTerm = (index: number) => {
    changed();
    setTerms((current) => current.filter((_, i) => i !== index));
  };

  const save = async () => {
    saveFailure.clear();
    setSaving(true);
    setSaved(false);
    try {
      const updated = await apiClient.put<OrgPrivacyView>(API.ADMIN.orgPrivacy(orgId), {
        body: { minimumMode, protectedTerms: terms },
      });
      setPrivacy(updated);
      setMinimumMode(updated.minimumMode);
      setTerms(updated.protectedTerms);
      setSaved(true);
    } catch (err) {
      saveFailure.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {privacy.unreadable && (
        <div
          className="border-destructive/50 bg-destructive/10 rounded-md border p-3 text-sm"
          data-testid="org-privacy-unreadable"
        >
          This organisation&apos;s stored privacy settings cannot be read, so every AI call made for
          it is refused. Choose its settings below and save to fix this.
        </div>
      )}
      {!privacy.saved && !privacy.unreadable && terms.length > 0 && (
        <p className="text-muted-foreground text-sm" data-testid="org-privacy-suggested">
          The organisation&apos;s own name is suggested as a first protected term. Nothing is
          protected until you save.
        </p>
      )}

      <div className="grid gap-2">
        <Label htmlFor="org-privacy-minimum">
          Minimum privacy mode{' '}
          <FieldHelp title="Minimum privacy mode">
            <p>
              The least protection every AI call made for this organisation gets. It can only make
              protection stricter: a call runs under whichever is strictest of the install&apos;s
              mode, the agent&apos;s own mode and this minimum.
            </p>
            <p className="mt-2">
              Use it when this organisation needs more protection than the install gives everyone,
              for example a client whose contract requires personal details to be masked.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={minimumMode ?? NO_MINIMUM}
          onValueChange={(v) => {
            changed();
            setMinimumMode(isTighteningMode(v) ? v : null);
          }}
        >
          <SelectTrigger id="org-privacy-minimum" className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_MINIMUM}>No minimum (use the install&apos;s mode)</SelectItem>
            {PRIVACY_TIGHTENING_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {PRIVACY_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {minimumMode === 'block' && terms.length > 0 && (
        <div
          className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          data-testid="org-privacy-block-terms"
        >
          Under Block, any call that contains a protected term is refused, and that includes an
          agent&apos;s own instructions: an agent told it works for {orgName} cannot answer at all
          if that name is protected. Remove the organisation&apos;s own name from the terms, or
          choose Pseudonymise, which masks it instead.
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">
          Protected terms{' '}
          <FieldHelp title="Protected terms">
            <p>
              Names that are always treated as personal details in this organisation&apos;s AI
              calls: its clients, its staff, its own name. They are found the ways people write
              them, such as a surname alone or initials, and protected as the privacy mode says:
              counted, masked or refused.
            </p>
            <p className="mt-2">
              Each needs at least 3 characters. Choose Person or Organisation so the variants looked
              for fit the name.
            </p>
          </FieldHelp>
        </legend>
        {terms.length === 0 ? (
          <p className="text-muted-foreground text-sm">No protected terms.</p>
        ) : (
          <ul className="space-y-1 rounded-md border p-3" data-testid="org-privacy-terms">
            {terms.map((term, index) => (
              <li key={`${term.type}:${term.value}`} className="flex items-center gap-2 text-sm">
                <span>{term.value}</span>
                <span className="text-muted-foreground text-xs">{TERM_TYPE_LABELS[term.type]}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${term.value}`}
                  onClick={() => removeTerm(index)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="New protected term"
            placeholder="Jane Hart"
            value={newValue}
            onChange={(e) => {
              setTermError(null);
              setNewValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTerm();
              }
            }}
            className="max-w-xs"
          />
          <Select value={newType} onValueChange={(v) => setNewType(v === 'ORG' ? 'ORG' : 'PERSON')}>
            <SelectTrigger aria-label="Kind of name" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PERSON">{TERM_TYPE_LABELS.PERSON}</SelectItem>
              <SelectItem value="ORG">{TERM_TYPE_LABELS.ORG}</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" onClick={addTerm}>
            Add
          </Button>
        </div>
        {termError && (
          <p className="text-destructive text-xs" role="alert" data-testid="org-privacy-term-error">
            {termError}
          </p>
        )}
      </fieldset>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save privacy settings'}
          </Button>
          {saved && <span className="text-sm text-green-600">Saved</span>}
        </div>
        <SaveError failure={saveFailure.failure} />
      </div>
    </div>
  );
}
