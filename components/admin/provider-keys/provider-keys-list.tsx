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
import { useFormatter, useTranslations } from 'next-intl';
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
import { SaveError } from '@/components/forms/form-error';
import { ProviderKeyForm } from '@/components/admin/provider-keys/provider-key-form';
import {
  stateBadge,
  stateSentenceKey,
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
  /** Whether the viewer may test or remove a key: not in a READ_ONLY support session. */
  canChange: boolean;
  /** No master key is configured, so no saved key opens. */
  masterKeyMissing: boolean;
}

export function ProviderKeysList({
  orgId,
  providers,
  canSave,
  canChange,
  masterKeyMissing,
}: ProviderKeysListProps) {
  const t = useTranslations('admin.providerKeys');
  const tShell = useTranslations('admin.shell');
  const router = useRouter();
  const [removing, setRemoving] = useState<ProviderKeyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const removeSave = useSaveFailure({
    fallback: t('list.removeFailed'),
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
    return <p className="text-muted-foreground text-sm">{t('list.none')}</p>;
  }

  return (
    <div className="space-y-4">
      {providers.map((row) => (
        <ProviderKeyCard
          key={row.providerConfigId}
          orgId={orgId}
          row={row}
          canSave={canSave && row.approved && row.takesKey}
          canChange={canChange}
          masterKeyMissing={masterKeyMissing}
          disabled={busy}
          onRemove={() => setRemoving(row)}
        />
      ))}

      <AlertDialog open={!!removing} onOpenChange={removeDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('list.removeTitle', { name: removing?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing && t(`list.${removeConsequenceKey(removing)}`, { name: removing.name })}{' '}
              {t('list.removeDeleted')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={removeSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...removeDialog.cancelProps}>{tShell('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              {...removeDialog.actionProps()}
              onClick={(e) =>
                removeDialog.confirm(e, () => {
                  if (removing) void remove(removing);
                })
              }
            >
              {t('list.removeKey')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * What removing a key does to the org's calls. "Within a minute", not "now":
 * another server process can keep the old answer for up to a minute.
 */
function removeConsequenceKey(
  row: ProviderKeyRow
): 'removeNotTaken' | 'removeNotApproved' | 'removeBackToPlatform' {
  if (!row.takesKey) return 'removeNotTaken';
  if (!row.approved) return 'removeNotApproved';
  return 'removeBackToPlatform';
}

interface ProviderKeyCardProps {
  orgId: string;
  row: ProviderKeyRow;
  canSave: boolean;
  canChange: boolean;
  masterKeyMissing: boolean;
  disabled: boolean;
  onRemove: () => void;
}

type TestOutcome = { ok: true } | { ok: false; reason: 'test_failed' | 'will_not_open' };

function ProviderKeyCard({
  orgId,
  row,
  canSave,
  canChange,
  masterKeyMissing,
  disabled,
  onRemove,
}: ProviderKeyCardProps) {
  const t = useTranslations('admin.providerKeys');
  const format = useFormatter();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const testRequest = useSaveFailure({
    fallback: t('test.failed'),
    fields: NO_SERVER_FIELDS,
  });
  const badge = stateBadge(row);

  /** When the key was saved, and by whom, ending in the hint when there is one. */
  const savedLine = (key: NonNullable<ProviderKeyRow['key']>) => {
    const when = format.dateTime(new Date(key.savedAt), 'dateTime');
    const hint = (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>;
    if (key.savedBy) {
      return key.hint
        ? t.rich('list.savedBy', { hint, when, who: key.savedBy.name, hintValue: key.hint })
        : t('list.savedByNoHint', { when, who: key.savedBy.name });
    }
    return key.hint
      ? t.rich('list.keyEnding', { hint, when, hintValue: key.hint })
      : t('list.saved', { when });
  };

  const test = async () => {
    setTesting(true);
    setOutcome(null);
    testRequest.clear();
    try {
      const result = await apiClient.post<TestOutcome>(
        API.ORGS.providerKeyTest(orgId, row.providerConfigId)
      );
      setOutcome(result);
      // A failed test can mean the state moved since the page loaded (a key
      // that no longer opens); a passing one cannot.
      if (!result.ok) router.refresh();
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
            {t(`badge.${badge.key}`)}
          </Badge>
        </div>
        <CardDescription>
          {t(`state.${stateSentenceKey(row, { masterKeyMissing })}`, { name: row.name })}
        </CardDescription>
      </CardHeader>
      {/* Nothing to show or do: no key, and saving is not offered here. */}
      {(row.key || canSave) && (
        <CardContent className="space-y-3">
          {row.key && <p className="text-sm">{savedLine(row.key)}</p>}

          {editing && canSave ? (
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
                  {row.key ? t('list.replace') : t('list.add')}
                </Button>
              )}
              {canChange && row.key && row.approved && row.takesKey && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || testing}
                  onClick={() => void test()}
                >
                  <FlaskConical className="mr-2 h-4 w-4" />
                  {testing ? t('list.testing') : t('list.testKey')}
                </Button>
              )}
              {canChange && row.key && (
                <Button size="sm" variant="outline" disabled={disabled} onClick={onRemove}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('list.removeKey')}
                </Button>
              )}
            </div>
          )}

          {outcome && (
            <p role="status" className={outcome.ok ? 'text-sm' : 'text-destructive text-sm'}>
              {outcome.ok
                ? t('test.accepted', { name: row.name })
                : t(`test.${outcome.reason}`, { name: row.name })}
            </p>
          )}
          <SaveError failure={testRequest.failure} />
        </CardContent>
      )}
    </Card>
  );
}
