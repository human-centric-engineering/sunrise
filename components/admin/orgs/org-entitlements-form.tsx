'use client';

/**
 * OrgEntitlementsForm — the switches an org has (§135 t-1033)
 *
 * The admin UI for `GET`/`PUT /api/v1/admin/orgs/[id]/entitlements`. A
 * platform admin ticks the switches the org has; a save sets exactly those.
 * The page renders this only when the app registers at least one switch, so
 * vanilla Sunrise shows nothing new.
 *
 * Three states it says rather than hides:
 *  - **Nothing set**: the org gets each switch's default, and the boxes show
 *    those defaults. Saving turns them into a set of the org's own.
 *  - **Unreadable**: the stored switches could not be read, so the org has
 *    none until it is saved again.
 *  - **Stored but not registered**: keys no app registers any more. They are
 *    off, and a save keeps them.
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** `GET /api/v1/admin/orgs/[id]/entitlements`, as the route reports it. */
export interface OrgEntitlementsView {
  orgId: string;
  nothingSet: boolean;
  unreadable: boolean;
  switches: {
    key: string;
    label: string;
    description: string;
    whenNothingSet: boolean;
    on: boolean;
  }[];
  unregistered: string[];
}

export interface OrgEntitlementsFormProps {
  orgId: string;
  entitlements: OrgEntitlementsView;
}

function onKeys(view: OrgEntitlementsView): Set<string> {
  return new Set(view.switches.filter((s) => s.on).map((s) => s.key));
}

export function OrgEntitlementsForm({ orgId, entitlements: initial }: OrgEntitlementsFormProps) {
  const [view, setView] = useState(initial);
  const [ticked, setTicked] = useState(() => onKeys(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // No field shows its own message, so every one the server sends joins the
  // summary by Save.
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the switches',
    fields: NO_SERVER_FIELDS,
  });

  const toggle = (key: string, on: boolean) => {
    setSaved(false);
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const put = async (switches: string[] | null) => {
    saveFailure.clear();
    setSaving(true);
    setSaved(false);
    try {
      const updated = await apiClient.put<OrgEntitlementsView>(API.ADMIN.orgEntitlements(orgId), {
        body: { switches },
      });
      setView(updated);
      setTicked(onKeys(updated));
      setSaved(true);
    } catch (err) {
      saveFailure.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {view.unreadable && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          The switches stored on this organisation could not be read, so it has none of them on
          until they are saved again. Tick what it should have and save.
        </div>
      )}
      {view.nothingSet && (
        <p className="text-muted-foreground text-sm">
          Nothing has been set on this organisation, so each switch is at its default, as ticked
          below. Saving sets these switches on the organisation itself.
        </p>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">
          What this organisation has{' '}
          <FieldHelp title="Entitlement switches">
            <p>
              Each switch opens a part of the app this organisation has bought or may use. Ticking
              one gives it to the organisation; its own admins cannot change these.
            </p>
            <p className="mt-2">
              An organisation nobody has set anything on gets each switch&apos;s default, marked{' '}
              <em>on by default</em>. Clearing returns it to those defaults.
            </p>
          </FieldHelp>
        </legend>
        <div className="space-y-3 rounded-md border p-3">
          {view.switches.map((s) => (
            <label key={s.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 rounded border-gray-300"
                checked={ticked.has(s.key)}
                onChange={(e) => toggle(s.key, e.target.checked)}
              />
              <span className="space-y-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  {s.label}
                  <span className="text-muted-foreground font-mono text-xs">{s.key}</span>
                  {s.whenNothingSet && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      on by default
                    </Badge>
                  )}
                </span>
                {s.description && (
                  <span className="text-muted-foreground block text-xs">{s.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        {view.unregistered.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Also stored: <span className="font-mono">{view.unregistered.join(', ')}</span>. Nothing
            registers {view.unregistered.length === 1 ? 'it' : 'them'} any more, so{' '}
            {view.unregistered.length === 1 ? 'it is' : 'they are'} off. Saving keeps{' '}
            {view.unregistered.length === 1 ? 'it' : 'them'}.
          </p>
        )}
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void put([...ticked])} disabled={saving}>
            {saving ? 'Saving…' : 'Save switches'}
          </Button>
          {!view.nothingSet && (
            <Button variant="outline" onClick={() => void put(null)} disabled={saving}>
              Clear to defaults
            </Button>
          )}
          {saved && <span className="text-sm text-green-600">Saved</span>}
        </div>
        <SaveError failure={saveFailure.failure} />
      </div>
    </div>
  );
}
