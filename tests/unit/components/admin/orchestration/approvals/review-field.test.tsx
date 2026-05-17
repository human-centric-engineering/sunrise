/**
 * ReviewField Component Tests
 *
 * Test Coverage:
 * - Read-only mode: all display variants (badge, pre, textarea, boolean, number, text/enum)
 * - Read-only mode: null / undefined / empty-string placeholder rendering
 * - Editable mode: textarea, number, boolean (Switch), and free-text input widgets
 * - Editable mode: enum resolution — inline enumValues, enumValuesFrom (NAMED_ENUMS),
 *   enumValuesByFieldKey + rowContext (ENUM_BY_AUDIT_FIELD)
 * - readonly: true on a FieldSpec overrides editable: true (read-only wins)
 *
 * @see components/admin/orchestration/approvals/review-field.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReviewField } from '@/components/admin/orchestration/approvals/review-field';
import type { FieldSpec } from '@/lib/orchestration/review-schema/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeField(overrides: Partial<FieldSpec> = {}): FieldSpec {
  return {
    key: 'testField',
    label: 'Test Field',
    display: 'text',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ReviewField', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Read-only: empty values ───────────────────────────────────────────────

  describe('read-only: empty value placeholder', () => {
    it('renders em-dash placeholder for null value', () => {
      // Arrange
      const field = makeField({ display: 'text' });

      // Act
      render(<ReviewField field={field} value={null} />);

      // Assert: the component renders the visual dash sentinel, not an empty span
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders em-dash placeholder for undefined value', () => {
      const field = makeField({ display: 'text' });
      render(<ReviewField field={field} value={undefined} />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders em-dash placeholder for empty string value', () => {
      const field = makeField({ display: 'text' });
      render(<ReviewField field={field} value="" />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  // ── Read-only: display variants ──────────────────────────────────────────

  describe('read-only: badge display', () => {
    it('renders value text inside a Badge element', () => {
      // Arrange
      const field = makeField({ display: 'badge' });

      // Act
      render(<ReviewField field={field} value="active" />);

      // Assert: rendered inside a badge, not a plain span — verify by checking
      // the text exists AND that its container is the Badge (has its class)
      const badge = screen.getByText('active');
      expect(badge).toBeInTheDocument();
      // Badge uses the outline variant which applies to the element itself
      // The component wraps the value in <Badge variant="outline"> — check the
      // badge element carries that role/structure marker
      expect(badge.tagName.toLowerCase()).not.toBe('span');
    });

    it('renders badge content with the field value text', () => {
      const field = makeField({ display: 'badge' });
      render(<ReviewField field={field} value="pending" />);

      // The text must be the actual value — not a dash or empty
      expect(screen.getByText('pending')).toBeInTheDocument();
      // No dash appears — the value is non-empty and badge branch is taken
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });
  });

  describe('read-only: pre display — array value', () => {
    it('renders array values as comma-joined text inside pre', () => {
      // Arrange: array input should be comma-joined, not JSON-encoded
      const field = makeField({ display: 'pre' });
      const value = ['chat', 'reasoning', 'vision'];

      // Act
      render(<ReviewField field={field} value={value} />);

      // Assert: the component joins with ', ' — this is the transformation to check
      const pre = screen.getByText('chat, reasoning, vision');
      expect(pre).toBeInTheDocument();
      expect(pre.tagName.toLowerCase()).toBe('pre');
    });

    it('does not render array items as a plain JSON string', () => {
      const field = makeField({ display: 'pre' });
      render(<ReviewField field={field} value={['a', 'b']} />);

      // The code path specifically joins arrays — verify by checking the output
      // is the joined form, not e.g. '["a","b"]'
      expect(screen.queryByText('["a","b"]')).not.toBeInTheDocument();
      expect(screen.getByText('a, b')).toBeInTheDocument();
    });
  });

  describe('read-only: pre display — object value', () => {
    it('renders object value as JSON.stringify output inside pre', () => {
      // Arrange: object input should be pretty-printed JSON, not [object Object]
      const field = makeField({ display: 'pre' });
      const value = { tierRole: 'worker', latency: 'fast' };

      // Act
      render(<ReviewField field={field} value={value} />);

      // Assert: the pre element's text content equals JSON.stringify(value, null, 2).
      // Using a function matcher because the pretty-printed JSON contains newlines
      // which cause RTL's default normalisation to fail with a plain string query.
      const expected = JSON.stringify(value, null, 2);
      const pre = screen.getByText((_content, element) => {
        return element?.tagName.toLowerCase() === 'pre' && element.textContent === expected;
      });
      expect(pre.tagName.toLowerCase()).toBe('pre');
    });
  });

  describe('read-only: textarea display', () => {
    it('renders long text inside a paragraph element', () => {
      // Arrange
      const field = makeField({ display: 'textarea' });
      const value = 'A long description with multiple lines.';

      // Act
      render(<ReviewField field={field} value={value} />);

      // Assert: the component wraps in <p>, not an actual <textarea>
      const elem = screen.getByText(value);
      expect(elem.tagName.toLowerCase()).toBe('p');
    });

    it('does not render a textarea input element in read-only mode', () => {
      const field = makeField({ display: 'textarea' });
      render(<ReviewField field={field} value="some text" />);

      // Editable textarea is a form control; read-only is just a <p>
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  describe('read-only: boolean display', () => {
    it('renders "true" inside a Badge for boolean true', () => {
      const field = makeField({ display: 'boolean' });
      render(<ReviewField field={field} value={true} />);

      // The component renders 'true' or 'false' text inside a badge —
      // check the text is the string "true", not a switch widget
      expect(screen.getByText('true')).toBeInTheDocument();
      // No switch rendered in read-only mode
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    it('renders "false" inside a Badge for boolean false', () => {
      const field = makeField({ display: 'boolean' });
      render(<ReviewField field={field} value={false} />);

      expect(screen.getByText('false')).toBeInTheDocument();
    });
  });

  describe('read-only: number display', () => {
    it('renders numeric value inside a font-mono span', () => {
      // Arrange
      const field = makeField({ display: 'number' });

      // Act
      render(<ReviewField field={field} value={42} />);

      // Assert: value appears as text in a span — no input element
      const span = screen.getByText('42');
      expect(span.tagName.toLowerCase()).toBe('span');
      expect(span).toHaveClass('font-mono');
    });

    it('does not render a number input in read-only mode', () => {
      const field = makeField({ display: 'number' });
      render(<ReviewField field={field} value={7} />);

      expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    });
  });

  describe('read-only: text and enum display', () => {
    it('renders text value as inline span for display: text', () => {
      const field = makeField({ display: 'text' });
      render(<ReviewField field={field} value="worker" />);

      const span = screen.getByText('worker');
      expect(span.tagName.toLowerCase()).toBe('span');
    });

    it('renders enum value as inline span for display: enum', () => {
      const field = makeField({ display: 'enum' });
      render(<ReviewField field={field} value="thinking" />);

      expect(screen.getByText('thinking')).toBeInTheDocument();
      // Ensure no Select widget is rendered in read-only mode
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
  });

  // ── Editable mode: readonly: true wins ──────────────────────────────────

  describe('editable mode: readonly field spec overrides editable prop', () => {
    it('renders read-only display when field.readonly is true even if editable prop is true', () => {
      // Arrange: readonly: true on the spec should beat editable: true on the prop
      const field = makeField({ display: 'text', readonly: true });
      const onChange = vi.fn();

      // Act
      render(
        <ReviewField field={field} value="locked-value" editable={true} onChange={onChange} />
      );

      // Assert: read-only path taken — inline span, no Input widget
      expect(screen.getByText('locked-value')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('never calls onChange when readonly field is rendered with editable: true', async () => {
      const field = makeField({ display: 'text', readonly: true });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="immutable" editable={true} onChange={onChange} />);

      // No interactive widget to click — onChange stays silent
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ── Editable mode: textarea ──────────────────────────────────────────────

  describe('editable mode: textarea', () => {
    it('renders a Textarea widget when display is textarea and editable', () => {
      const field = makeField({ display: 'textarea' });
      const onChange = vi.fn();
      render(
        <ReviewField field={field} value="initial text" editable={true} onChange={onChange} />
      );

      // The editable textarea is a form control with role textbox
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('calls onChange with the new text when the Textarea changes', () => {
      // The component is controlled — use fireEvent.change to simulate a single
      // change event with a complete value, matching what the onChange handler receives.
      const field = makeField({ display: 'textarea' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="old" editable={true} onChange={onChange} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'new content' } });

      // onChange is called with the new string value from e.target.value
      expect(onChange).toHaveBeenCalledWith('new content');
    });
  });

  // ── Editable mode: number ────────────────────────────────────────────────

  describe('editable mode: number', () => {
    it('renders a number input widget when display is number and editable', () => {
      const field = makeField({ display: 'number' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value={5} editable={true} onChange={onChange} />);

      // The component renders an <input type="number"> whose role is spinbutton
      expect(screen.getByRole('spinbutton')).toBeInTheDocument();
    });

    it('calls onChange with a numeric value when a number is typed', () => {
      // The component is controlled. Use fireEvent.change with the full numeric string
      // to simulate a single change event — the handler parses it to Number(raw).
      const field = makeField({ display: 'number' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="" editable={true} onChange={onChange} />);

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '42' } });

      // The handler parses the raw string to a number before calling onChange
      expect(onChange).toHaveBeenCalledWith(42);
    });

    it('calls onChange with null when the number input is cleared', async () => {
      const user = userEvent.setup();
      const field = makeField({ display: 'number' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value={10} editable={true} onChange={onChange} />);

      const input = screen.getByRole('spinbutton');
      await user.clear(input);

      // Clearing sends null per the component's logic: if raw === '' -> onChange(null)
      expect(onChange).toHaveBeenCalledWith(null);
    });
  });

  // ── Editable mode: boolean (Switch) ─────────────────────────────────────

  describe('editable mode: boolean', () => {
    it('renders a Switch widget when display is boolean and editable', () => {
      const field = makeField({ display: 'boolean' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value={false} editable={true} onChange={onChange} />);

      expect(screen.getByRole('switch')).toBeInTheDocument();
    });

    it('calls onChange with true when the Switch is toggled on', async () => {
      const user = userEvent.setup();
      const field = makeField({ display: 'boolean' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value={false} editable={true} onChange={onChange} />);

      await user.click(screen.getByRole('switch'));

      // onCheckedChange fires with the new boolean state
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('calls onChange with false when the Switch is toggled off', async () => {
      const user = userEvent.setup();
      const field = makeField({ display: 'boolean' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value={true} editable={true} onChange={onChange} />);

      await user.click(screen.getByRole('switch'));

      expect(onChange).toHaveBeenCalledWith(false);
    });
  });

  // ── Editable mode: free-text fallback ────────────────────────────────────

  describe('editable mode: free-text fallback', () => {
    it('renders a text Input when display is text and no enum applies', () => {
      const field = makeField({ display: 'text' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="hello" editable={true} onChange={onChange} />);

      // Should render an Input (role textbox), not a select combobox
      const input = screen.getByRole('textbox');
      expect(input).toBeInTheDocument();
      expect((input as HTMLInputElement).type).toBe('text');
    });

    it('calls onChange with the typed string from the text Input', () => {
      // The component is controlled — use fireEvent.change to simulate a single
      // change event, which is what the Input onChange handler receives.
      const field = makeField({ display: 'text' });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="" editable={true} onChange={onChange} />);

      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'hello' } });

      expect(onChange).toHaveBeenCalledWith('hello');
    });
  });

  // ── Editable mode: enum — inline enumValues ──────────────────────────────

  describe('editable mode: inline enumValues — Select widget', () => {
    it('renders a Select trigger (combobox) when enumValues is provided', () => {
      const field = makeField({
        display: 'enum',
        enumValues: ['a', 'b', 'c'],
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="a" editable={true} onChange={onChange} />);

      // Radix Select trigger has role="combobox"
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('does not render a plain text input when enum values are present', () => {
      const field = makeField({
        display: 'enum',
        enumValues: ['x', 'y'],
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="x" editable={true} onChange={onChange} />);

      // The enum path takes priority — no free-text input
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('renders the current value in the Select trigger when value matches an option', () => {
      const field = makeField({
        display: 'enum',
        enumValues: ['alpha', 'beta', 'gamma'],
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="beta" editable={true} onChange={onChange} />);

      // The trigger should display the selected value text
      expect(screen.getByRole('combobox')).toHaveTextContent('beta');
    });
  });

  // ── Editable mode: enumValuesFrom (NAMED_ENUMS lookup) ──────────────────

  describe('editable mode: enumValuesFrom — named registry lookup', () => {
    it('renders a Select combobox when enumValuesFrom resolves via NAMED_ENUMS', () => {
      // enumValuesFrom: 'TIER_ROLES' → NAMED_ENUMS['TIER_ROLES'] = TIER_ROLES array
      const field = makeField({
        display: 'enum',
        enumValuesFrom: 'TIER_ROLES',
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="worker" editable={true} onChange={onChange} />);

      // A Select is rendered — the registry lookup succeeded and enum path taken
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('does not fall back to a text input when enumValuesFrom resolves', () => {
      const field = makeField({
        display: 'text',
        enumValuesFrom: 'QUALITY',
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="high" editable={true} onChange={onChange} />);

      // The enum path is taken regardless of display type
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('shows the resolved TIER_ROLES options when the Select is opened', async () => {
      const user = userEvent.setup();
      const field = makeField({
        display: 'enum',
        enumValuesFrom: 'TIER_ROLES',
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="" editable={true} onChange={onChange} />);

      // Open the select to reveal options
      await user.click(screen.getByRole('combobox'));

      // TIER_ROLES includes 'thinking', 'worker', 'infrastructure', etc.
      // At least two of them should be visible in the opened list
      expect(screen.getByText('thinking')).toBeInTheDocument();
      expect(screen.getByText('worker')).toBeInTheDocument();
    });
  });

  // ── Editable mode: enumValuesByFieldKey (ENUM_BY_AUDIT_FIELD lookup) ────

  describe('editable mode: enumValuesByFieldKey — per-row context lookup', () => {
    it('renders a Select combobox when enumValuesByFieldKey resolves via rowContext', () => {
      // field.enumValuesByFieldKey = 'field', rowContext.field = 'tierRole'
      // → ENUM_BY_AUDIT_FIELD['tierRole'] = TIER_ROLES
      const field = makeField({
        display: 'enum',
        enumValuesByFieldKey: 'field',
      });
      const onChange = vi.fn();
      render(
        <ReviewField
          field={field}
          value=""
          editable={true}
          onChange={onChange}
          rowContext={{ field: 'tierRole' }}
        />
      );

      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('shows enum options derived from ENUM_BY_AUDIT_FIELD via rowContext', async () => {
      const user = userEvent.setup();
      const field = makeField({
        display: 'enum',
        enumValuesByFieldKey: 'field',
      });
      const onChange = vi.fn();
      render(
        <ReviewField
          field={field}
          value=""
          editable={true}
          onChange={onChange}
          rowContext={{ field: 'tierRole' }}
        />
      );

      // Open the select
      await user.click(screen.getByRole('combobox'));

      // TIER_ROLES values should appear — these come from ENUM_BY_AUDIT_FIELD['tierRole']
      expect(screen.getByText('thinking')).toBeInTheDocument();
      expect(screen.getByText('embedding')).toBeInTheDocument();
    });

    it('falls back to text input when rowContext field key maps to an unknown enum', () => {
      // 'bestRole' is NOT in ENUM_BY_AUDIT_FIELD — should fall through to text input
      const field = makeField({
        display: 'text',
        enumValuesByFieldKey: 'field',
      });
      const onChange = vi.fn();
      render(
        <ReviewField
          field={field}
          value=""
          editable={true}
          onChange={onChange}
          rowContext={{ field: 'bestRole' }}
        />
      );

      // No enum resolved — text input rendered instead
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('falls back to text input when rowContext is absent', () => {
      const field = makeField({
        display: 'text',
        enumValuesByFieldKey: 'field',
      });
      const onChange = vi.fn();
      render(<ReviewField field={field} value="" editable={true} onChange={onChange} />);

      // No rowContext → enumValuesByFieldKey resolution returns null → text input
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('uses enumValuesByFieldKey with a latency field context', async () => {
      const user = userEvent.setup();
      const field = makeField({
        display: 'enum',
        enumValuesByFieldKey: 'field',
      });
      const onChange = vi.fn();
      render(
        <ReviewField
          field={field}
          value=""
          editable={true}
          onChange={onChange}
          rowContext={{ field: 'latency' }}
        />
      );

      await user.click(screen.getByRole('combobox'));

      // LATENCY = ['very_fast', 'fast', 'medium']
      expect(screen.getByText('very_fast')).toBeInTheDocument();
      expect(screen.getByText('fast')).toBeInTheDocument();
      expect(screen.getByText('medium')).toBeInTheDocument();
    });
  });

  // ── Editable mode: no editable/onChange combo → read-only ───────────────

  describe('editable prop absent — read-only display', () => {
    it('renders read-only text when editable is not provided', () => {
      const field = makeField({ display: 'text' });
      render(<ReviewField field={field} value="static value" />);

      expect(screen.getByText('static value')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('renders read-only text when editable is true but onChange is absent', () => {
      const field = makeField({ display: 'text' });
      // editable: true but no onChange — should stay read-only
      render(<ReviewField field={field} value="no-change" editable={true} />);

      expect(screen.getByText('no-change')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });
});
