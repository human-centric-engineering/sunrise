/**
 * What each org role may do, for the Members page's role fields (§111 t-813).
 *
 * Describes the rules `lib/tenancy/lifecycle.ts` enforces; it enforces none
 * of them. The page sends the change and shows the API's answer.
 */

import { FieldHelp } from '@/components/ui/field-help';
import type { OrgRole } from '@/lib/tenancy/roles';

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

export function OrgRoleHelp() {
  return (
    <FieldHelp title="Organisation roles">
      <ul className="list-disc space-y-1 pl-4">
        <li>
          <strong>Member</strong>: uses the organisation&apos;s agents. Cannot open the admin
          console.
        </li>
        <li>
          <strong>Admin</strong>: manages this organisation&apos;s agents, knowledge and members.
        </li>
        <li>
          <strong>Owner</strong>: everything an admin can do, and can make or remove owners.
        </li>
      </ul>
      <p className="mt-2">
        Only an owner can give someone the owner role or change an owner&apos;s role. The last owner
        cannot be demoted or removed.
      </p>
    </FieldHelp>
  );
}
