# Contextual Help (ⓘ) Directive

**Cross-cutting rule — applies to every non-trivial form from Phase 4 Session 4.1 onward.**

Every form field whose meaning isn't self-evident from its label must have a `<FieldHelp>` info-icon next to the label. Clicking (or focusing + Enter) the icon opens a popover explaining:

1. **What** the setting does
2. **When** to change it
3. **What the default is**

Plus a "Learn more" link into the Pattern Explorer (`/admin/orchestration/learning`) when relevant.

## Primitive

`components/ui/field-help.tsx` — a small ⓘ button wrapping a shadcn `Popover`. Built on `@radix-ui/react-popover`.

```tsx
import { FieldHelp } from '@/components/ui/field-help';

<Label htmlFor="agent-model">
  Model{' '}
  <FieldHelp title="LLM model">
    The exact model identifier your provider exposes. Changing this switches which model answers
    prompts. Default: <code>claude-opus-4-6</code>.{' '}
    <Link href="/admin/orchestration/learning" className="underline">
      Learn more
    </Link>
  </FieldHelp>
</Label>;
```

### Props

| Prop        | Type                  | Default              | Purpose                                    |
| ----------- | --------------------- | -------------------- | ------------------------------------------ |
| `title`     | `string \| undefined` | —                    | Bold heading above the popover body        |
| `children`  | `ReactNode`           | —                    | Help body — text, `<code>`, `<Link>`, etc. |
| `className` | `string \| undefined` | —                    | Extra classes on the trigger button        |
| `ariaLabel` | `string`              | `"More information"` | Accessible name for the icon button        |

### Accessibility

- The trigger is a real `<button type="button">`, keyboard-focusable by default.
- `Enter` / `Space` opens the popover.
- `Escape` closes it (Radix built-in).
- Focus returns to the trigger on close.
- `aria-label` defaults to `"More information"` — override with a specific name when the ⓘ appears next to multiple similar fields.

## Required help-text structure

Keep help text concise. Prefer this three-part pattern:

```
{what it does} {when to change it} Default: {default}. Learn more: {link}.
```

**Good:**

> Name of the environment variable holding the real API key — e.g. `ANTHROPIC_API_KEY`. Must be SCREAMING_SNAKE_CASE. The key itself is never written to the database or logged.

**Bad:**

> The API key.

## When to use it

- **Use:** every field in the Setup Wizard, every form in the orchestration admin area, every non-trivial config field in future admin pages.
- **Skip:** self-evident labels like "Email" or "Password" where the meaning is obvious.

If you catch yourself explaining a field in a tooltip, it should be a `<FieldHelp>` instead — tooltips aren't keyboard-accessible.

## Linking to the Pattern Explorer

When a setting has deeper explanation in the Pattern Explorer (Phase 6), include a `<Link>` at the end of the help body pointing at the relevant section. The explorer isn't built yet — link to `/admin/orchestration/learning` for now; the parent admin error boundary handles the 404 gracefully.

## Related

- [Agent form](../admin/agent-form.md) — **reference implementation** for the directive (every FieldHelp copy line is documented verbatim there)
- [Setup Wizard](../admin/setup-wizard.md) — first application of the directive
- [Hooks reference](./hooks.md)
