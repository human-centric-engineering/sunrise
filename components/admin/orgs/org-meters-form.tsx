'use client';

/**
 * OrgMetersForm — what an org uses against its limits (§135 t-1035)
 *
 * The admin UI for `/api/v1/admin/orgs/[id]/meters`. Each meter (the
 * platform's seats, then any the app registers) shows how many the org has
 * within the meter's window and its limit. A platform admin types a limit, or
 * empties the box for none; a save (`PATCH`) names only the meters whose limit
 * the admin changed, so a limit the form was not shown is left alone.
 *
 * What it says rather than hides:
 *  - **No limit**: the meter is shown with its count, and nothing is refused.
 *  - **Over its limit**: an org can be over when a limit is lowered below what
 *    it already has. Nothing is taken away; it cannot add more.
 *  - **Could not be counted**: the app's count or window failed, so the meter
 *    refuses nothing until it is fixed. The server log says why.
 *  - **Stored but not registered**: limits for keys nothing registers any
 *    more. They limit nothing; a save keeps them, and they can be cleared.
 *  - **Cannot change here**: at `multi`, from a customer's org, the limits
 *    are shown but can only be changed from the install organisation.
 *  - **Registration failed**: the app's meters could not be registered, so
 *    only seats is shown.
 */

import { useState } from 'react';

import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** `GET /api/v1/admin/orgs/[id]/meters`, as the route reports it. */
export interface OrgMetersView {
  orgId: string;
  /** Whether this caller may change them from where they are. */
  mayChange: boolean;
  /** The app's meters (and switches) failed to register. */
  registrationFailed: boolean;
  meters: {
    key: string;
    label: string;
    description: string;
    period: 'month' | 'standing' | 'custom';
    /** The platform's own count, rather than one the app registered. */
    core: boolean;
    limit: number | null;
    used: number | null;
    /** ISO dates over JSON; both `null` for a standing count. */
    window: { from: string | null; to: string | null } | null;
    countFailed: boolean;
  }[];
  /** Limits stored for keys nothing registers any more. */
  unregistered: Record<string, number>;
}

export interface OrgMetersFormProps {
  orgId: string;
  meters: OrgMetersView;
}

/** Why the limits are read-only from a customer's org, for the shared notice. */
const LIMITS_READ_ONLY =
  'An organisation’s limits can only be changed from the install organisation, so that no organisation can raise its own.';

type Meter = OrgMetersView['meters'][number];

function draftsOf(view: OrgMetersView): Record<string, string> {
  return Object.fromEntries(
    view.meters.map((m) => [m.key, m.limit === null ? '' : String(m.limit)])
  );
}

/** A day, the same on the server and in the browser. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function windowText(meter: Meter): string {
  if (meter.period === 'standing') return 'now';
  if (meter.period === 'month') return 'this month (UTC)';
  if (meter.window?.from && meter.window.to) {
    // `to` is exclusive, so the last day counted is the one before it.
    const last = new Date(new Date(meter.window.to).getTime() - 1).toISOString();
    return `${day(meter.window.from)} to ${day(last)}`;
  }
  return 'this period';
}

/** A box's limit: `null` for empty (no limit), `undefined` when it is not one. */
function parseLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= 1_000_000_000 ? value : undefined;
}

export function OrgMetersForm({ orgId, meters: initial }: OrgMetersFormProps) {
  const [view, setView] = useState(initial);
  const [drafts, setDrafts] = useState(() => draftsOf(initial));
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // No field shows its own message, so every one the server sends joins the
  // summary by Save.
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the limits',
    fields: NO_SERVER_FIELDS,
  });

  const parsed = view.meters.map((m) => ({ meter: m, limit: parseLimit(drafts[m.key] ?? '') }));
  const invalid = parsed.filter((p) => p.limit === undefined).map((p) => p.meter.key);
  // Only the meters whose limit the admin changed.
  const changed: Record<string, number | null> = {};
  for (const { meter, limit } of parsed) {
    if (limit !== undefined && limit !== meter.limit) changed[meter.key] = limit;
  }
  const anyChange = Object.keys(changed).length > 0;
  const unregisteredKeys = Object.keys(view.unregistered);

  const send = async (limits: Record<string, number | null>, said: string) => {
    saveFailure.clear();
    setSaving(true);
    setDone(null);
    try {
      const updated = await apiClient.patch<OrgMetersView>(API.ADMIN.orgMeters(orgId), {
        body: { limits },
      });
      setView(updated);
      setDrafts(draftsOf(updated));
      setDone(said);
    } catch (err) {
      saveFailure.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {view.registrationFailed && (
        <p className="text-destructive text-sm">
          The app&apos;s meters could not be registered, so only seats is shown. The server log says
          why.
        </p>
      )}
      {!view.mayChange && <SharedSettingsReadOnlyNotice reason={LIMITS_READ_ONLY} />}

      {/* Locked while a save runs, so an edit made meanwhile is not lost when it lands. */}
      <fieldset className="grid gap-2" disabled={saving || !view.mayChange}>
        <legend className="mb-2 text-sm font-medium">
          Usage and limits{' '}
          <FieldHelp title="Limits">
            <p>
              Each meter counts something this organisation has, such as its seats. A limit is the
              most it may have in the period shown; once it is reached, adding another is refused
              until the count falls or the limit is raised. Leave the box empty for no limit.
            </p>
            <p className="mt-2">
              Lowering a limit below what the organisation already has takes nothing away; it cannot
              add more until it is back under. Its own admins cannot change these.
            </p>
          </FieldHelp>
        </legend>
        <div className="divide-y rounded-md border">
          {view.meters.map((m) => {
            const over = m.used !== null && m.limit !== null && m.used > m.limit;
            const atLimit = m.used !== null && m.limit !== null && m.used >= m.limit;
            return (
              <div
                key={m.key}
                className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <label htmlFor={`meter-${m.key}`} className="flex flex-wrap items-center gap-2">
                    {m.label}
                    <span className="text-muted-foreground font-mono text-xs">{m.key}</span>
                    {over ? (
                      <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                        over its limit
                      </Badge>
                    ) : (
                      atLimit && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          at its limit
                        </Badge>
                      )
                    )}
                  </label>
                  {m.description && (
                    <p className="text-muted-foreground text-xs">{m.description}</p>
                  )}
                  <p className="text-xs" data-testid={`meter-usage-${m.key}`}>
                    {m.countFailed ? (
                      <span className="text-destructive">
                        Could not be counted, so it refuses nothing. The server log says why.
                      </span>
                    ) : (
                      <>
                        {m.used} {m.limit === null ? '' : `of ${m.limit} `}
                        {windowText(m)}
                        {m.limit === null && ', no limit'}
                      </>
                    )}
                  </p>
                </div>
                <div className="w-32 space-y-1">
                  <Input
                    id={`meter-${m.key}`}
                    inputMode="numeric"
                    placeholder="No limit"
                    aria-invalid={invalid.includes(m.key)}
                    value={drafts[m.key] ?? ''}
                    onChange={(e) => {
                      setDone(null);
                      setDrafts((current) => ({ ...current, [m.key]: e.target.value }));
                    }}
                  />
                  {invalid.includes(m.key) && (
                    <p className="text-destructive text-xs">A whole number, or empty</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {unregisteredKeys.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Also stored:{' '}
            <span className="font-mono">
              {unregisteredKeys.map((k) => `${k} (${view.unregistered[k]})`).join(', ')}
            </span>
            . Nothing registers {unregisteredKeys.length === 1 ? 'that meter' : 'those meters'} any
            more, so {unregisteredKeys.length === 1 ? 'it limits' : 'they limit'} nothing. Saving
            keeps {unregisteredKeys.length === 1 ? 'it' : 'them'}.
            {view.mayChange && (
              <>
                {' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    void send(Object.fromEntries(unregisteredKeys.map((k) => [k, null])), 'Cleared')
                  }
                >
                  Clear {unregisteredKeys.length === 1 ? 'it' : 'them'}
                </button>
              </>
            )}
          </p>
        )}
      </fieldset>

      {view.mayChange && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void send(changed, 'Saved')}
              disabled={saving || !anyChange || invalid.length > 0}
            >
              {saving ? 'Saving…' : 'Save limits'}
            </Button>
            {done && <span className="text-sm text-green-600">{done}</span>}
          </div>
          <SaveError failure={saveFailure.failure} />
        </div>
      )}
    </div>
  );
}
