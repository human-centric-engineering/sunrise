/**
 * What each support-grant level lets the vendor's support staff do (§121
 * t-823), for the Support access page.
 *
 * Describes the rules; enforces none of them. Entering under a grant, and
 * refusing writes at read-only, are the guard's (§121 t-824).
 */

import { FieldHelp } from '@/components/ui/field-help';
import type { SupportGrantLevel } from '@/lib/tenancy/roles';

export const SUPPORT_GRANT_LEVEL_LABELS: Record<SupportGrantLevel, string> = {
  ADMIN: 'Admin',
  READ_ONLY: 'Read-only',
};

export function SupportLevelHelp() {
  return (
    <FieldHelp title="Access levels">
      <ul className="list-disc space-y-1 pl-4">
        <li>
          <strong>Admin</strong>: support can do what an admin of this organisation can, such as
          fixing an agent or a workflow.
        </li>
        <li>
          <strong>Read-only</strong>: support can look at the same things, but cannot change
          anything.
        </li>
      </ul>
      <p className="mt-2">
        Either way, support cannot see members&apos; private conversations, and everything they do
        is recorded in their own name.
      </p>
    </FieldHelp>
  );
}
