'use client';

/**
 * User Edit Form Component (Phase 4.4)
 *
 * Form for admins to edit user details (name, role, email verification).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AlertCircle, Save, ArrowLeft } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { ClientDate } from '@/components/ui/client-date';
import type { AdminUser } from '@/types/admin';

/**
 * Form validation schema
 */
const userEditSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  role: z.enum(['USER', 'ADMIN', 'MODERATOR']),
  emailVerified: z.boolean(),
});

type UserEditFormData = z.infer<typeof userEditSchema>;

interface UserEditFormProps {
  user: AdminUser;
  currentUserId: string;
}

/**
 * Get initials from a name
 */
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function UserEditForm({ user, currentUserId }: UserEditFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isCurrentUser = user.id === currentUserId;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<UserEditFormData>({
    resolver: zodResolver(userEditSchema),
    defaultValues: {
      name: user.name,
      role: (user.role as 'USER' | 'ADMIN' | 'MODERATOR') || 'USER',
      emailVerified: user.emailVerified,
    },
  });

  const currentRole = watch('role');
  const currentEmailVerified = watch('emailVerified');

  const onSubmit = async (data: UserEditFormData) => {
    setIsSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await apiClient.patch(`/api/v1/users/${user.id}`, {
        body: data,
      });
      setSuccess(true);
      // Refresh the page data
      router.refresh();
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" onClick={() => router.push('/admin/users')} className="-ml-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Users
      </Button>

      <div className="grid gap-6 md:grid-cols-3">
        {/* User Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>User Info</CardTitle>
            <CardDescription>Basic information about the user</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <Avatar className="h-24 w-24">
              <AvatarImage src={user.image || undefined} alt={user.name} />
              <AvatarFallback className="text-2xl">{getInitials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="text-center">
              <p className="font-medium">{user.name}</p>
              <p className="text-muted-foreground text-sm">{user.email}</p>
            </div>
            <div className="text-muted-foreground flex flex-col gap-1 text-xs">
              <p>ID: {user.id}</p>
              <p>
                Created: <ClientDate date={user.createdAt} />
              </p>
              <p>
                Updated: <ClientDate date={user.updatedAt} />
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Edit Form Card */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Edit User</CardTitle>
            <CardDescription>Update user information and permissions</CardDescription>
          </CardHeader>
          <form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
            <CardContent className="space-y-6">
              {/* Error message */}
              {error && (
                <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}

              {/* Success message */}
              {success && (
                <div className="rounded-md bg-green-50 p-3 text-sm text-green-600 dark:bg-green-950/20 dark:text-green-400">
                  User updated successfully!
                </div>
              )}

              {/* Name field */}
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...register('name')} placeholder="Enter user's name" />
                {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
              </div>

              {/* Role field */}
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select
                  value={currentRole}
                  onValueChange={(value) =>
                    setValue('role', value as 'USER' | 'ADMIN' | 'MODERATOR', { shouldDirty: true })
                  }
                  disabled={isCurrentUser}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="MODERATOR">Moderator</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
                {isCurrentUser && (
                  <p className="text-muted-foreground text-xs">You cannot change your own role</p>
                )}
                {errors.role && <p className="text-sm text-red-500">{errors.role.message}</p>}
              </div>

              {/* Email Verified field */}
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="emailVerified">Email Verified</Label>
                  <p className="text-muted-foreground text-sm">
                    Mark the user&apos;s email as verified
                  </p>
                </div>
                <Switch
                  id="emailVerified"
                  checked={currentEmailVerified}
                  onCheckedChange={(checked) =>
                    setValue('emailVerified', checked, { shouldDirty: true })
                  }
                />
              </div>
            </CardContent>
            <CardFooter className="flex justify-end gap-2 border-t pt-6">
              <Button type="button" variant="outline" onClick={() => router.push('/admin/users')}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isDirty || isSubmitting}>
                <Save className="mr-2 h-4 w-4" />
                {isSubmitting ? 'Saving...' : 'Save Changes'}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
