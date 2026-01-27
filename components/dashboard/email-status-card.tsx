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

interface EmailStatusCardProps {
  status: VerificationStatus;
  email: string;
}

export function EmailStatusCard({ status: initialStatus, email }: EmailStatusCardProps) {
  const [status, setStatus] = useState<VerificationStatus>(initialStatus);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSendVerification = () => {
    setIsLoading(true);
    setMessage(null);

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
          setMessage('Verification email sent! Check your inbox.');
        } else if (response.status === 429) {
          setMessage('Too many requests. Please try again later.');
        } else {
          setMessage('Failed to send verification email. Please try again.');
        }
      })
      .catch(() => {
        setMessage('An error occurred. Please try again.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

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
            {message && <p className="mt-2 text-xs text-green-600">{message}</p>}
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
            {message && (
              <p
                className={`mt-2 text-xs ${message.includes('sent') ? 'text-green-600' : 'text-red-600'}`}
              >
                {message}
              </p>
            )}
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
