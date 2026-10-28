# Form save errors

How a form shows a save the server refused. **One mechanism for every form**
(§124 owner ruling, 2026-10-26): a form never draws its own error box for a
failed save.

The failure this exists to prevent: on a long page whose Save stays on screen
as you scroll, the error was drawn at the top of the form, off-screen. Nothing
brought it into view, so the save looked like it did nothing. The stale notice
was also amber, which doesn't read as a failure.

## The pieces

| Piece                | Where                                                  | Job                                                                                                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `readSaveError()`    | `lib/errors/save-error.ts`                             | Turns what a save threw into a `SaveFailure`: a message, the named fields, `stale`                     |
| `applyFieldErrors()` | `lib/errors/save-error.ts`                             | Puts a failure's field messages on a react-hook-form form through `setError`                           |
| `<SaveError>`        | `components/forms/form-error.tsx`                      | Shows the failure by Save: red, `role="alert"`, brought into view and focused when it appears          |
| `<StaleSaveNotice>`  | `components/admin/orchestration/stale-save-notice.tsx` | `<SaveError>`'s stale variant, mounted on its own by a page with no `<SaveError>` (lists, the builder) |

`<FormError>` in the same file is unchanged and is **not** for a failed save:
it is the inline box for a client-side message or an auth-flow code.

## The rules

1. **Placement is the form's job, movement is the component's.** Put
   `<SaveError>` directly beside the Save button that was pressed: inside the
   same sticky bar when Save is sticky, so the error stays in view with it.
   The component decides nothing about where it sits.
2. **Red, always.** A refused save failed, including a stale one.
3. **Every new failure moves.** Each failure is a new object from
   `readSaveError()`, and each one brings the error into view and takes focus,
   so a second refusal with the same message still moves. Clear it
   (`setSaveFailure(null)`) when a save starts.
4. **Named fields get the focus.** When the server named fields, their
   messages go under those fields, the summary by Save says how many
   (`"2 fields need fixing."`), and focus moves to the first of them **in page
   order** (not the order the server sent). Without named fields the error box
   itself takes focus.
5. **Nothing the server said is lost.** A path the form has no field for joins
   the summary text instead.
6. **No toast.** The app has no toast system, and the stale notice needs room
   for its explanation and its Reload and Copy buttons.

## Reading the failure

The server sends field errors in two shapes; `readSaveError()` reads both.

| Sender                                        | `details` shape                   |
| --------------------------------------------- | --------------------------------- |
| `validateRequestBody` / `validateQueryParams` | `{ errors: [{ path, message }] }` |
| `handleAPIError` on a raw `ZodError`          | `Record<path, string[]>`          |

Only the first message per field is kept: one line under each field.

**Server paths are not form field names.** A form declares a table from the
server path to the field that shows it. The table is typed to the form's own
field names, so `applyFieldErrors()` can only set fields the form has:

```ts
const SERVER_FIELDS: Partial<Record<string, keyof SettingsFormData>> = {
  defaultApprovalTimeoutMs: 'approvalTimeout',
  'searchConfig.bm25Weight': 'bm25Weight',
  // a path missing here (escalationConfig.emailAddresses.0) joins the summary
};
```

Without a table, each server path is taken as the field name. That is for a
plain-state form placing messages itself; a react-hook-form form always
passes a table, and the types refuse it otherwise.

A non-API error (a network failure, a bug that threw) gets the form's
`fallback` message.

## Recipe: a react-hook-form form

```tsx
const { setError, ... } = useForm<FormData>(...);
const [saveFailure, setSaveFailure] = useState<SaveFailure<keyof FormData> | null>(null);

const onSubmit = async (values: FormData) => {
  setSaveFailure(null);
  try {
    await apiClient.patch(url, { body: values });
  } catch (err) {
    const failure = readSaveError(err, {
      fallback: 'Could not save. Try again in a moment.',
      fields: SERVER_FIELDS,
    });
    applyFieldErrors(failure, setError);
    setSaveFailure(failure);
  }
};

// beside Save:
<div className="sticky bottom-4 space-y-2">
  <SaveError failure={saveFailure} stale={{ what: 'This record' }} />
  <Button type="submit">Save</Button>
</div>
```

The field renders its message as it already does (`errors.x?.message`).
`applyFieldErrors()` passes `shouldFocus: false`, because `<SaveError>` does
the focusing and picks the first field in page order.

## Recipe: a plain-state form

Call `readSaveError(err, { fallback })` (or with a table, to rename paths),
keep the `SaveFailure`, and render each `failure.fields` entry under its
field. Pass the same failure to `<SaveError>`.

## Finding the field to focus

`<SaveError>` looks inside its enclosing `<form>` (or the document) for an
element whose `name`, or failing that `id`, is a named field. So **a field
can only receive focus if its control carries the field name as `name` or
`id`**. `register()` sets `name`; a `Controller`-driven control (a Select, a
Switch) needs an `id` equal to its field name. When no named field
is found, the error box takes focus instead: nothing is lost, the person just
lands on the summary.

## A field on a hidden tab

A field on a tab that isn't showing is as invisible as one off-screen. A
tabbed form passes `onRevealField`:

```tsx
<SaveError failure={saveFailure} onRevealField={(field) => setTab(tabOf(field))} />
```

When none of the named fields is on the page, `<SaveError>` calls it with the
first named field, then looks again on the next frame and focuses what the
reveal brought forward. Without `onRevealField`, the error box takes focus.

## The stale variant

A 412 `STALE_RECORD` (§122) sets `failure.stale`. `<SaveError>` renders the
stale body (what changed, that nothing was saved, **Reload**, and **Copy my
changes** when the page can copy its edits out) when it is given `stale`
props:

```tsx
<SaveError failure={saveFailure} stale={{ what: 'The escalation list', onReload, onCopyChanges }} />
```

Without `stale` props, a stale failure shows its message like any other.

A page that shows the stale notice without a `<SaveError>` (a list whose row
toggles are refused, the workflow builder's toolbar) mounts
`<StaleSaveNotice>` with the same props. It is the same component, so it is
red and moves too; mounting it is what counts as "appearing", so clear the
flag when the next attempt starts.

## Out of scope

Load and run errors in panels (execution detail, evaluation runner), error
boundaries, and `ErrorCard` are not save errors and keep their own display.

## Where it is used

- `components/admin/orchestration/settings-form.tsx`: sticky Save at the
  bottom. Only the escalation list is versioned there, so a stale save is
  always that list.
- `components/admin/orchestration/webhook-form.tsx`: sticky Save in the top
  bar.
- `<StaleSaveNotice>`: webhooks table, workflow schedules tab, workflow
  builder.

The remaining admin forms (including the tabbed agent and capability forms),
`components/forms/` and the auth pages move onto it in §124's later tasks,
which also add a check against hand-drawn save-error boxes.
