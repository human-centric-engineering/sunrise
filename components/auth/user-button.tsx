'use client';

/**
 * UserButton Component
 *
 * Dropdown menu button that displays authentication state and options.
 * - When not logged in: Shows user icon with "Log in" and "Create account" options
 * - When logged in: Shows avatar with profile, settings, and sign out options
 *
 * Used in the header of public and protected pages for consistent UX.
 */

import Link from 'next/link';
import { useState } from 'react';
import { User, LogOut, Settings, UserCircle, Shield } from 'lucide-react';
import { authClient, useSession } from '@/lib/auth/client';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getInitials } from '@/lib/utils/initials';

export function UserButton() {
  const { data: session, isPending } = useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const { track, reset } = useAnalytics();

  // Loading state - show skeleton to prevent hydration mismatch
  if (isPending) {
    return (
      <Button variant="ghost" size="icon" disabled className="h-9 w-9">
        <div className="bg-muted h-7 w-7 animate-pulse rounded-full" />
      </Button>
    );
  }

  // Not authenticated - show user icon with login/signup options
  if (!session) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9">
            <User className="h-5 w-5" />
            <span className="sr-only">User menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link href="/login" className="cursor-pointer">
              <UserCircle className="mr-2 h-4 w-4" />
              Log in
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/signup" className="cursor-pointer">
              <User className="mr-2 h-4 w-4" />
              Create account
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Authenticated - show avatar with profile/settings/signout options
  const { user } = session;
  const initials = getInitials(user.name || 'U');

  const handleSignOut = async () => {
    try {
      setIsSigningOut(true);
      await authClient.signOut({
        fetchOptions: {
          onSuccess: async () => {
            // Track logout and reset user identity
            await track(EVENTS.USER_LOGGED_OUT);
            await reset();
            // Hard redirect to fully clear in-memory session state (nanostore, cookie cache)
            window.location.href = '/';
          },
          onError: () => {
            setIsSigningOut(false);
          },
        },
      });
    } catch {
      setIsSigningOut(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-9 w-9 rounded-full p-0">
          <Avatar className="h-8 w-8">
            <AvatarImage src={user.image || undefined} alt={user.name || 'User'} />
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm leading-none font-medium">{user.name}</p>
            <p className="text-muted-foreground text-xs leading-none">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile" className="cursor-pointer">
            <User className="mr-2 h-4 w-4" />
            View profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings" className="cursor-pointer">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        {user.role === 'ADMIN' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin" className="cursor-pointer">
                <Shield className="mr-2 h-4 w-4" />
                Admin Dashboard
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => void handleSignOut()}
          disabled={isSigningOut}
          className="cursor-pointer"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {isSigningOut ? 'Signing out...' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
