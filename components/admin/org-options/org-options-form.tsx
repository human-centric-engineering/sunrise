'use client';

/**
 * OrgOptionsForm — the switches an org's own admins may set (§135 t-1054)
 *
 * The org-tier UI for `/api/v1/orgs/[id]/entitlements`. It lists only the
 * switches the app registers `setBy: 'org'`; what the org bought is set by
 * platform staff elsewhere and is not shown here. A save (`PATCH`) names only
 * the switches the admin changed, so one left at its default stays at its
 * default and follows it if the app changes it.
 *
 * It says rather than hides: a support session sees the options without the
 * buttons, and a stored slice that could not be read is shown as such, with
 * no save, since only platform staff can put it right.
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** `GET /api/v1/orgs/[id]/entitlements`, as the route reports it. */
export interface OrgOptionsView {
  orgId: string;
  unreadable: boolean;
  /** Whether this caller may change them: not in a support session, and the slice was read. */
  mayChange: boolean;
  registrationFailed: boolean;
  switches: {
    key: string;
    label: string;
    description: string;
    whenNothingSet: boolean;
    on: boolean;
    atDefault: boolean;
  }[];
}

function onKeys(view: OrgOptionsView): Set<string> {
  return new Set(view.switches.filter((s) => s.on).map((s) => s.key));
}

export function OrgOptionsForm({
  orgId,
  options: initial,
}: {
  orgId: string;
  options: OrgOptionsView;
}) {
  const [view, setView] = useState(initial);
  const [ticked, setTicked] = useState(() => onKeys(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const failure = useSaveFailure({
    fallback: 'Could not save the options',
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

  // Only what the admin changed, so an option at its default stays there.
  const changed = {
    on: view.switches.filter((s) => !s.on && ticked.has(s.key)).map((s) => s.key),
    off: view.switches.filter((s) => s.on && !ticked.has(s.key)).map((s) => s.key),
  };
  const anyChange = changed.on.length + changed.off.length > 0;

  const save = async () => {
    failure.clear();
    setSaving(true);
    setSaved(false);
    try {
      const updated = await apiClient.patch<OrgOptionsView>(API.ORGS.entitlements(orgId), {
        body: changed,
      });
      setView(updated);
      setTicked(onKeys(updated));
      setSaved(true);
    } catch (err) {
      failure.report(err);
    } finally {
      setSaving(false);
    }
  };

  if (view.registrationFailed) {
    return (
      <p className="text-destructive text-sm">
        The app&apos;s options could not be loaded, so none of them is on. Ask whoever manages your
        organisation&apos;s account to look at it.
      </p>
    );
  }
  if (view.switches.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        There are no options your organisation can change on this install.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {view.unreadable && (
        <div
          role="note"
          className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          This organisation&apos;s options could not be read, so they are all off and cannot be
          changed here. Ask whoever manages your organisation&apos;s account to look at them.
        </div>
      )}
      {!view.unreadable && !view.mayChange && (
        <p role="note" className="rounded-md border p-3 text-sm">
          Support staff can see these options but cannot change them.
        </p>
      )}

      {/* Locked while a save runs, so a tick made meanwhile is not lost when it lands. */}
      <fieldset className="grid gap-2" disabled={saving || !view.mayChange}>
        <legend className="mb-2 text-sm font-medium">
          Options for this organisation{' '}
          <FieldHelp title="Organisation options">
            <p>
              Each option turns a part of the app on or off for everyone in this organisation. Your
              organisation&apos;s admins can change these; what your organisation pays for is set by
              whoever manages its account and is not listed here.
            </p>
            <p className="mt-2">
              An option nobody has changed follows its default, marked <em>on by default</em> when
              that is on.
            </p>
          </FieldHelp>
        </legend>
        <div className="space-y-3 rounded-md border p-3">
          {view.switches.map((s) => (
            <div key={s.key} className="flex items-start gap-2 text-sm">
              <input
                id={`org-option-${s.key}`}
                type="checkbox"
                className="mt-0.5 rounded border-gray-300"
                checked={ticked.has(s.key)}
                onChange={(e) => toggle(s.key, e.target.checked)}
              />
              <div className="space-y-0.5">
                <label
                  htmlFor={`org-option-${s.key}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  {s.label}
                  {s.whenNothingSet && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      on by default
                    </Badge>
                  )}
                </label>
                {s.description && <p className="text-muted-foreground text-xs">{s.description}</p>}
                {s.atDefault && (
                  <p className="text-muted-foreground text-xs italic">
                    Not changed here yet, so it follows its default.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {view.mayChange && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={saving || !anyChange}>
              {saving ? 'Saving…' : 'Save options'}
            </Button>
            {saved && <span className="text-sm text-green-600">Saved</span>}
          </div>
          <SaveError failure={failure.failure} />
        </div>
      )}
    </div>
  );
}
