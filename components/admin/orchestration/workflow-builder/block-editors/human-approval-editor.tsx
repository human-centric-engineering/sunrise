'use client';

/**
 * Human Approval step editor — approval message, timeout, notification channel.
 *
 * Only `prompt` is currently enforced by the backend validator; the other
 * fields are accepted-and-stored until Session 5.2 wires the approval
 * inbox + notifier. The <code>email</code> and <code>slack</code> channel
 * options are placeholders — they render &ldquo;(coming soon)&rdquo; until
 * the dispatcher lands.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

export interface HumanApprovalConfig extends Record<string, unknown> {
  prompt: string;
  timeoutMinutes?: number;
  notificationChannel?: 'in-app' | 'email' | 'slack';
}

export function HumanApprovalEditor({ config, onChange }: EditorProps<HumanApprovalConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="approval-prompt" className="flex items-center text-xs">
          Approval message{' '}
          <FieldHelp title="Approval message">
            The message shown to the reviewer. Include enough context for them to make the decision
            without opening the full workflow run.
          </FieldHelp>
        </Label>
        <Textarea
          id="approval-prompt"
          value={config.prompt ?? ''}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="Please review the proposed refund amount before it is issued…"
          rows={5}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="approval-timeout" className="flex items-center text-xs">
          Timeout (minutes){' '}
          <FieldHelp title="Approval timeout">
            How long the workflow pauses before it auto-fails. Default: <code>60</code>.
          </FieldHelp>
        </Label>
        <Input
          id="approval-timeout"
          type="number"
          min={1}
          value={config.timeoutMinutes ?? 60}
          onChange={(e) => onChange({ timeoutMinutes: Number(e.target.value) })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="approval-channel" className="flex items-center text-xs">
          Notification channel{' '}
          <FieldHelp title="Notification channel">
            Where the reviewer gets notified. Currently only in-app notifications are supported.
          </FieldHelp>
        </Label>
        <Select
          value={config.notificationChannel ?? 'in-app'}
          onValueChange={(value) =>
            onChange({ notificationChannel: value as HumanApprovalConfig['notificationChannel'] })
          }
        >
          <SelectTrigger id="approval-channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="in-app">In-app</SelectItem>
            <SelectItem value="email">Email (coming soon)</SelectItem>
            <SelectItem value="slack">Slack (coming soon)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
