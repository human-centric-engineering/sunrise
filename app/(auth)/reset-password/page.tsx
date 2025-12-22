import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Password Reset Page (Placeholder)
 *
 * This page will handle password reset requests once the email system is implemented in Phase 3.
 * For now, it shows a placeholder message.
 */
export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Reset your password</CardTitle>
        <CardDescription>
          Password reset will be available once the email system is configured
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-muted text-muted-foreground rounded-md p-4 text-sm">
          <p className="mb-2 font-medium">Coming in Phase 3</p>
          <p>
            Password reset requires the Resend email service integration, which will be implemented
            in Phase 3.1 of the build plan. This will enable sending password reset links via email.
          </p>
        </div>

        <div className="pt-4">
          <Link href="/login">
            <Button className="w-full">Back to Login</Button>
          </Link>
        </div>

        <div className="text-center text-sm">
          <span className="text-muted-foreground">Need help? </span>
          <Link href="/signup" className="text-primary font-medium hover:underline">
            Create a new account
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
