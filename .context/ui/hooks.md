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

## See also

- [Setup Wizard](../admin/setup-wizard.md) — composes both hooks together
- [Contextual help](./contextual-help.md)
