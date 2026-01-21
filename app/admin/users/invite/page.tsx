import type { Metadata } from 'next';
import { UserInviteForm } from '@/components/admin/user-invite-form';

export const metadata: Metadata = {
  title: 'Invite User',
  description: 'Invite a new user to join',
};

/**
 * Admin Invite User Page (Phase 4.4)
 *
 * Form to invite new users by email.
 */
export default function AdminInviteUserPage() {
  return <UserInviteForm />;
}
