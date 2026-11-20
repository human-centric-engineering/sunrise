'use client';

/**
 * Invite a wave of people from the waitlist (§125 t-978, decision 7): the
 * next N by join date, or N chosen at random, optionally from one list and
 * with one answer. Over `POST /api/v1/admin/waitlist/invite`, which reports
 * every row; this shows the totals and why anyone was not invited.
 *
 * The ticked-rows wave goes through the same route from the table; its
 * result is shown by {@link WaveSummary}, exported for that.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { WAITLIST_INVITE_REFUSALS } from '@/lib/waitlist/invite-refusals';
import { WAITLIST_INVITE_WAVE_MAX, type WaitlistFieldShape } from '@/lib/validations/waitlist';

/** The server's own list, so a reason added there is read here without an edit. */
const refusalSchema = z.enum(WAITLIST_INVITE_REFUSALS);

/** The wave route's answer, checked rather than assumed. */
export const waveResultSchema = z.object({
  selected: z.number(),
  invited: z.number(),
  refused: z.number(),
  failed: z.number(),
  emailNotSent: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      outcome: z.enum(['invited', 'resent', 'refused', 'failed']),
      reason: refusalSchema.optional(),
      emailStatus: z.string().optional(),
    })
  ),
});

export type WaveResult = z.infer<typeof waveResultSchema>;

/** Post a wave and read its answer. */
export async function postWave(body: Record<string, unknown>): Promise<WaveResult> {
  const data = await apiClient.post<unknown>(API.ADMIN.WAITLIST_INVITE_WAVE, { body });
  return waveResultSchema.parse(data);
}

/** What a wave did, in a sentence or two, with the reasons anyone was left out. */
export function WaveSummary({ result }: { result: WaveResult }) {
  const t = useTranslations('admin.waitlist');
  if (result.selected === 0) {
    return (
      <p role="status" className="text-sm">
        {t('wave.noneMatched')}
      </p>
    );
  }
  const reasons = new Map<string, number>();
  for (const row of result.rows) {
    if (row.outcome === 'refused' && row.reason) {
      const message = t(`refusals.${row.reason}`);
      reasons.set(message, (reasons.get(message) ?? 0) + 1);
    }
  }
  const sentences = [
    t('wave.invitedOf', { invited: result.invited, selected: result.selected }),
    ...(result.emailNotSent > 0 ? [t('wave.emailNotSent', { count: result.emailNotSent })] : []),
    ...(result.failed > 0 ? [t('wave.failed', { count: result.failed })] : []),
  ];
  return (
    <div role="status" className="space-y-1 text-sm">
      <p>{sentences.join(' ')}</p>
      {reasons.size > 0 && (
        <ul className="text-muted-foreground list-disc pl-5">
          {[...reasons].map(([message, count]) => (
            <li key={message}>{t('wave.notInvited', { count, reason: message })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ALL = '__all__';
const ANY = '__any__';

export interface WaitlistInviteWaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: readonly string[];
  fields: readonly WaitlistFieldShape[];
  /** Called after a wave ran, so the table and counts can follow. */
  onInvited: () => void;
}

export function WaitlistInviteWaveDialog({
  open,
  onOpenChange,
  lists,
  fields,
  onInvited,
}: WaitlistInviteWaveDialogProps) {
  const t = useTranslations('admin.waitlist.wave');
  const tShell = useTranslations('admin.shell');
  const [mode, setMode] = useState<'next' | 'sample'>('next');
  const [count, setCount] = useState('10');
  const [list, setList] = useState(ALL);
  const [field, setField] = useState(ANY);
  const [value, setValue] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WaveResult | null>(null);
  const save = useSaveFailure({
    fallback: t('sendFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const chosenField = fields.find((f) => f.key === field) ?? null;
  const n = Number(count);
  const countValid = Number.isInteger(n) && n >= 1 && n <= WAITLIST_INVITE_WAVE_MAX;
  const answerValid = !chosenField || value.trim() !== '';

  const close = (next: boolean) => {
    if (running) return;
    if (!next) {
      setResult(null);
      save.clear();
    }
    onOpenChange(next);
  };

  const run = async () => {
    save.clear();
    setRunning(true);
    try {
      const wave = await postWave({
        mode,
        count: n,
        ...(list !== ALL ? { list } : {}),
        ...(chosenField ? { answer: { field: chosenField.key, value: value.trim() } } : {}),
      });
      setResult(wave);
      onInvited();
    } catch (err) {
      save.report(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <WaveSummary result={result} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="wave-mode" className="flex items-center gap-1">
                {t('who')}
                <FieldHelp title={t('who')}>
                  {t.rich('whoHelp', { strong: (chunks) => <strong>{chunks}</strong> })}
                </FieldHelp>
              </Label>
              <Select
                value={mode}
                onValueChange={(v) => setMode(v === 'sample' ? 'sample' : 'next')}
              >
                <SelectTrigger id="wave-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="next">{t('earliest')}</SelectItem>
                  <SelectItem value="sample">{t('random')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="wave-count" className="flex items-center gap-1">
                {t('howMany')}
                <FieldHelp title={t('howMany')}>
                  {t('howManyHelp', { max: WAITLIST_INVITE_WAVE_MAX })}
                </FieldHelp>
              </Label>
              <Input
                id="wave-count"
                type="number"
                min={1}
                max={WAITLIST_INVITE_WAVE_MAX}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                aria-invalid={!countValid}
              />
              {!countValid && (
                <p className="text-destructive text-xs">
                  {t('countInvalid', { max: WAITLIST_INVITE_WAVE_MAX })}
                </p>
              )}
            </div>

            {lists.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="wave-list" className="flex items-center gap-1">
                  {t('list')}
                  <FieldHelp title={t('list')}>{t('listHelp')}</FieldHelp>
                </Label>
                <Select value={list} onValueChange={setList}>
                  <SelectTrigger id="wave-list">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('allLists')}</SelectItem>
                    {lists.map((key) => (
                      <SelectItem key={key} value={key}>
                        {key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {fields.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="wave-field" className="flex items-center gap-1">
                  {t('answered')}
                  <FieldHelp title={t('answered')}>{t('answeredHelp')}</FieldHelp>
                </Label>
                <Select
                  value={field}
                  onValueChange={(v) => {
                    setField(v);
                    setValue('');
                  }}
                >
                  <SelectTrigger id="wave-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t('anyone')}</SelectItem>
                    {fields.map((f) => (
                      <SelectItem key={f.key} value={f.key}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {chosenField &&
                  (chosenField.options ? (
                    <Select value={value} onValueChange={setValue}>
                      <SelectTrigger aria-label={t('answerTo', { question: chosenField.label })}>
                        <SelectValue placeholder={t('chooseAnswer')} />
                      </SelectTrigger>
                      <SelectContent>
                        {chosenField.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      aria-label={t('answerTo', { question: chosenField.label })}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={t('exactAnswer')}
                    />
                  ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          <SaveError failure={save.failure} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => close(false)} disabled={running}>
              {result ? tShell('close') : tShell('cancel')}
            </Button>
            {!result && (
              <Button onClick={() => void run()} disabled={running || !countValid || !answerValid}>
                {running ? t('sending') : t('send')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
