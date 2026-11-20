import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ThemeToggle } from '@/components/theme-toggle';
import { BRAND } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.layout.meta');
  return {
    title: {
      // No words to translate, and `%s` must reach Next intact.
      template: `%s - ${BRAND.name}`,
      default: t('defaultTitle', { brand: BRAND.name }),
    },
    description: t('description'),
  };
}

/**
 * Auth Layout
 *
 * Minimal centered layout for authentication pages (login, signup, etc.)
 * No navigation or footer - just centered content on a clean background
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="bg-background min-h-screen">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
