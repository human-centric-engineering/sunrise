import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Email Verification Page (Placeholder)
 *
 * This page will handle email verification once the email system is implemented in Phase 3.
 * For now, it shows a placeholder message.
 */
export default function VerifyEmailPage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Verify your email</CardTitle>
        <CardDescription>
          Email verification will be available once the email system is configured
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-muted text-muted-foreground rounded-md p-4 text-sm">
          <p className="mb-2 font-medium">Coming in Phase 3</p>
          <p>
            Email verification requires the Resend email service integration, which will be
            implemented in Phase 3.1 of the build plan.
          </p>
        </div>

        <div className="pt-4">
          <Link href="/dashboard">
            <Button className="w-full">Continue to Dashboard</Button>
          </Link>
        </div>

        <div className="text-center text-sm">
          <Link href="/login" className="text-muted-foreground hover:text-primary hover:underline">
            Back to login
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
