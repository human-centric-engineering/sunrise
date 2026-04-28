/**
 * Unit Tests: NotificationEditor
 *
 * Test Coverage:
 * - Defaults to email channel when config.channel is not set
 * - Email channel shows recipients (to) and subject fields
 * - Email channel hides webhook URL field
 * - Switching to webhook channel shows webhook URL field
 * - Webhook channel hides recipients and subject fields
 * - Changing recipients input calls onChange({ to })
 * - Changing subject input calls onChange({ subject })
 * - Changing webhook URL input calls onChange({ webhookUrl })
 * - Changing body template calls onChange({ bodyTemplate })
 * - Channel switch via Radix Select calls onChange({ channel })
 * - Renders FieldHelp info buttons on all fields
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/notification-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NotificationEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/notification-editor';
import type { NotificationConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/notification-editor';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const emailConfig: NotificationConfig = {
  channel: 'email',
  to: '',
  subject: '',
  bodyTemplate: '',
};

const webhookConfig: NotificationConfig = {
  channel: 'webhook',
  webhookUrl: '',
  bodyTemplate: '',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NotificationEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering — channel defaults ───────────────────────────────────────────

  it('defaults to email channel when config.channel is not set', () => {
    // Arrange: cast bypasses TS so we can test the runtime fallback branch
    const config = { bodyTemplate: '' } as unknown as NotificationConfig;

    // Act
    render(<NotificationEditor config={config} onChange={vi.fn()} />);

    // Assert: email-only fields are visible, webhook URL is absent
    expect(document.getElementById('notification-to')).toBeInTheDocument();
    expect(document.getElementById('notification-subject')).toBeInTheDocument();
    expect(document.getElementById('notification-webhook-url')).not.toBeInTheDocument();
  });

  // ── Rendering — email channel ──────────────────────────────────────────────

  it('shows recipients and subject fields when channel is email', () => {
    // Arrange + Act
    render(<NotificationEditor config={emailConfig} onChange={vi.fn()} />);

    // Assert
    expect(document.getElementById('notification-to')).toBeInTheDocument();
    expect(document.getElementById('notification-subject')).toBeInTheDocument();
  });

  it('hides webhook URL field when channel is email', () => {
    // Arrange + Act
    render(<NotificationEditor config={emailConfig} onChange={vi.fn()} />);

    // Assert
    expect(document.getElementById('notification-webhook-url')).not.toBeInTheDocument();
  });

  it('always renders the body template textarea regardless of channel', () => {
    // Arrange + Act (email)
    const { unmount } = render(<NotificationEditor config={emailConfig} onChange={vi.fn()} />);
    expect(document.getElementById('notification-body')).toBeInTheDocument();
    unmount();

    // Act (webhook)
    render(<NotificationEditor config={webhookConfig} onChange={vi.fn()} />);
    expect(document.getElementById('notification-body')).toBeInTheDocument();
  });

  // ── Rendering — webhook channel ────────────────────────────────────────────

  it('shows webhook URL field when channel is webhook', () => {
    // Arrange + Act
    render(<NotificationEditor config={webhookConfig} onChange={vi.fn()} />);

    // Assert
    expect(document.getElementById('notification-webhook-url')).toBeInTheDocument();
  });

  it('hides recipients and subject fields when channel is webhook', () => {
    // Arrange + Act
    render(<NotificationEditor config={webhookConfig} onChange={vi.fn()} />);

    // Assert
    expect(document.getElementById('notification-to')).not.toBeInTheDocument();
    expect(document.getElementById('notification-subject')).not.toBeInTheDocument();
  });

  // ── onChange — recipients ──────────────────────────────────────────────────

  it('calls onChange with { to } when recipients input changes', () => {
    // Arrange
    const onChange = vi.fn();
    render(<NotificationEditor config={emailConfig} onChange={onChange} />);
    const input = document.getElementById('notification-to')!;

    // Act
    fireEvent.change(input, { target: { value: 'alice@example.com' } });

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ to: 'alice@example.com' });
  });

  // ── onChange — subject ─────────────────────────────────────────────────────

  it('calls onChange with { subject } when subject input changes', () => {
    // Arrange
    const onChange = vi.fn();
    render(<NotificationEditor config={emailConfig} onChange={onChange} />);
    const input = document.getElementById('notification-subject')!;

    // Act
    fireEvent.change(input, { target: { value: 'Hello' } });

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ subject: 'Hello' });
  });

  // ── onChange — webhookUrl ──────────────────────────────────────────────────

  it('calls onChange with { webhookUrl } when webhook URL input changes', () => {
    // Arrange
    const onChange = vi.fn();
    render(<NotificationEditor config={webhookConfig} onChange={onChange} />);
    const input = document.getElementById('notification-webhook-url')!;

    // Act
    fireEvent.change(input, { target: { value: 'https://hook.example.com/notify' } });

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ webhookUrl: 'https://hook.example.com/notify' });
  });

  // ── onChange — bodyTemplate ────────────────────────────────────────────────

  it('calls onChange with { bodyTemplate } when body template textarea changes', () => {
    // Arrange
    const onChange = vi.fn();
    render(<NotificationEditor config={emailConfig} onChange={onChange} />);
    const textarea = document.getElementById('notification-body')!;

    // Act
    fireEvent.change(textarea, { target: { value: 'Hello, {{input}}!' } });

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ bodyTemplate: 'Hello, {{input}}!' });
  });

  // ── onChange — channel select ──────────────────────────────────────────────

  it('calls onChange with { channel: "webhook" } when webhook option is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationEditor config={emailConfig} onChange={onChange} />);

    // Act: open the Radix Select by clicking the trigger
    const trigger = document.getElementById('notification-channel')!;
    await user.click(trigger);

    // The Radix portal renders options in document.body
    const webhookOption = screen.getByRole('option', { name: /webhook/i });
    await user.click(webhookOption);

    // Assert
    expect(onChange).toHaveBeenCalledWith({ channel: 'webhook' });
  });

  it('calls onChange with { channel: "email" } when email option is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationEditor config={webhookConfig} onChange={onChange} />);

    // Act: open the Radix Select by clicking the trigger
    const trigger = document.getElementById('notification-channel')!;
    await user.click(trigger);

    // The Radix portal renders options in document.body
    const emailOption = screen.getByRole('option', { name: /^email$/i });
    await user.click(emailOption);

    // Assert
    expect(onChange).toHaveBeenCalledWith({ channel: 'email' });
  });

  // ── FieldHelp info buttons ─────────────────────────────────────────────────

  it('renders FieldHelp info buttons on all email-channel fields', () => {
    // Arrange + Act
    render(<NotificationEditor config={emailConfig} onChange={vi.fn()} />);

    // Assert: channel + recipients + subject + body = 4 info buttons
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(4);
  });

  it('renders FieldHelp info buttons on all webhook-channel fields', () => {
    // Arrange + Act
    render(<NotificationEditor config={webhookConfig} onChange={vi.fn()} />);

    // Assert: channel + webhook URL + body = 3 info buttons
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(3);
  });

  // ── Pre-populated values ───────────────────────────────────────────────────

  it('shows pre-populated to, subject, and bodyTemplate when email config is provided', () => {
    // Arrange
    const config: NotificationConfig = {
      channel: 'email',
      to: 'bob@example.com',
      subject: 'Workflow done',
      bodyTemplate: 'It finished.',
    };

    // Act
    render(<NotificationEditor config={config} onChange={vi.fn()} />);

    // Assert
    const toInput = document.getElementById('notification-to') as HTMLInputElement;
    const subjectInput = document.getElementById('notification-subject') as HTMLInputElement;
    const bodyTextarea = document.getElementById('notification-body') as HTMLTextAreaElement;

    expect(toInput.value).toBe('bob@example.com');
    expect(subjectInput.value).toBe('Workflow done');
    expect(bodyTextarea.value).toBe('It finished.');
  });

  it('shows pre-populated webhookUrl and bodyTemplate when webhook config is provided', () => {
    // Arrange
    const config: NotificationConfig = {
      channel: 'webhook',
      webhookUrl: 'https://hook.example.com/xyz',
      bodyTemplate: '{{input}}',
    };

    // Act
    render(<NotificationEditor config={config} onChange={vi.fn()} />);

    // Assert
    const urlInput = document.getElementById('notification-webhook-url') as HTMLInputElement;
    const bodyTextarea = document.getElementById('notification-body') as HTMLTextAreaElement;

    expect(urlInput.value).toBe('https://hook.example.com/xyz');
    expect(bodyTextarea.value).toBe('{{input}}');
  });
});
