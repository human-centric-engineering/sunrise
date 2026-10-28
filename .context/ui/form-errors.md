# Form save errors

How a form shows a save the server refused. **One mechanism for every form**
(§124 owner ruling, 2026-10-26): a form never draws its own error box for a
failed save.

The failure this exists to prevent: on a long page whose Save stays on screen
as you scroll, the error was drawn at the top of the form, off-screen. Nothing
brought it into view, so the save looked like it did nothing. The stale notice
was also amber, which doesn't read as a failure.

## The pieces

| Piece                    | Where                                                  | Job                                                                                                    |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `readSaveError()`        | `lib/errors/save-error.ts`                             | Turns what a save threw into a `SaveFailure`: a message, the named fields, `stale`                     |
| `applyFieldErrors()`     | `lib/errors/save-error.ts`                             | Puts a failure's field messages on a react-hook-form form through `setError`                           |
| `isStaleSave()`          | `lib/errors/save-error.ts`                             | Whether a save was refused as stale, for a page that needs only that                                   |
| `useSaveFailure()`       | `lib/hooks/use-save-failure.ts`                        | Owns a page's failure: reports what a save threw, and clears it on every press of Save                 |
| `apiErrorFromResponse()` | `lib/api/client.ts`                                    | The `APIClientError` a failed raw `fetch` would have raised through `apiClient`                        |
| `useCommittedDialog()`   | `lib/hooks/use-committed-dialog.ts`                    | Locks a dialog while its save runs, and clears its failure each time it opens                          |
| `<SaveError>`            | `components/forms/form-error.tsx`                      | Shows the failure by Save: red, `role="alert"`, brought into view and focused when it appears          |
| `<StaleSaveNotice>`      | `components/admin/orchestration/stale-save-notice.tsx` | `<SaveError>`'s stale variant, mounted on its own by a page with no `<SaveError>` (lists, the builder) |

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
   so a second refusal with the same message still moves. Clear it on every
   press of Save, before validation: a press that client validation blocks
   never reaches the submit handler, and an old summary must not sit beside
   the new client errors. `useSaveFailure()`'s `submit()` does both.
4. **Named fields get the focus.** When the server named fields, their
   messages go under those fields, the summary by Save says how many
   (`"2 fields need fixing."`), and focus moves to the first of them **in page
   order** (not the order the server sent). Without named fields, or when the
   first can't be found or take focus, the error box itself takes focus.
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

Both come from a `VALIDATION_ERROR`, and only that code is read for fields:
another error's `details` can be record-shaped metadata
(`{ unknownIds: [...] }`), which is not fields. A route that answers
`VALIDATION_ERROR` with metadata of its own sends it beside the list shape,
which wins (`{ errors: [...], unknownProviders: [...] }` from the org
providers `PUT`); bare, it would be read as a field named `unknownProviders`.

Every distinct message for a field is kept, joined, under that field: when
several paths land on one field (each element of an array), each problem is
said at once rather than costing another save.

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

**List only fields that render their error** (`errors.x?.message` under the
control). A select or switch that renders none must stay out of the table, so
its message reaches the summary; mapped, it would be set on the form and shown
nowhere. The same goes for a field the form shows only in some states (the
agent form's trigger keywords, the capability form's approval timeout): add
it to a memoised table only while it shows. An array element's path
(`retryBackoffMs.1`) falls back to its array's entry, so the table lists the
array once.

Every mapped field needs a `name` or `id` on the page equal to its field name,
or focus can't reach it: a Select's trigger takes the `id`, and a checkbox
group takes it on its `role="group"` wrapper with `tabIndex={-1}`.

Without a table, each server path is taken as the field name. That is for a
plain-state form placing messages itself; a react-hook-form form always
passes a table, and the types refuse it otherwise.

An error the server never wrote gets the form's `fallback` message: a thrown
bug, and the network failures and non-JSON responses `apiClient` raises as
`NETWORK_ERROR` / `INVALID_RESPONSE`, whose own text ("Failed to fetch") is the
browser's.

Keep a path out of the table when the server's message wouldn't make sense
under the field: the webhook form's `retryBackoffMs` messages are in
milliseconds, and its field takes seconds.

## Recipe: a react-hook-form form

```tsx
const { setError, handleSubmit, ... } = useForm<FormData>(...);
const save = useSaveFailure({
  fallback: 'Could not save. Try again in a moment.',
  fields: SERVER_FIELDS,
  setError,
});

const onSubmit = async (values: FormData) => {
  try {
    await apiClient.patch(url, { body: values });
  } catch (err) {
    save.report(err); // reads it, sets field messages, shows it
  }
};

<form onSubmit={save.submit(handleSubmit(onSubmit))}>

// beside Save:
<div className="sticky bottom-4 space-y-2">
  <SaveError failure={save.failure} stale={{ what: 'This record' }} />
  <Button type="submit">Save</Button>
</div>
```

The field renders its message as it already does (`errors.x?.message`).
`report()` passes `shouldFocus: false` to `setError`, because `<SaveError>`
does the focusing and picks the first field in page order. It returns the
failure, so a caller can branch on `stale`.

A check the form makes itself when Save is pressed (invalid JSON in an editor,
a name that must match the slug) is a failed save too: `save.show(message)`
puts it in the same place. Client validation that blocks fields on a **tabbed**
form goes there as well, with the fields, so their tab comes forward:

```tsx
const onInvalid = (formErrors: FieldErrors<FormData>) =>
  save.show('2 fields need fixing.', namedFields(formErrors)); // only SERVER_FIELDS entries
<form onSubmit={save.submit(handleSubmit(onSubmit, onInvalid))}>
```

A load error is not a save error. When a form shared one state between them,
split it: the load error keeps its own display.

## Recipe: a plain-state form

`useSaveFailure({ fallback, fields: NO_SERVER_FIELDS })`: with an empty table
every server message joins the summary by Save, which is right for a form that
renders no message under its controls. Use the exported constant, not an
inline `{}`: a new table each render gives `save.report` a new identity each
render. A plain form that does place messages passes a
table (or none, to take server paths as field names), and renders each
`save.failure.fields` entry under its field. Call `save.clear()` first thing in
the Save handler when there is no `<form onSubmit>` to wrap.

## Recipe: a dialog

An action confirmed in a dialog shows its failure **inside the dialog**,
directly above its buttons, and the dialog **stays open** on failure, so the
person can read it and try again or cancel. Close it only on success. Radix's
`AlertDialogAction` closes the dialog on click, so its handler calls
`e.preventDefault()`. A dialog that closes and then shows the error elsewhere,
or draws it behind its own overlay, loses it (owner ruling, 2026-10-28).

While the action is in flight the dialog is committed to it: the action
button **and** Cancel are disabled, and the close Radix asks for (Escape, an
outside click) is ignored. Otherwise a second click sends the request twice,
and a failure arriving after the dialog closed is shown nowhere. The dialog's
failure is cleared **each time it opens**, so one row's failure never appears
in the next row's dialog. `useCommittedDialog()` does all of it; a dialog that
saves uses it rather than writing the guards out:

```tsx
const dialog = useCommittedDialog({
  open: !!target,
  pending: deleting,
  onClose: () => setTarget(null),
  clear: deleteSave.clear,
});

<AlertDialog open={!!target} onOpenChange={dialog.onOpenChange}>
  …
  <SaveError failure={deleteSave.failure} />
  <AlertDialogFooter>
    <AlertDialogCancel {...dialog.cancelProps}>Cancel</AlertDialogCancel>
    <AlertDialogAction {...dialog.actionProps()} onClick={(e) => dialog.confirm(e, handleDelete)}>
      Delete
    </AlertDialogAction>
  </AlertDialogFooter>
</AlertDialog>;
```

`actionProps({ disabled })` adds the action's own reasons to be disabled (an
empty required reason). `confirm(e, run)` takes the action at click time, not
during render, so an action that reads a ref passes the React Compiler's
`react-hooks/refs` rule. A dialog that opens through its own
`DialogTrigger` passes `onOpen`. The save closes the dialog itself on
success.

A controlled dialog with no `DialogTrigger` returns no focus when it closes.
One with a trigger hands focus back to it, after a failure shown outside the
dialog has taken focus: prevent that with
`onCloseAutoFocus={(e) => e.preventDefault()}` on that close.

## A page that sends its own `fetch`

`readSaveError()` reads an `APIClientError`; anything else gets the fallback.
A save sent through `apiClient` throws one. A page that has to send its own
`fetch` (a multipart upload, a stream) turns a failed response into the same
error before reporting it:

```ts
const res = await fetch(url, { method: 'POST', body: formData });
if (!res.ok) throw await apiErrorFromResponse(res);
```

Prefer moving a plain JSON save to `apiClient` over this.

## Recipe: a list's row actions

A toggle, delete or retry in a row has no Save to sit beside. Each list
renders **one** `<SaveError>` directly above its table, fed by one
`useSaveFailure()`; every row action clears it, then reports into it. It
brings itself into view and takes focus, so a failure on row 40 is not lost
off-screen (owner ruling, 2026-10-28). An action confirmed in a dialog follows
the dialog recipe instead.

The box sits away from the row, so say which row: a second argument to
`report` leads the server's message with it, as in
``save.report(err, `Couldn't update "${agent.name}"`)``. A bulk action names
the action (`Bulk deactivate failed`).

A refresh after a save that succeeded is not part of the save. Re-read the
list outside the save's `try`, so a failed refresh isn't reported as the
save failing (a new key's plaintext is already on screen by then). A bulk
action that fails part-way does refresh, so what it did delete goes.

## Finding the field to focus

`<SaveError>` looks inside its enclosing `<form>` (or the document) for an
element whose `name`, or failing that `id`, is a named field. So **a field
can only receive focus if its control carries the field name as `name` or
`id`**. `register()` sets `name`; a `Controller`-driven control (a Select, a
Switch) needs an `id` equal to its field name. A control with neither (a
checkbox group, a multi-select with its own id) still shows its message under
itself, but focus then goes to the summary.

Focus goes to a field only when **every** named field is on the page: with
one missing, the first in page order is unknown, and focusing a later field
would skip an earlier error. It also has to take focus (a disabled input
doesn't). Otherwise the error box takes focus: nothing is lost, the person
just lands on the summary.

## A field on a hidden tab

A field on a tab that isn't showing is as invisible as one off-screen. A
tabbed form controls its tabs and passes `onRevealField`:

```tsx
<SaveError failure={save.failure} onRevealField={(fields) => setTab(earliestTabHolding(fields))} />
```

When not every named field is on the page, `<SaveError>` calls it with all of
them. The form brings forward the **earliest tab, in tab order**, holding one;
when that is the tab already showing, it changes nothing. `<SaveError>` then
looks again over the next few frames and focuses the first named field on the
page. With errors on two tabs, focus goes to the earlier tab's field; the
summary by Save says how many fields need fixing, and the next save brings the
other tab forward. Without `onRevealField`, the error box takes focus.

The agent form derives its field → tab map from the agent field registry
(`fieldToTab()`); the capability form declares one beside its table.

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
toggles are refused, the workflow builder's toolbar) tells a stale refusal
apart with `isStaleSave(err)` and mounts `<StaleSaveNotice>` with the same
props. It is the same component, so it is
red and moves too. Mounting it is what counts as "appearing", so the page
counts refusals and keys the notice on the count, which remounts it on each
one without hiding it in between (another row's toggle succeeding must not
take the reload prompt away):

```tsx
const [stale, setStale] = useState(0); // refused: setStale((n) => n + 1); reloaded: setStale(0)
{
  stale > 0 && <StaleSaveNotice key={stale} what="That schedule" onReload={reload} />;
}
```

## Out of scope

Load and run errors in panels (execution detail, evaluation runner), error
boundaries, and `ErrorCard` are not save errors and keep their own display.

## Where it is used

- `components/admin/orchestration/settings-form.tsx`: sticky Save at the
  bottom. Only the escalation list is versioned there, so a stale save is
  always that list.
- `components/admin/orchestration/webhook-form.tsx`: sticky Save in the top
  bar.
- The agent and capability forms: sticky Save in the top bar, and tabs.
- The other admin forms with a Save button (profiles, providers, models,
  default models, embedding model, widget appearance, MCP settings,
  evaluations, triggers, feature flags, users, members, support grants, org
  providers).
- The admin lists and dialogs (t-960): users, invitations, members, flags,
  support grants; agents, capabilities, providers and the setup wizard;
  knowledge and MCP; evaluations, experiments, workflows, schedules,
  executions, approvals, webhooks and triggers. Each list has one box above
  its table; each confirm dialog keeps its failure inside and stays open.
- `<StaleSaveNotice>`: webhooks table, workflow schedules tab, workflow
  builder.

Not converted, by rule: load errors, test / run / preview / search actions
(test buttons, the audit-models and rerun dialogs, the builder's run panel,
the pairwise judge, LLM generation previews, knowledge search), the chat's
messages (its approval card's approve and reject are converted), and org
switches. `components/forms/` and the auth pages move onto it in t-950,
which also adds a check against hand-drawn save-error boxes.
