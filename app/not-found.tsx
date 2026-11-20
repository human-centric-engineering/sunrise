import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('errors.notFound');
  return (
    <div className="flex min-h-screen flex-col items-center justify-center">
      <h2 className="mb-4 text-2xl font-bold">{t('title')}</h2>
      <p className="mb-4">{t('description')}</p>
      <Link href="/" className="rounded-lg bg-blue-500 px-4 py-2 text-white hover:bg-blue-600">
        {t('returnHome')}
      </Link>
    </div>
  );
}
