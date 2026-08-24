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
import { BRAND } from '@/lib/brand';

// Placeholder copy, like the rest of this page — you are expected to rewrite or
// delete it. It reads `BRAND.name` rather than naming the product, so a fork
// that has set `appBrandName` in lib/app/brand.ts but not yet rewritten this
// file still advertises itself rather than Sunrise (#519). A full sentence rather than
// `BRAND.description`, whose fallback is the bare product name: that is the
// right trade for the root layout and the wrong one here, where this string is
// the search-result snippet and the shared-link card.
const homeDescription = `Build production-ready applications faster with ${BRAND.name}.`;

export const metadata: Metadata = {
  // `(public)/layout.tsx` supplies the template `%s - ${BRAND.name}`, so this
  // declares the bare segment and the brand is appended once. The cards below
  // set no title of their own, so Next copies the resolved "Home - <brand>"
  // into both — one string to keep correct rather than three.
  title: 'Home',
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

const features = [
  {
    icon: Zap,
    title: 'Next.js 16',
    description:
      'Built with the latest App Router and React Server Components for optimal performance.',
  },
  {
    icon: FileCode,
    title: 'TypeScript',
    description: 'Full type safety with strict mode enabled throughout the entire codebase.',
  },
  {
    icon: Shield,
    title: 'Authentication',
    description:
      'Secure authentication with better-auth, supporting email/password and OAuth providers.',
  },
  {
    icon: Database,
    title: 'PostgreSQL + Prisma',
    description: 'Production-ready database setup with Prisma ORM for type-safe data access.',
  },
  {
    icon: Mail,
    title: 'Email System',
    description: 'Transactional email support with React Email templates and Resend integration.',
  },
  {
    icon: Package,
    title: 'Docker-Ready',
    description: 'Multi-stage Docker builds for optimized production deployments anywhere.',
  },
  {
    icon: Brain,
    title: 'Agent Orchestration',
    description:
      'Design, deploy, and monitor AI agents with capabilities, workflows, and provider fallback — all admin-configured.',
  },
  {
    icon: Search,
    title: 'Knowledge Base & RAG',
    description:
      'Upload documents, chunk, embed (pgvector), and let agents answer grounded questions via semantic search.',
  },
];

const howItWorks = [
  {
    icon: Code,
    title: 'Fork & Clone',
    description: 'Start by forking the repository and cloning it to your local machine.',
  },
  {
    icon: Settings,
    title: 'Configure',
    description: 'Set up your environment variables and customize to your needs.',
  },
  {
    icon: Rocket,
    title: 'Deploy',
    description: 'Deploy with Docker, Vercel, or your preferred platform.',
  },
];

const pricingTiers = [
  {
    name: 'Open Source',
    description: 'Free forever for everyone',
    price: '$0',
    priceDetail: 'forever',
    features: [
      'Full source code access',
      'All core features included',
      'MIT License',
      'Community support via GitHub',
      'Regular updates',
    ],
    ctaText: 'Get Started',
    ctaHref: 'https://github.com/human-centric-engineering/sunrise',
  },
  {
    name: 'Pro Support',
    description: 'For teams that need extra help',
    price: '$499',
    priceDetail: 'one-time',
    features: [
      'Everything in Open Source',
      '3 months email support',
      'Priority bug fixes',
      'Architecture review session',
      'Custom feature guidance',
    ],
    ctaText: 'Contact Us',
    ctaHref: '/contact',
    featured: true,
    badge: 'Popular',
  },
  {
    name: 'Enterprise',
    description: 'For large-scale deployments',
    price: 'Custom',
    features: [
      'Everything in Pro Support',
      'Dedicated support channel',
      'Custom feature development',
      'On-boarding assistance',
      'SLA guarantee',
    ],
    ctaText: 'Contact Sales',
    ctaHref: '/contact',
  },
];

const faqItems = [
  {
    question: 'What is Sunrise?',
    answer:
      'Sunrise is a production-ready Next.js starter template designed for rapid application development. It includes authentication, database setup, email integration, Docker deployment, and follows best practices for AI-assisted development.',
  },
  {
    question: 'Is Sunrise really free?',
    answer:
      'Yes! Sunrise is open source under the MIT License. You can use it for personal and commercial projects without any restrictions. We offer paid support packages for teams that want additional assistance.',
  },
  {
    question: 'What technologies does Sunrise use?',
    answer:
      'Sunrise is built with Next.js 16, TypeScript, PostgreSQL with Prisma ORM, better-auth for authentication, Tailwind CSS with shadcn/ui components, React Email with Resend, and Docker for deployment.',
  },
  {
    question: 'How is Sunrise optimized for AI development?',
    answer:
      'Two ways. First, AI-assisted development: comprehensive documentation in CLAUDE.md and the .context/ substrate helps AI assistants understand the codebase and follow established patterns when generating code. Second, AI agent capabilities for the apps you build: a complete orchestration layer for designing, deploying, and monitoring AI agents.',
  },
  {
    question: 'Can I build AI agents with Sunrise?',
    answer:
      'Yes. Sunrise ships with a full agent orchestration layer at /admin/orchestration: configure LLM providers, define agents with system instructions and budgets, create custom capabilities (tools), build multi-step workflows as DAGs, ingest documents into pgvector-backed knowledge bases for RAG, expose agents via an MCP server or embed widget, and monitor everything with execution tracing, evaluations, and an audit log. Built on the 21 agentic design patterns from Antonio Gullí.',
  },
  {
    question: 'Can I use Sunrise for commercial projects?',
    answer:
      'Absolutely! Sunrise is released under the MIT License, which allows commercial use, modification, and distribution. You just need to include the original license in any copies of the software.',
  },
  {
    question: 'How do I get support?',
    answer:
      'For free support, you can open issues on GitHub or participate in community discussions. For priority support, architecture reviews, or custom development, check out our Pro Support and Enterprise packages.',
  },
];

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
export default function LandingPage() {
  return (
    <>
      {/* Hero Section */}
      <Hero
        badge="Next.js 16 Ready"
        title="Build Production Apps Faster"
        description="Sunrise is a production-ready Next.js starter template designed for rapid application development. Authentication, database, email, Docker — all pre-configured and ready to go, plus a production AI agent orchestration layer for building agents, workflows, and knowledge bases."
        primaryAction={{ label: 'Get Started', href: '/signup' }}
        secondaryAction={{
          label: 'View on GitHub',
          href: 'https://github.com/human-centric-engineering/sunrise',
          variant: 'outline',
        }}
      />

      {/* Features Section */}
      <Section
        id="features"
        title="Everything You Need"
        description="Sunrise comes with all the essential features pre-configured so you can focus on building your application."
        variant="muted"
      >
        <Features features={features} columns={3} variant="card" />
      </Section>

      {/* How It Works Section */}
      <Section
        id="how-it-works"
        title="Get Started in Minutes"
        description="Three simple steps to go from zero to production-ready."
      >
        <Features features={howItWorks} columns={3} variant="icon-top" />
      </Section>

      {/* Pricing Section */}
      <Section
        id="pricing"
        title="Simple, Transparent Pricing"
        description="Start for free with open source. Upgrade for priority support and custom development."
        variant="muted"
      >
        <Pricing tiers={pricingTiers} />
      </Section>

      {/* FAQ Section */}
      <Section
        id="faq"
        title="Frequently Asked Questions"
        description="Got questions? We have answers."
      >
        <FAQ items={faqItems} />
      </Section>

      {/* CTA Section */}
      <CTA
        title="Ready to Build Something Great?"
        description="Join developers who are building production applications faster with Sunrise."
        primaryAction={{ label: 'Get Started Free', href: '/signup' }}
        secondaryAction={{
          label: 'View Documentation',
          href: 'https://github.com/human-centric-engineering/sunrise',
          variant: 'outline',
        }}
        variant="gradient"
        className="border-t"
      />
    </>
  );
}
