'use client';

/**
 * WorkflowSchedulesTab
 *
 * Tab component for managing workflow schedules.
 * Lists schedules, allows create/edit/delete, and toggle enabled state.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarClock, Loader2, Plus, Trash2 } from 'lucide-react';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Lightweight 5-field cron check (no external dependency for the client bundle). */
const CRON_FIELD = String.raw`(\*|[0-9]{1,2}(-[0-9]{1,2})?(\/[0-9]{1,2})?(,[0-9]{1,2}(-[0-9]{1,2})?)*)`;
const CRON_RE = new RegExp(`^${Array(5).fill(CRON_FIELD).join('\\s+')}$`);

function isValidCronExpression(expr: string): boolean {
  return CRON_RE.test(expr.trim());
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  isEnabled: boolean;
  nextRunAt: string | null;
  inputTemplate: Record<string, unknown> | null;
  createdAt: string;
}

export interface WorkflowSchedulesTabProps {
  workflowId: string;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function WorkflowSchedulesTab({ workflowId }: WorkflowSchedulesTabProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createCron, setCreateCron] = useState('');
  const [createInput, setCreateInput] = useState('');
  const [createEnabled, setCreateEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiClient.get<{ schedules: Schedule[] }>(
        API.ADMIN.ORCHESTRATION.workflowSchedules(workflowId)
      );
      setSchedules(body.schedules);
    } catch {
      setError('Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      // Validate cron expression client-side before hitting the API
      if (!isValidCronExpression(createCron)) {
        setCreateError(
          'Invalid cron expression. Use 5-field format: minute hour day-of-month month day-of-week'
        );
        setCreating(false);
        return;
      }

      let inputTemplate: Record<string, unknown> = {};
      if (createInput.trim()) {
        try {
          const raw: unknown = JSON.parse(createInput);
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            setCreateError('Input template must be a JSON object');
            setCreating(false);
            return;
          }
          inputTemplate = raw as Record<string, unknown>;
        } catch {
          setCreateError('Input template must be valid JSON');
          setCreating(false);
          return;
        }
      }

      await apiClient.post(API.ADMIN.ORCHESTRATION.workflowSchedules(workflowId), {
        body: {
          name: createName,
          cronExpression: createCron,
          inputTemplate,
          isEnabled: createEnabled,
        },
      });

      setShowCreate(false);
      setCreateName('');
      setCreateCron('');
      setCreateInput('');
      setCreateEnabled(true);
      void fetchSchedules();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (schedule: Schedule) => {
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.workflowScheduleById(workflowId, schedule.id), {
        body: { isEnabled: !schedule.isEnabled },
      });
      void fetchSchedules();
    } catch {
      // Silent — the UI will still show the old state
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.delete(
        API.ADMIN.ORCHESTRATION.workflowScheduleById(workflowId, deleteTarget.id)
      );
      void fetchSchedules();
    } finally {
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Schedules{' '}
          <FieldHelp title="Scheduled runs">
            Schedule this workflow to run automatically on a cron expression. Each schedule can have
            its own input template (JSON) that gets passed as the workflow input.
          </FieldHelp>
        </h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-4 w-4" /> New schedule
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {schedules.length === 0 ? (
        <div className="rounded-md border p-6 text-center text-sm">
          <CalendarClock className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
          <p className="text-muted-foreground">
            No schedules yet. Create one to automate this workflow.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {s.cronExpression}
                  </Badge>
                  {!s.isEnabled && (
                    <Badge variant="outline" className="text-[10px]">
                      Disabled
                    </Badge>
                  )}
                </div>
                {s.nextRunAt && (
                  <p className="text-muted-foreground text-xs">
                    Next run: {new Date(s.nextRunAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={s.isEnabled}
                  onCheckedChange={() => void handleToggle(s)}
                  aria-label={`Toggle ${s.name}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleteTarget(s)}
                  title="Delete schedule"
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
            <DialogDescription>Schedule this workflow to run automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="schedule-name">Name</Label>
              <Input
                id="schedule-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Daily morning run"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="schedule-cron">
                Cron expression{' '}
                <FieldHelp title="Cron syntax">
                  Standard 5-field cron: minute hour day-of-month month day-of-week. Example:{' '}
                  <code>0 9 * * 1-5</code> = 9 AM weekdays.
                </FieldHelp>
              </Label>
              <Input
                id="schedule-cron"
                value={createCron}
                onChange={(e) => setCreateCron(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="font-mono"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="schedule-input">Input template (JSON, optional)</Label>
              <Textarea
                id="schedule-input"
                value={createInput}
                onChange={(e) => setCreateInput(e.target.value)}
                rows={4}
                placeholder='{"key": "value"}'
                className="font-mono text-xs"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="schedule-enabled">Enabled</Label>
              <Switch
                id="schedule-enabled"
                checked={createEnabled}
                onCheckedChange={setCreateEnabled}
              />
            </div>
            {createError && <p className="text-destructive text-xs">{createError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={creating || !createName || !createCron}
            >
              {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the schedule &ldquo;{deleteTarget?.name}&rdquo;. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
