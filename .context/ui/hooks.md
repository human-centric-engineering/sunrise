# UI Hooks

Shared client-side hooks under `lib/hooks/`. Entry point for reusable client state primitives.

## `useLocalStorage<T>(key, initial)`

**File:** `lib/hooks/use-local-storage.ts`

SSR-safe state hook synced with `window.localStorage`.

```ts
export function useLocalStorage<T>(
  key: string,
  initial: T
): [T, (value: T | ((prev: T) => T)) => void, () => void];
```

- **Return tuple:** `[value, setValue, remove]`
- **SSR-safe:** on the server, returns `initial` and makes the setter a no-op. A post-mount effect hydrates from storage on the client.
- **JSON round-trip:** values are stringified on write, parsed on read. Invalid JSON falls back to `initial` and logs a warning.
- **Cross-tab sync:** listens for `storage` events so two tabs stay in sync. A null `newValue` (another tab called `removeItem`) resets to `initial`.

### Caveats

- Do **not** store `Date`, `Map`, `Set`, class instances, or functions — they don't survive the JSON round-trip. Store plain data only.
- Version your keys when the stored shape might change (e.g., `sunrise.mything.v1`). Bump the version on breaking changes so stale drafts are ignored silently.

### Example

```tsx
const [draft, setDraft, clearDraft] = useLocalStorage('sunrise.wizard.v1', {
  stepIndex: 0,
  name: '',
});

setDraft((prev) => ({ ...prev, name: 'Alice' }));
// ...later
clearDraft();
```

## `useWizard({ totalSteps, initialIndex? })`

**File:** `lib/hooks/use-wizard.ts`

Pure step-index state machine. Independent of storage — combine with `useLocalStorage` for resume-across-refreshes behaviour.

```ts
interface WizardState {
  stepIndex: number;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  reset: () => void;
}

export function useWizard(options: { totalSteps: number; initialIndex?: number }): WizardState;
```

- All navigation helpers clamp to `[0, totalSteps - 1]`.
- `goTo` clamps out-of-range indices instead of throwing.
- `reset()` returns to `initialIndex`, not 0.

### Example

```tsx
const wiz = useWizard({ totalSteps: 5 });
<Button onClick={wiz.next} disabled={wiz.isLast}>
  Next
</Button>;
```

## `useCopyToClipboard(resetMs?)`

**File:** `lib/hooks/use-copy-to-clipboard.ts`

Best-effort "copy to clipboard" with a self-clearing "copied!" flag — the
canonical primitive for copy buttons. Owns the reset timer so it's cleared on
unmount and re-armed (not stacked) on a rapid second copy, fixing the
setState-after-unmount leak that an uncleared `setTimeout(() => setCopied(false))`
otherwise causes (issue #301).

```ts
interface UseCopyToClipboardResult {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
}

export function useCopyToClipboard(resetMs?: number): UseCopyToClipboardResult;
```

- **`resetMs`** defaults to `2000`. `copied` is `true` for that window after a
  successful copy, then flips back to `false`.
- **`copy(text)`** writes via `navigator.clipboard.writeText`; resolves `true` on
  success, `false` if the write fails (insecure context / denied permission). The
  failure is swallowed — no timer is armed — so copying is best-effort.
- Keep your own event handling (`e.stopPropagation()`, guards) at the call site;
  the hook only owns copy + the `copied` flag + the reset timer.

### Example

```tsx
const { copied, copy } = useCopyToClipboard();

<Button
  onClick={(e) => {
    e.stopPropagation();
    void copy(text);
  }}
>
  {copied ? <Check /> : <Copy />}
</Button>;
```

## See also

- [Setup Wizard](../admin/setup-wizard.md) — composes both hooks together
- [Contextual help](./contextual-help.md)
