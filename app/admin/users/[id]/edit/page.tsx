import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser } from '@/types/admin';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Edit User ${id}`,
    description: 'Edit user details',
  };
}

async function getUser(id: string): Promise<AdminUser | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        emailVerified: true,
        image: true,
        bio: true,
        phone: true,
        timezone: true,
        location: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return user as AdminUser | null;
  } catch (err) {
    logger.error('admin user edit page: fetch failed', err, { id });
    return null;
  }
}

/**
 * Admin User Edit Page
 *
 * Edit user details (name, role, email verification).
 */
export default async function AdminUserEditPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getServerSession();
  if (!session) {
    notFound();
  }

  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  return <UserEditForm user={user} currentUserId={session.user.id} />;
}
