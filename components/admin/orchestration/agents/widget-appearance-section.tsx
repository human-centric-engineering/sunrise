'use client';

/**
 * WidgetAppearanceSection
 *
 * Per-agent embed-widget customisation: colours, fonts, header copy,
 * placeholder, send-button label, conversation starters, footer.
 * PATCHes /api/v1/admin/orchestration/agents/:id/widget-config.
 *
 * Companion to EmbedConfigPanel — both render in the agent form's
 * Embed tab. Tokens live in EmbedConfigPanel; appearance lives here.
 */

import * as React from 'react';
import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { DEFAULT_WIDGET_CONFIG, type WidgetConfig } from '@/lib/validations/orchestration';

interface Props {
  agentId: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_RE = /^[\w\s,'"-]+$/;

// WCAG AA threshold for body text. Below this, we surface a soft
// warning — admins can dismiss by ignoring it; we don't block save,
// since the schema can't tell apart "intentional low-contrast brand"
// from "white-on-white mistake".
const MIN_CONTRAST_RATIO = 4.5;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastRatio(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

type FormState = WidgetConfig;

export function WidgetAppearanceSection({ agentId }: Props): React.ReactElement {
  const [form, setForm] = React.useState<FormState>(DEFAULT_WIDGET_CONFIG);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  const endpoint = API.ADMIN.ORCHESTRATION.agentWidgetConfig(agentId);

  React.useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ config: WidgetConfig }>(endpoint)
      .then((data) => {
        if (cancelled) return;
        // Defensive: if the response shape is unexpected (legacy data,
        // bad mock, etc.) keep the form on DEFAULT_WIDGET_CONFIG rather
        // than crashing on undefined.config access.
        if (data && typeof data === 'object' && data.config) setForm(data.config);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof APIClientError ? err.message : 'Failed to load appearance');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  }

  function updateStarter(index: number, value: string): void {
    setForm((prev) => {
      const next = [...prev.conversationStarters];
      next[index] = value;
      return { ...prev, conversationStarters: next };
    });
    setSavedAt(null);
  }

  function addStarter(): void {
    if (form.conversationStarters.length >= 4) return;
    setForm((prev) => ({
      ...prev,
      conversationStarters: [...prev.conversationStarters, ''],
    }));
    setSavedAt(null);
  }

  function removeStarter(index: number): void {
    setForm((prev) => ({
      ...prev,
      conversationStarters: prev.conversationStarters.filter((_, i) => i !== index),
    }));
    setSavedAt(null);
  }

  function reset(): void {
    setForm(DEFAULT_WIDGET_CONFIG);
    setSavedAt(null);
    setError(null);
  }

  function validate(): string | null {
    if (!HEX_RE.test(form.primaryColor))
      return 'Primary colour must be a 6-digit hex like #2563eb.';
    if (!HEX_RE.test(form.surfaceColor)) return 'Surface colour must be a 6-digit hex.';
    if (!HEX_RE.test(form.textColor)) return 'Text colour must be a 6-digit hex.';
    if (!FONT_RE.test(form.fontFamily))
      return 'Font family contains a disallowed character. Stick to letters, spaces, commas, hyphens, and quote marks.';
    if (form.headerTitle.trim().length === 0) return 'Header title cannot be empty.';
    if (form.inputPlaceholder.trim().length === 0) return 'Input placeholder cannot be empty.';
    if (form.sendLabel.trim().length === 0) return 'Send button label cannot be empty.';
    const blank = form.conversationStarters.findIndex((s) => s.trim().length === 0);
    if (blank >= 0) return `Conversation starter ${blank + 1} is empty — remove it or fill it in.`;
    return null;
  }

  async function save(): Promise<void> {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await apiClient.patch<{ config: WidgetConfig }>(endpoint, { body: form });
      setForm(data.config);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof APIClientError ? e.message : 'Failed to save appearance');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="text-muted-foreground py-8 text-center text-sm">
          Loading appearance…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Appearance & copy
          <FieldHelp title="Widget appearance">
            Colours, fonts, and copy for the embedded chat widget. Saved per-agent — every embed
            token for this agent inherits the same look. Live preview on the right reflects what
            partner sites will see.
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        {(() => {
          const ratio = contrastRatio(form.surfaceColor, form.textColor);
          if (ratio === null || ratio >= MIN_CONTRAST_RATIO) return null;
          // Soft warning, not a save blocker — the brand may want this.
          return (
            <p
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              Contrast between text and surface is {ratio.toFixed(1)}:1, below the WCAG AA threshold
              of 4.5:1. Messages may be hard to read. Save anyway if this matches your brand.
            </p>
          );
        })()}

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          {/* ── Form column ─────────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Colours */}
            <div className="grid gap-3 sm:grid-cols-3">
              <ColorField
                id="widget-primary"
                label="Primary"
                help={
                  <>
                    The accent colour. Used for the bubble button, send button, user message
                    bubbles, and citation chips. Pick something that contrasts with the surface
                    colour. Default: <code>#2563eb</code>.
                  </>
                }
                value={form.primaryColor}
                onChange={(v) => update('primaryColor', v)}
              />
              <ColorField
                id="widget-surface"
                label="Surface"
                help={
                  <>
                    The chat panel background. On dark partner sites, choose a near-black like{' '}
                    <code>#1f2937</code>; on light, white or near-white. Default:{' '}
                    <code>#ffffff</code>.
                  </>
                }
                value={form.surfaceColor}
                onChange={(v) => update('surfaceColor', v)}
              />
              <ColorField
                id="widget-text"
                label="Text"
                help={
                  <>
                    Body text colour inside the chat panel. Must contrast with the surface colour or
                    messages will be unreadable. Default: <code>#111827</code>.
                  </>
                }
                value={form.textColor}
                onChange={(v) => update('textColor', v)}
              />
            </div>

            {/* Font */}
            <div className="space-y-1">
              <Label htmlFor="widget-font" className="flex items-center gap-1 text-xs">
                Font family
                <FieldHelp title="Font family">
                  A CSS font stack — e.g. <code>{`"Helvetica Neue", Arial, sans-serif`}</code>. Use
                  system fonts for safety; only fonts loaded by the partner page will render here,
                  since the widget mounts inside the partner&apos;s document. Disallowed characters:{' '}
                  <code>{`{ } ; ( )`}</code>. Default: system stack.
                </FieldHelp>
              </Label>
              <Input
                id="widget-font"
                value={form.fontFamily}
                maxLength={200}
                onChange={(e) => update('fontFamily', e.target.value)}
              />
              <p className="text-muted-foreground text-right text-[10px]">
                {form.fontFamily.length}/200
              </p>
            </div>

            {/* Header copy */}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id="widget-header-title"
                label="Header title"
                value={form.headerTitle}
                maxLength={60}
                onChange={(v) => update('headerTitle', v)}
                help={
                  <>
                    The bold title at the top of the chat panel. Keep it short and direct — e.g.
                    &quot;Council planning&quot;, &quot;Mortgage advice&quot;, &quot;Tenant
                    support&quot;. Default: <code>Chat</code>.
                  </>
                }
              />
              <TextField
                id="widget-header-subtitle"
                label="Header subtitle"
                value={form.headerSubtitle}
                maxLength={100}
                placeholder="(optional)"
                onChange={(v) => update('headerSubtitle', v)}
                help={
                  <>
                    A small line under the title, e.g. &quot;Replies in under a minute&quot; or
                    &quot;In partnership with X&quot;. Leave blank to hide. Default: empty.
                  </>
                }
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id="widget-placeholder"
                label="Input placeholder"
                value={form.inputPlaceholder}
                maxLength={80}
                onChange={(v) => update('inputPlaceholder', v)}
                help={
                  <>
                    Placeholder shown in the message input before the user types. Used as a soft
                    prompt — e.g. &quot;Ask about a planning application…&quot;. Default:{' '}
                    <code>Type a message…</code>.
                  </>
                }
              />
              <TextField
                id="widget-send-label"
                label="Send button label"
                value={form.sendLabel}
                maxLength={30}
                onChange={(v) => update('sendLabel', v)}
                help={
                  <>
                    The label on the send button. Localise here for non-English deployments — e.g.{' '}
                    <code>Enviar</code>, <code>Envoyer</code>. Default: <code>Send</code>.
                  </>
                }
              />
            </div>

            <TextField
              id="widget-footer"
              label="Footer caption"
              value={form.footerText}
              maxLength={80}
              placeholder="(optional)"
              onChange={(v) => update('footerText', v)}
              help={
                <>
                  Tiny caption row below the input, e.g. a disclaimer or branding line. Leave blank
                  to hide. Default: empty.
                </>
              }
            />

            {/* Conversation starters */}
            <div className="space-y-1">
              <Label className="flex items-center gap-1 text-xs">
                Conversation starters
                <FieldHelp title="Conversation starters">
                  Up to four clickable chips shown to the user before they send their first message.
                  Click → drops the text into the input and sends. Use these to surface the most
                  common questions and reduce blank-page anxiety. Empty list = no chips.
                </FieldHelp>
              </Label>
              <div className="space-y-2">
                {form.conversationStarters.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={s}
                      maxLength={200}
                      placeholder="e.g. How do I apply for planning permission?"
                      onChange={(e) => updateStarter(i, e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeStarter(i)}
                      aria-label={`Remove starter ${i + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                ))}
                {form.conversationStarters.length < 4 && (
                  <Button type="button" variant="outline" size="sm" onClick={addStarter}>
                    <Plus className="mr-1 h-3 w-3" /> Add starter
                  </Button>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2">
              <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
                <Save className="mr-1 h-3 w-3" />
                {saving ? 'Saving…' : 'Save appearance'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={reset} disabled={saving}>
                <RotateCcw className="mr-1 h-3 w-3" /> Reset to defaults
              </Button>
              {savedAt !== null && (
                <span className="text-muted-foreground text-xs" aria-live="polite">
                  Saved
                </span>
              )}
            </div>
          </div>

          {/* ── Preview column ─────────────────────────────────────────── */}
          <div className="rounded-md border p-4">
            <p className="text-muted-foreground mb-3 text-xs tracking-wide uppercase">Preview</p>
            <WidgetPreview cfg={form} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface ColorFieldProps {
  id: string;
  label: string;
  help: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}

function ColorField({ id, label, help, value, onChange }: ColorFieldProps): React.ReactElement {
  const isValid = HEX_RE.test(value);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="flex items-center gap-1 text-xs">
        {label}
        <FieldHelp title={`${label} colour`}>{help}</FieldHelp>
      </Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={isValid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-9 cursor-pointer rounded border"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          aria-invalid={!isValid}
        />
      </div>
    </div>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  help: React.ReactNode;
  value: string;
  maxLength: number;
  placeholder?: string;
  onChange: (value: string) => void;
}

function TextField({
  id,
  label,
  help,
  value,
  maxLength,
  placeholder,
  onChange,
}: TextFieldProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="flex items-center gap-1 text-xs">
        {label}
        <FieldHelp title={label}>{help}</FieldHelp>
      </Label>
      <Input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-muted-foreground text-right text-[10px]">
        {value.length}/{maxLength}
      </p>
    </div>
  );
}

interface PreviewProps {
  cfg: WidgetConfig;
}

function WidgetPreview({ cfg }: PreviewProps): React.ReactElement {
  // Static visual mock — not a real widget mount. Renders a frozen
  // panel + bubble using inline styles driven by the form values so
  // admins can iterate on colours without saving and reloading a
  // partner page. Conversation starters render as chips above the
  // input (matching the live widget's empty-state).
  const surface = cfg.surfaceColor;
  const text = cfg.textColor;
  const primary = cfg.primaryColor;
  const font = cfg.fontFamily;

  // Dividers and muted backgrounds are derived from the form's text
  // colour so the preview stays readable on a dark surfaceColor — the
  // earlier hardcoded #e5e7eb / #f3f4f6 lit up like cracks on a dark
  // panel. color-mix has wide modern-browser support and is safe in
  // an admin-only surface.
  const divider = `color-mix(in srgb, ${text} 15%, transparent)`;
  const muted = `color-mix(in srgb, ${text} 8%, ${surface})`;

  return (
    <div
      style={{
        background: surface,
        color: text,
        fontFamily: font,
        border: `1px solid ${divider}`,
        borderRadius: 12,
        overflow: 'hidden',
        fontSize: 14,
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${divider}`,
          display: 'flex',
          alignItems: 'flex-start',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{cfg.headerTitle || 'Chat'}</div>
          {cfg.headerSubtitle && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{cfg.headerSubtitle}</div>
          )}
        </div>
      </div>
      <div style={{ padding: 12, minHeight: 120 }}>
        <div style={{ marginBottom: 8 }}>
          <span
            style={{
              background: muted,
              padding: '6px 12px',
              borderRadius: '12px 12px 12px 0',
              display: 'inline-block',
            }}
          >
            Hello! How can I help?
          </span>
        </div>
        {cfg.conversationStarters.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {cfg.conversationStarters.map((s, i) => (
              <span
                key={i}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  background: muted,
                  border: `1px solid ${divider}`,
                  borderRadius: 999,
                }}
              >
                {s || '(empty)'}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: `1px solid ${divider}`,
          display: 'flex',
          gap: 8,
        }}
      >
        <input
          readOnly
          placeholder={cfg.inputPlaceholder}
          style={{
            flex: 1,
            padding: '8px 12px',
            border: `1px solid ${divider}`,
            borderRadius: 8,
            fontSize: 14,
            fontFamily: font,
            background: surface,
            color: text,
          }}
        />
        <span
          style={{
            padding: '8px 16px',
            background: primary,
            color: '#fff',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {cfg.sendLabel}
        </span>
      </div>
      {cfg.footerText && (
        <div
          style={{
            padding: '6px 12px 8px',
            fontSize: 11,
            opacity: 0.6,
            textAlign: 'center',
            borderTop: `1px solid ${divider}`,
          }}
        >
          {cfg.footerText}
        </div>
      )}
    </div>
  );
}
