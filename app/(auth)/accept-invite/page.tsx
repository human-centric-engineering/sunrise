import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AcceptInviteForm } from '@/components/forms/accept-invite-form';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'Accept Invitation',
  description: `Accept your invitation to join ${BRAND.name}`,
};

/**
 * Accept Invitation Page
 *
 * A new invitee sets a password (or uses OAuth) to create their account; an
 * address that already has an account signs in and accepts instead (#1199).
 * Either can decline. Reads token and email from URL parameters.
 *
 * Note: AcceptInviteForm uses useSearchParams() which requires Suspense boundary
 */
export default function AcceptInvitePage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Accept Invitation</CardTitle>
        <CardDescription>Accept your invitation, or decline it</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>Loading...</div>}>
          <AcceptInviteForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
