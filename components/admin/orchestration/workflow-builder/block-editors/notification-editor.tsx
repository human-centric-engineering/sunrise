'use client';

/**
 * Send Notification step editor — configure email or webhook notifications.
 *
 * Supports two channels: email (with recipients and subject) and webhook
 * (with a target URL). Both channels accept a body template with
 * {{input}} interpolation.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface NotificationConfig extends Record<string, unknown> {
  channel: 'email' | 'webhook';
  to?: string;
  subject?: string;
  bodyTemplate: string;
  webhookUrl?: string;
}

export function NotificationEditor({ config, onChange }: EditorProps<NotificationConfig>) {
  const channel = config.channel ?? 'email';

  return (
    <div className="space-y-4">
      {/* Channel */}
      <div className="space-y-1.5">
        <Label htmlFor="notification-channel" className="flex items-center text-xs">
          Channel{' '}
          <FieldHelp title="Notification channel">
            <strong>Email:</strong> sends an email to one or more recipients.{' '}
            <strong>Webhook:</strong> sends a POST request to a URL with the message body as JSON.
          </FieldHelp>
        </Label>
        <Select
          value={channel}
          onValueChange={(v) => onChange({ channel: v as 'email' | 'webhook' })}
        >
          <SelectTrigger id="notification-channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {channel === 'email' && (
        <>
          {/* Recipients */}
          <div className="space-y-1.5">
            <Label htmlFor="notification-to" className="flex items-center text-xs">
              Recipients{' '}
              <FieldHelp title="Recipients">
                Email address(es) to send the notification to. For multiple recipients, separate
                with commas.
              </FieldHelp>
            </Label>
            <Input
              id="notification-to"
              value={config.to ?? ''}
              onChange={(e) => onChange({ to: e.target.value })}
              placeholder="user@example.com"
            />
          </div>

          {/* Subject */}
          <div className="space-y-1.5">
            <Label htmlFor="notification-subject" className="flex items-center text-xs">
              Subject{' '}
              <FieldHelp title="Subject">
                Email subject line. Supports <code>{'{{input}}'}</code> interpolation.
              </FieldHelp>
            </Label>
            <Input
              id="notification-subject"
              value={config.subject ?? ''}
              onChange={(e) => onChange({ subject: e.target.value })}
              placeholder="Workflow notification"
            />
          </div>
        </>
      )}

      {channel === 'webhook' && (
        <div className="space-y-1.5">
          <Label htmlFor="notification-webhook-url" className="flex items-center text-xs">
            Webhook URL{' '}
            <FieldHelp title="Webhook URL">
              The URL to send a POST request to with the notification body as JSON payload.
            </FieldHelp>
          </Label>
          <Input
            id="notification-webhook-url"
            value={config.webhookUrl ?? ''}
            onChange={(e) => onChange({ webhookUrl: e.target.value })}
            placeholder="https://example.com/webhook"
          />
        </div>
      )}

      {/* Body Template */}
      <div className="space-y-1.5">
        <Label htmlFor="notification-body" className="flex items-center text-xs">
          Body template{' '}
          <FieldHelp title="Body template">
            The notification body. Supports <code>{'{{input}}'}</code> to inject the workflow input
            and <code>{'{{steps.<stepId>.output}}'}</code> to reference previous step outputs.
          </FieldHelp>
        </Label>
        <Textarea
          id="notification-body"
          value={config.bodyTemplate ?? ''}
          onChange={(e) => onChange({ bodyTemplate: e.target.value })}
          placeholder="{{input}}"
          rows={6}
        />
      </div>
    </div>
  );
}
