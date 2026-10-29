'use client';

/**
 * Email Status Card Component
 *
 * Displays the email verification status on the dashboard with contextual
 * messaging and actions based on the verification state.
 *
 * States:
 * - verified: Shows "Verified" with green checkmark
 * - pending: Shows "Unverified" with option to resend verification email
 * - not_sent: Shows "Unverified" with option to send verification email
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertCircle, Mail, Loader2 } from 'lucide-react';
import type { VerificationStatus } from '@/lib/auth/verification-status';
import { SaveError } from '@/components/forms/form-error';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

interface EmailStatusCardProps {
  status: VerificationStatus;
  email: string;
}

export function EmailStatusCard({ status: initialStatus, email }: EmailStatusCardProps) {
  const [status, setStatus] = useState<VerificationStatus>(initialStatus);
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const save = useSaveFailure({ fallback: 'An error occurred. Please try again.' });

  const handleSendVerification = () => {
    setIsLoading(true);
    setSent(false);
    save.clear();

    fetch('/api/auth/send-verification-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    })
      .then((response) => {
        if (response.ok) {
          setStatus('pending');
          setSent(true);
        } else if (response.status === 429) {
          save.show('Too many requests. Please try again later.');
        } else {
          save.show('Failed to send verification email. Please try again.');
        }
      })
      .catch((err: unknown) => {
        save.report(err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  // What the last send said, just above the button that sent it. One slot in
  // both unverified states, so the button keeps its place when the status moves.
  const feedback = (
    <>
      {sent && (
        <p className="mt-2 text-xs text-green-600">Verification email sent! Check your inbox.</p>
      )}
      {save.failure && (
        <div className="mt-2">
          <SaveError failure={save.failure} />
        </div>
      )}
    </>
  );

  // Render content based on status
  const renderContent = () => {
    switch (status) {
      case 'verified':
        return (
          <>
            <div className="text-2xl font-bold">Verified</div>
            <p className="text-muted-foreground text-xs">Your email is verified</p>
          </>
        );

      case 'pending':
        return (
          <>
            <div className="text-2xl font-bold">Unverified</div>
            <p className="text-muted-foreground text-xs">Check your inbox to verify your email</p>
            {feedback}
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={handleSendVerification}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="mr-1 h-3 w-3" />
                  Resend Email
                </>
              )}
            </Button>
          </>
        );

      case 'not_sent':
        return (
          <>
            <div className="text-2xl font-bold">Unverified</div>
            <p className="text-muted-foreground text-xs">Verify your email for added security</p>
            {feedback}
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={handleSendVerification}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="mr-1 h-3 w-3" />
                  Verify Email
                </>
              )}
            </Button>
          </>
        );
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Email Status</CardTitle>
        {status === 'verified' ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : (
          <AlertCircle className="h-4 w-4 text-yellow-500" />
        )}
      </CardHeader>
      <CardContent>{renderContent()}</CardContent>
    </Card>
  );
}
