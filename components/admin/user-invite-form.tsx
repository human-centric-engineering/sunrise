'use client';

/**
 * User Invite Form Component (Phase 4.4)
 *
 * Form for admins to invite new users by email.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormError } from '@/components/forms/form-error';
import { AlertCircle, Send, ArrowLeft, CheckCircle, Copy, ExternalLink } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

/**
 * Form validation schema
 * Local schema to ensure role is always required in form (no default)
 */
const inviteFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  email: z.string().email('Invalid email address'),
  role: z.enum(['USER', 'ADMIN']),
});

type InviteFormData = z.infer<typeof inviteFormSchema>;

interface InvitationResponse {
  message: string;
  invitation: {
    email: string;
    name: string;
    role: string;
    invitedAt: string;
    expiresAt: string;
    link?: string;
  };
  emailStatus: 'sent' | 'failed' | 'disabled' | 'pending';
}

export function UserInviteForm() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<InviteFormData>({
    resolver: zodResolver(inviteFormSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      role: 'USER',
    },
  });

  const currentRole = watch('role');

  const onSubmit = async (data: InviteFormData) => {
    try {
      setIsLoading(true);
      setError(null);
      setInvitation(null);

      const response = await apiClient.post<InvitationResponse>(API.USERS.INVITE, {
        body: data,
      });
      setInvitation(response);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (invitation?.invitation.link) {
      await navigator.clipboard.writeText(invitation.invitation.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleInviteAnother = () => {
    setInvitation(null);
    setError(null);
    reset();
  };

  // Show success state after invitation is created
  if (invitation) {
    return (
      <div className="space-y-6">
        {/* Back button */}
        <Button variant="ghost" onClick={() => router.push('/admin/users')} className="-ml-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Users
        </Button>

        <Card className="mx-auto max-w-lg">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
            </div>
            <CardTitle>Invitation Sent</CardTitle>
            <CardDescription>{invitation.message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border p-4">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="font-medium">{invitation.invitation.name}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="font-medium">{invitation.invitation.email}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="font-medium">{invitation.invitation.role}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Email Status</dt>
                  <dd className="font-medium capitalize">{invitation.emailStatus}</dd>
                </div>
              </dl>
            </div>

            {invitation.invitation.link && (
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Invitation Link</Label>
                <div className="flex gap-2">
                  <Input
                    value={invitation.invitation.link}
                    readOnly
                    className="text-muted-foreground text-xs"
                  />
                  <Button variant="outline" size="icon" onClick={() => void handleCopyLink()}>
                    <Copy className="h-4 w-4" />
                    <span className="sr-only">Copy link</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(invitation.invitation.link, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4" />
                    <span className="sr-only">Open link</span>
                  </Button>
                </div>
                {copied && (
                  <p className="text-xs text-green-600 dark:text-green-400">
                    Link copied to clipboard!
                  </p>
                )}
                {invitation.emailStatus !== 'sent' && (
                  <p className="text-muted-foreground text-xs">
                    You can share this link manually with the invited user.
                  </p>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-center gap-2 border-t pt-6">
            <Button variant="outline" onClick={() => router.push('/admin/users')}>
              Back to Users
            </Button>
            <Button onClick={handleInviteAnother}>Invite Another</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" onClick={() => router.push('/admin/users')} className="-ml-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Users
      </Button>

      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Invite User</CardTitle>
          <CardDescription>
            Send an invitation email to a new user. They will receive a link to set up their
            account.
          </CardDescription>
        </CardHeader>
        <form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <CardContent className="space-y-6">
            {/* Error message */}
            {error && (
              <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {/* Name field */}
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                disabled={isLoading}
                {...register('name')}
                placeholder="Enter user's full name"
              />
              <FormError message={errors.name?.message} />
            </div>

            {/* Email field */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                disabled={isLoading}
                {...register('email')}
                placeholder="Enter user's email address"
              />
              <FormError message={errors.email?.message} />
            </div>

            {/* Role field */}
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={currentRole}
                onValueChange={(value) =>
                  setValue('role', value as 'USER' | 'ADMIN', { shouldDirty: true })
                }
                disabled={isLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                The role determines what permissions the user will have after accepting the
                invitation.
              </p>
              <FormError message={errors.role?.message} />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2 border-t pt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push('/admin/users')}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              <Send className="mr-2 h-4 w-4" />
              {isLoading ? 'Sending...' : 'Send Invitation'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
