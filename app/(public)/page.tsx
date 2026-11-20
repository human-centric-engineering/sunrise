import type { Metadata } from 'next';
import {
  Zap,
  Shield,
  Mail,
  Database,
  Settings,
  Code,
  Package,
  Rocket,
  FileCode,
  Brain,
  Search,
} from 'lucide-react';
import { Hero, Section, Features, Pricing, FAQ, CTA } from '@/components/marketing';
import type { Feature, FAQItem, PricingTier } from '@/components/marketing';
import { BRAND } from '@/lib/brand';
import { getTranslations } from 'next-intl/server';

const GITHUB_URL = 'https://github.com/human-centric-engineering/sunrise';

// Placeholder copy, like the rest of this page — you are expected to rewrite or
// delete it. It reads `BRAND.name` rather than naming the product, so a fork
// that has set `appBrandName` in lib/app/brand.ts but not yet rewritten this
// file still advertises itself rather than Sunrise (#519). A full sentence rather than
// `BRAND.description`, whose fallback is the bare product name: that is the
// right trade for the root layout and the wrong one here, where this string is
// the search-result snippet and the shared-link card.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.home.meta');
  const homeDescription = t('description', { brand: BRAND.name });
  return {
    // `(public)/layout.tsx` supplies the template `%s - ${BRAND.name}`, so this
    // declares the bare segment and the brand is appended once. The cards below
    // set no title of their own, so Next copies the resolved "Home - <brand>"
    // into both — one string to keep correct rather than three.
    title: t('title'),
    description: homeDescription,
    openGraph: {
      description: homeDescription,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      description: homeDescription,
    },
  };
}

type HomeT = Awaited<ReturnType<typeof getTranslations<'marketing.home'>>>;

function features(t: HomeT): Feature[] {
  const items = 'features.items';
  return [
    {
      icon: Zap,
      title: 'Next.js 16',
      description: t(`${items}.nextjs.description`),
    },
    {
      icon: FileCode,
      title: 'TypeScript',
      description: t(`${items}.typescript.description`),
    },
    {
      icon: Shield,
      title: t(`${items}.authentication.title`),
      description: t(`${items}.authentication.description`),
    },
    {
      icon: Database,
      title: 'PostgreSQL + Prisma',
      description: t(`${items}.database.description`),
    },
    { icon: Mail, title: t(`${items}.email.title`), description: t(`${items}.email.description`) },
    {
      icon: Package,
      title: t(`${items}.docker.title`),
      description: t(`${items}.docker.description`),
    },
    {
      icon: Brain,
      title: t(`${items}.orchestration.title`),
      description: t(`${items}.orchestration.description`),
    },
    {
      icon: Search,
      title: t(`${items}.knowledge.title`),
      description: t(`${items}.knowledge.description`),
    },
  ];
}

const HOW_IT_WORKS = [
  { key: 'fork', icon: Code },
  { key: 'configure', icon: Settings },
  { key: 'deploy', icon: Rocket },
] as const;

function howItWorks(t: HomeT): Feature[] {
  return HOW_IT_WORKS.map(({ key, icon }) => ({
    icon,
    title: t(`howItWorks.items.${key}.title`),
    description: t(`howItWorks.items.${key}.description`),
  }));
}

const OPEN_SOURCE_FEATURES = [
  'sourceAccess',
  'coreFeatures',
  'license',
  'community',
  'updates',
] as const;
const PRO_FEATURES = [
  'everythingOpenSource',
  'emailSupport',
  'priorityFixes',
  'architectureReview',
  'featureGuidance',
] as const;
const ENTERPRISE_FEATURES = [
  'everythingPro',
  'dedicatedChannel',
  'customDevelopment',
  'onboarding',
  'sla',
] as const;

function pricingTiers(t: HomeT): PricingTier[] {
  const tiers = 'pricing.tiers';
  return [
    {
      name: t(`${tiers}.openSource.name`),
      description: t(`${tiers}.openSource.description`),
      price: '$0',
      priceDetail: t(`${tiers}.openSource.priceDetail`),
      features: OPEN_SOURCE_FEATURES.map((key) => t(`${tiers}.openSource.features.${key}`)),
      ctaText: t(`${tiers}.openSource.cta`),
      ctaHref: GITHUB_URL,
    },
    {
      name: t(`${tiers}.pro.name`),
      description: t(`${tiers}.pro.description`),
      price: '$499',
      priceDetail: t(`${tiers}.pro.priceDetail`),
      features: PRO_FEATURES.map((key) => t(`${tiers}.pro.features.${key}`)),
      ctaText: t(`${tiers}.pro.cta`),
      ctaHref: '/contact',
      featured: true,
      badge: t(`${tiers}.pro.badge`),
    },
    {
      name: t(`${tiers}.enterprise.name`),
      description: t(`${tiers}.enterprise.description`),
      price: t(`${tiers}.enterprise.price`),
      features: ENTERPRISE_FEATURES.map((key) => t(`${tiers}.enterprise.features.${key}`)),
      ctaText: t(`${tiers}.enterprise.cta`),
      ctaHref: '/contact',
    },
  ];
}

const FAQ_KEYS = [
  'what',
  'free',
  'technologies',
  'aiOptimized',
  'agents',
  'commercial',
  'support',
] as const;

function faqItems(t: HomeT): FAQItem[] {
  return FAQ_KEYS.map((key) => ({
    question: t(`faq.items.${key}.question`),
    answer: t(`faq.items.${key}.answer`),
  }));
}

/**
 * Landing Page
 *
 * Public landing page showcasing Sunrise features and encouraging adoption.
 * Uses reusable marketing components for consistent styling.
 *
 * **Fork-owned placeholder.** Every fork rewrites or deletes this page, so
 * Sunrise deliberately ships **no test asserting its content** — section ids,
 * copy, pricing tiers and FAQ items are all a fork's to change, and a core test
 * pinning them is a core test a fork cannot satisfy (the #480 / #525 / #530 /
 * #533 class). Do not add one.
 *
 * That leaves one real exposure, and it has bitten: this file was once
 * overwritten wholesale with `about/page.tsx`, and `/` served the About page
 * through a release. Nothing content-shaped could have caught that without
 * becoming a fork's problem, so the guard is structural instead —
 * `tests/unit/app/route-module-distinctness.test.ts` fails when any two route
 * modules under `app/` are byte-identical, which needs no opinion about what
 * this page says.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default async function LandingPage() {
  const t = await getTranslations('marketing.home');

  return (
    <>
      {/* Hero Section */}
      <Hero
        badge={t('hero.badge')}
        title={t('hero.title')}
        description={t('hero.description')}
        primaryAction={{ label: t('hero.primaryAction'), href: '/signup' }}
        secondaryAction={{
          label: t('hero.secondaryAction'),
          href: GITHUB_URL,
          variant: 'outline',
        }}
      />

      {/* Features Section */}
      <Section
        id="features"
        title={t('features.title')}
        description={t('features.description')}
        variant="muted"
      >
        <Features features={features(t)} columns={3} variant="card" />
      </Section>

      {/* How It Works Section */}
      <Section
        id="how-it-works"
        title={t('howItWorks.title')}
        description={t('howItWorks.description')}
      >
        <Features features={howItWorks(t)} columns={3} variant="icon-top" />
      </Section>

      {/* Pricing Section */}
      <Section
        id="pricing"
        title={t('pricing.title')}
        description={t('pricing.description')}
        variant="muted"
      >
        <Pricing tiers={pricingTiers(t)} />
      </Section>

      {/* FAQ Section */}
      <Section id="faq" title={t('faq.title')} description={t('faq.description')}>
        <FAQ items={faqItems(t)} />
      </Section>

      {/* CTA Section */}
      <CTA
        title={t('cta.title')}
        description={t('cta.description')}
        primaryAction={{ label: t('cta.primaryAction'), href: '/signup' }}
        secondaryAction={{
          label: t('cta.secondaryAction'),
          href: GITHUB_URL,
          variant: 'outline',
        }}
        variant="gradient"
        className="border-t"
      />
    </>
  );
}
