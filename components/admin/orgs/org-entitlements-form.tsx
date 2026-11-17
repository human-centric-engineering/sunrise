'use client';

/**
 * OrgEntitlementsForm — the switches an org has (§135 t-1033)
 *
 * The admin UI for `/api/v1/admin/orgs/[id]/entitlements`. A platform admin
 * ticks the switches the org has; a save (`PATCH`) sets each switch shown here
 * on or off, and leaves alone any it was not shown. Clearing (`DELETE`) puts
 * every switch back to its default. The page renders this only when the app
 * registers at least one switch, or its registration failed, so vanilla
 * Sunrise shows nothing new.
 *
 * What it says rather than hides:
 *  - **Nothing set**: every switch is at its default, and the boxes show those
 *    defaults. Saving sets them on the organisation itself.
 *  - **At its default**: one switch nobody has set here (one registered since
 *    the last save), which follows its default until it is saved.
 *  - **Unreadable**: the stored switches could not be read, so the org has
 *    none until it is saved again.
 *  - **Stored but not registered**: keys no app registers any more. They are
 *    off, and a save keeps them.
 *  - **Cannot change here**: at `multi`, from a customer's org, the switches
 *    are shown but can only be changed from the install organisation.
 *  - **Registration failed**: the app's switches could not be registered, so
 *    every organisation has none of them.
 */

import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** `GET /api/v1/admin/orgs/[id]/entitlements`, as the route reports it. */
export interface OrgEntitlementsView {
  orgId: string;
  nothingSet: boolean;
  unreadable: boolean;
  /** Whether this caller may change them from where they are. */
  mayChange: boolean;
  /** The app's switches failed to register, so every org has none of them. */
  registrationFailed: boolean;
  switches: {
    key: string;
    label: string;
    description: string;
    whenNothingSet: boolean;
    on: boolean;
    /** Nobody has set it on this org, so it follows `whenNothingSet`. */
    atDefault: boolean;
  }[];
  unregistered: string[];
}

export interface OrgEntitlementsFormProps {
  orgId: string;
  entitlements: OrgEntitlementsView;
}

/** Why the switches are read-only from a customer's org, for the shared notice. */
const SWITCHES_READ_ONLY =
  'An organisation’s switches can only be changed from the install organisation, so that no organisation can grant itself one.';

function onKeys(view: OrgEntitlementsView): Set<string> {
  return new Set(view.switches.filter((s) => s.on).map((s) => s.key));
}

export function OrgEntitlementsForm({ orgId, entitlements: initial }: OrgEntitlementsFormProps) {
  const [view, setView] = useState(initial);
  const [ticked, setTicked] = useState(() => onKeys(initial));
  const [saving, setSaving] = useState(false);
  // What the last write that landed did, said beside the buttons.
  const [done, setDone] = useState<'Saved' | 'Cleared to defaults' | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  // No field shows its own message, so every one the server sends joins the
  // summary by Save.
  const saveFailure = useSaveFailure({
    fallback: 'Could not save the switches',
    fields: NO_SERVER_FIELDS,
  });
  // Clearing is confirmed in its dialog, so its failure shows there.
  const clearFailure = useSaveFailure({
    fallback: 'Could not clear the switches',
    fields: NO_SERVER_FIELDS,
  });
  const clearDialog = useCommittedDialog({
    open: confirmingClear,
    pending: saving,
    onClose: () => setConfirmingClear(false),
    clear: clearFailure.clear,
  });

  const toggle = (key: string, on: boolean) => {
    setDone(null);
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** Whether the write landed; a failure is shown by `failure`. */
  const write = async (
    send: () => Promise<OrgEntitlementsView>,
    failure: typeof saveFailure,
    said: NonNullable<typeof done>
  ): Promise<boolean> => {
    failure.clear();
    setSaving(true);
    setDone(null);
    try {
      const updated = await send();
      setView(updated);
      setTicked(onKeys(updated));
      // Whichever write failed before, the switches are now as shown.
      saveFailure.clear();
      clearFailure.clear();
      setDone(said);
      return true;
    } catch (err) {
      failure.report(err);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Every switch shown, on or off; a switch this form was not shown is left alone.
  const save = () =>
    write(
      () =>
        apiClient.patch<OrgEntitlementsView>(API.ADMIN.orgEntitlements(orgId), {
          body: {
            on: view.switches.filter((s) => ticked.has(s.key)).map((s) => s.key),
            off: view.switches.filter((s) => !ticked.has(s.key)).map((s) => s.key),
          },
        }),
      saveFailure,
      'Saved'
    );

  const clearToDefaults = async () => {
    const cleared = await write(
      () => apiClient.delete<OrgEntitlementsView>(API.ADMIN.orgEntitlements(orgId)),
      clearFailure,
      'Cleared to defaults'
    );
    if (cleared) setConfirmingClear(false);
  };

  if (view.registrationFailed) {
    return (
      <p className="text-destructive text-sm">
        The app&apos;s switches could not be registered, so every organisation has none of them. The
        server log says why.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {view.unreadable && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          The switches stored on this organisation could not be read, so it has none of them on
          until they are saved again.{' '}
          {view.mayChange
            ? 'Tick what it should have and save.'
            : 'They can be set again from the install organisation.'}
        </div>
      )}
      {view.nothingSet && (
        <p className="text-muted-foreground text-sm">
          None of these switches has been set on this organisation, so each is at its default, as
          ticked below. Saving sets them on the organisation itself.
        </p>
      )}
      {/* The shared notice: it offers the switch, or says why there is none. */}
      {!view.mayChange && <SharedSettingsReadOnlyNotice reason={SWITCHES_READ_ONLY} />}

      {/* Locked while a save runs, so a tick made meanwhile is not lost when it lands. */}
      <fieldset className="grid gap-2" disabled={saving || !view.mayChange}>
        <legend className="mb-2 text-sm font-medium">
          What this organisation has{' '}
          <FieldHelp title="Entitlement switches">
            <p>
              Each switch opens a part of the app this organisation has bought or may use. Ticking
              one gives it to the organisation; its own admins cannot change these.
            </p>
            <p className="mt-2">
              A switch nobody has set on this organisation is at its default, marked{' '}
              <em>on by default</em> when that is on. Clearing puts every switch back to its
              default.
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
                {!view.nothingSet && s.atDefault && (
                  <span className="text-muted-foreground block text-xs italic">
                    Not set on this organisation yet, so it is at its default.
                  </span>
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

      {view.mayChange && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save switches'}
            </Button>
            {!view.nothingSet && (
              <Button variant="outline" onClick={() => setConfirmingClear(true)} disabled={saving}>
                Clear to defaults
              </Button>
            )}
            {done && <span className="text-sm text-green-600">{done}</span>}
          </div>
          <SaveError failure={saveFailure.failure} />
        </div>
      )}

      <AlertDialog open={confirmingClear} onOpenChange={clearDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this organisation&apos;s switches</AlertDialogTitle>
            <AlertDialogDescription>
              Every switch goes back to its default now: the organisation loses each one that is off
              by default and gains each one that is on by default. You can set them again at any
              time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={clearFailure.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...clearDialog.cancelProps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              {...clearDialog.actionProps()}
              onClick={(e) => clearDialog.confirm(e, clearToDefaults)}
            >
              Clear to defaults
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
