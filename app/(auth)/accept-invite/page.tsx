import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AcceptInviteForm } from '@/components/forms/accept-invite-form';

/**
 * Accept Invitation Page
 *
 * Allows invited users to set their password and activate their account.
 * Reads token and email from URL parameters, validates invitation,
 * and redirects to login after successful acceptance.
 *
 * Note: AcceptInviteForm uses useSearchParams() which requires Suspense boundary
 */
export default function AcceptInvitePage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Accept Invitation</CardTitle>
        <CardDescription>Set your password to activate your account</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>Loading...</div>}>
          <AcceptInviteForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
