import type { Metadata } from 'next';
import {
  Rocket,
  Brain,
  Package,
  BookOpen,
  Shield,
  Database,
  Mail,
  Paintbrush,
  Code,
  CheckCircle2,
  Bot,
  Network,
  Search,
} from 'lucide-react';
import { Hero, Section, Features, CTA } from '@/components/marketing';
import { Card, CardContent } from '@/components/ui/card';
import { BRAND } from '@/lib/brand';
import { getTranslations } from 'next-intl/server';

// Metadata, not body copy — this feeds `description`, `openGraph` and
// `twitter` and is never rendered on the page, so the fork-owned-copy exemption
// does not apply to it (#519).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.about.meta');
  const aboutDescription = t('description', { brand: BRAND.name });
  const socialTitle = t('socialTitle', { brand: BRAND.name });
  return {
    title: t('title'),
    description: aboutDescription,
    openGraph: {
      title: socialTitle,
      description: aboutDescription,
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description: aboutDescription,
    },
  };
}

const PRINCIPLES = [
  { key: 'productionReady', icon: Rocket },
  { key: 'aiOptimized', icon: Brain },
  { key: 'agentReady', icon: Bot },
  { key: 'apiFirst', icon: Network },
  { key: 'dockerFirst', icon: Package },
  { key: 'wellDocumented', icon: BookOpen },
] as const;

/**
 * Product names stay literal; a `nameKey` marks the two entries that are
 * descriptions rather than names, so they are translated.
 */
const TECH_STACK = [
  { name: 'Next.js 16', category: 'framework', icon: Code },
  { name: 'TypeScript', category: 'language', icon: Code },
  { name: 'PostgreSQL', category: 'database', icon: Database },
  { name: 'Prisma', category: 'orm', icon: Database },
  { name: 'pgvector', category: 'vectorSearch', icon: Search },
  { name: 'better-auth', category: 'authentication', icon: Shield },
  { name: 'Tailwind CSS', category: 'styling', icon: Paintbrush },
  { name: 'shadcn/ui', category: 'components', icon: Paintbrush },
  { name: 'React Email', category: 'email', icon: Mail },
  { nameKey: 'agentOrchestration', category: 'ai', icon: Brain },
  { nameKey: 'mcpServer', category: 'ai', icon: Network },
  { name: 'Docker', category: 'deployment', icon: Package },
  { name: 'Sentry', category: 'monitoring', icon: Shield },
] as const;

const WHY_ITEMS = [
  'auth',
  'database',
  'email',
  'docker',
  'security',
  'logging',
  'monitoring',
  'aiDocs',
  'orchestration',
  'knowledge',
  'mcp',
  'license',
] as const;

/**
 * About Page
 *
 * Tells the story of Sunrise: mission, values, and technology stack.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default async function AboutPage() {
  const t = await getTranslations('marketing.about');
  const principles = PRINCIPLES.map(({ key, icon }) => ({
    icon,
    title: t(`principles.items.${key}.title`),
    description: t(`principles.items.${key}.description`),
  }));
  const techStack = TECH_STACK.map((tech) => ({
    name: 'nameKey' in tech ? t(`techStack.names.${tech.nameKey}`) : tech.name,
    category: t(`techStack.categories.${tech.category}`),
    icon: tech.icon,
  }));

  return (
    <>
      {/* Hero Section */}
      <Hero
        title={t('hero.title')}
        description={t('hero.description')}
        variant="centered"
        className="py-12 md:py-16"
      />

      {/* Mission Section */}
      <Section variant="muted">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-6 text-3xl font-bold tracking-tight">{t('mission.title')}</h2>
          <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
            {t('mission.problem')}
          </p>
          <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
            {t.rich('mission.solution', {
              strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
            })}
          </p>
          <p className="text-muted-foreground text-lg leading-relaxed">{t('mission.agents')}</p>
        </div>
      </Section>

      {/* Principles Section */}
      <Section title={t('principles.title')} description={t('principles.description')}>
        <Features features={principles} columns={3} variant="card" />
      </Section>

      {/* Tech Stack Section */}
      <Section
        title={t('techStack.title')}
        description={t('techStack.description')}
        variant="muted"
      >
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {techStack.map((tech) => {
            const Icon = tech.icon;
            return (
              <Card key={tech.name} className="text-center">
                <CardContent className="pt-6">
                  <div className="bg-primary/10 text-primary mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="font-medium">{tech.name}</div>
                  <div className="text-muted-foreground text-sm">{tech.category}</div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </Section>

      {/* Why Sunrise Section */}
      <Section title={t('why.title')} description={t('why.description')}>
        <div className="mx-auto max-w-2xl space-y-4">
          {WHY_ITEMS.map((key) => (
            <div key={key} className="flex items-start gap-3">
              <CheckCircle2 className="text-primary mt-0.5 h-5 w-5 shrink-0" />
              <span>{t(`why.items.${key}`)}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* CTA Section */}
      <CTA
        title={t('cta.title')}
        description={t('cta.description')}
        primaryAction={{ label: t('cta.primaryAction'), href: '/signup' }}
        secondaryAction={{
          label: t('cta.secondaryAction'),
          href: 'https://github.com/human-centric-engineering/sunrise',
          variant: 'outline',
        }}
        variant="gradient"
        className="border-t"
      />
    </>
  );
}
