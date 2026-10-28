'use client';

/**
 * Shown when a save is refused because the record changed since the page
 * loaded it (412 `STALE_RECORD`, §122 t-899): another admin saved it, or a
 * person on it had their data erased.
 *
 * Nothing was written, and the admin's edits are still in the form. Reloading
 * would discard them, so the notice says so and leaves the reload to them
 * rather than doing it. A page that can copy its edits out (the workflow
 * builder, t-900) offers that first.
 *
 * It is the stale variant of `<SaveError>` (§124), so it is red and brings
 * itself into view and takes focus when it appears. A form that already
 * renders `<SaveError>` passes these props as its `stale` instead.
 *
 * @see lib/api/record-version.ts
 * @see .context/ui/form-errors.md
 */

import { useState } from 'react';

import { SaveError, type StaleSaveProps } from '@/components/forms/form-error';
import type { SaveFailure } from '@/lib/errors/save-error';

export type StaleSaveNoticeProps = StaleSaveProps;

export function StaleSaveNotice(props: StaleSaveNoticeProps) {
  // One failure per mount: a page shows the notice by mounting it, so each
  // refusal (cleared, then set again) brings it into view afresh.
  const [failure] = useState<SaveFailure>(() => ({
    message: `${props.what} changed since you opened it. Nothing was saved.`,
    stale: true,
    fields: [],
  }));
  return <SaveError failure={failure} stale={props} />;
}
