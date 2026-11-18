'use client';

/**
 * This organisation's AI keys, one card per provider (§137 t-1045): what each
 * provider's calls go out on, and the actions on its key — save or replace,
 * test, remove.
 *
 * The list comes from the server page (`GET /api/v1/orgs/[id]/provider-keys`);
 * every action refreshes it. The API decides who may do what and its refusals
 * show as worded; this hides the save form only where the API said saving is
 * blocked, so the page never offers what will be refused.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ClientDate } from '@/components/ui/client-date';
import { SaveError } from '@/components/forms/form-error';
import { ProviderKeyForm } from '@/components/admin/provider-keys/provider-key-form';
import {
  stateBadge,
  stateSentence,
  testFailureSentence,
  type ProviderKeyRow,
} from '@/components/admin/provider-keys/provider-key-states';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';

export interface ProviderKeysListProps {
  orgId: string;
  providers: ProviderKeyRow[];
  /** Whether the viewer may save a key here (the API's `saveBlocked` is null). */
  canSave: boolean;
}

export function ProviderKeysList({ orgId, providers, canSave }: ProviderKeysListProps) {
  const router = useRouter();
  const [removing, setRemoving] = useState<ProviderKeyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const removeSave = useSaveFailure({
    fallback: 'The key could not be removed. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  const remove = async (row: ProviderKeyRow) => {
    setBusy(true);
    removeSave.clear();
    try {
      await apiClient.delete(API.ORGS.providerKey(orgId, row.providerConfigId));
      setRemoving(null);
      router.refresh();
    } catch (err) {
      removeSave.report(err);
    } finally {
      setBusy(false);
    }
  };

  const removeDialog = useCommittedDialog({
    open: !!removing,
    pending: busy,
    onClose: () => setRemoving(null),
    clear: removeSave.clear,
  });

  if (providers.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This organisation is not approved for any provider that takes a key. Platform staff approve
        providers.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {providers.map((row) => (
        <ProviderKeyCard
          key={row.providerConfigId}
          orgId={orgId}
          row={row}
          canSave={canSave && row.approved}
          disabled={busy}
          onRemove={() => setRemoving(row)}
        />
      ))}

      <AlertDialog open={!!removing} onOpenChange={removeDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {removing?.name} key</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.approved
                ? `This organisation's calls to ${removing.name} go back to the platform's key straight away.`
                : `This organisation is not approved for ${removing?.name ?? 'this provider'}, so its calls to it stay refused.`}{' '}
              The key is deleted: to use it again, save it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={removeSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...removeDialog.cancelProps}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              {...removeDialog.actionProps()}
              onClick={(e) =>
                removeDialog.confirm(e, () => {
                  if (removing) void remove(removing);
                })
              }
            >
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ProviderKeyCardProps {
  orgId: string;
  row: ProviderKeyRow;
  canSave: boolean;
  disabled: boolean;
  onRemove: () => void;
}

type TestOutcome = { ok: true } | { ok: false; reason: 'test_failed' | 'will_not_open' };

function ProviderKeyCard({ orgId, row, canSave, disabled, onRemove }: ProviderKeyCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const testRequest = useSaveFailure({
    fallback: 'The key could not be tested. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const badge = stateBadge(row);

  const test = async () => {
    setTesting(true);
    setOutcome(null);
    testRequest.clear();
    try {
      const result = await apiClient.post<TestOutcome>(
        API.ORGS.providerKeyTest(orgId, row.providerConfigId)
      );
      setOutcome(result);
      // The state can have changed since the page loaded (a key that will not open).
      router.refresh();
    } catch (err) {
      testRequest.report(err);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-lg">{row.name}</CardTitle>
          <Badge
            variant={badge.problem ? 'destructive' : row.key ? 'default' : 'outline'}
            className="px-1.5 py-0 text-[10px]"
          >
            {badge.label}
          </Badge>
        </div>
        <CardDescription>{stateSentence(row)}</CardDescription>
      </CardHeader>
      {/* Nothing to show or do: no key, and saving is not offered here. */}
      {(row.key || canSave) && (
        <CardContent className="space-y-3">
          {row.key && (
            <p className="text-sm">
              {row.key.hint ? (
                <>
                  Key ending <span className="font-mono">…{row.key.hint}</span>, saved{' '}
                </>
              ) : (
                'Saved '
              )}
              <ClientDate date={row.key.savedAt} showTime />
              {row.key.savedBy ? ` by ${row.key.savedBy.name}` : ''}.
            </p>
          )}

          {editing ? (
            <ProviderKeyForm
              orgId={orgId}
              providerConfigId={row.providerConfigId}
              providerName={row.name}
              replaces={!!row.key}
              onDone={() => {
                setEditing(false);
                setOutcome(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {canSave && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setEditing(true)}
                >
                  {row.key ? 'Replace key' : 'Add your own key'}
                </Button>
              )}
              {row.key && row.approved && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || testing}
                  onClick={() => void test()}
                >
                  <FlaskConical className="mr-2 h-4 w-4" />
                  {testing ? 'Testing…' : 'Test key'}
                </Button>
              )}
              {row.key && (
                <Button size="sm" variant="outline" disabled={disabled} onClick={onRemove}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remove key
                </Button>
              )}
            </div>
          )}

          {outcome && (
            <p role="status" className={outcome.ok ? 'text-sm' : 'text-destructive text-sm'}>
              {outcome.ok
                ? `${row.name} accepted the key.`
                : testFailureSentence(row.name, outcome.reason)}
            </p>
          )}
          <SaveError failure={testRequest.failure} />
        </CardContent>
      )}
    </Card>
  );
}
