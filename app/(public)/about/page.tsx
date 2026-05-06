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

const aboutDescription =
  'Learn about Sunrise, a production-ready Next.js starter template designed for rapid application development with AI assistance — including a complete AI agent orchestration layer.';

export const metadata: Metadata = {
  title: 'About',
  description: aboutDescription,
  openGraph: {
    title: 'About - Sunrise',
    description: aboutDescription,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About - Sunrise',
    description: aboutDescription,
  },
};

const principles = [
  {
    icon: Rocket,
    title: 'Production-Ready',
    description: 'Every feature is battle-tested and ready for production deployment from day one.',
  },
  {
    icon: Brain,
    title: 'AI-Optimized',
    description:
      'Comprehensive documentation and clear patterns enable AI assistants to generate high-quality code.',
  },
  {
    icon: Bot,
    title: 'Agent-Ready',
    description:
      'Full agent orchestration built in: providers, agents, capabilities, workflows, knowledge bases.',
  },
  {
    icon: Network,
    title: 'API-First',
    description:
      'Every action is accessible via versioned APIs, an MCP server, and agent capabilities — ready for integrations.',
  },
  {
    icon: Package,
    title: 'Docker-First',
    description:
      'Multi-stage Docker builds ensure consistent, portable deployments across any environment.',
  },
  {
    icon: BookOpen,
    title: 'Well-Documented',
    description:
      'Detailed guides for every domain help developers and AI assistants understand the codebase.',
  },
];

const techStack = [
  { name: 'Next.js 16', category: 'Framework', icon: Code },
  { name: 'TypeScript', category: 'Language', icon: Code },
  { name: 'PostgreSQL', category: 'Database', icon: Database },
  { name: 'Prisma', category: 'ORM', icon: Database },
  { name: 'pgvector', category: 'Vector Search', icon: Search },
  { name: 'better-auth', category: 'Authentication', icon: Shield },
  { name: 'Tailwind CSS', category: 'Styling', icon: Paintbrush },
  { name: 'shadcn/ui', category: 'Components', icon: Paintbrush },
  { name: 'React Email', category: 'Email', icon: Mail },
  { name: 'Agent Orchestration', category: 'AI', icon: Brain },
  { name: 'MCP Server', category: 'AI', icon: Network },
  { name: 'Docker', category: 'Deployment', icon: Package },
  { name: 'Sentry', category: 'Monitoring', icon: Shield },
];

/**
 * About Page
 *
 * Tells the story of Sunrise: mission, values, and technology stack.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export default function AboutPage() {
  return (
    <>
      {/* Hero Section */}
      <Hero
        title="About Sunrise"
        description="A production-ready Next.js starter template built to help developers ship faster while maintaining high standards for code quality, security, and maintainability — including a complete AI agent orchestration layer."
        variant="centered"
        className="py-12 md:py-16"
      />

      {/* Mission Section */}
      <Section variant="muted">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-6 text-3xl font-bold tracking-tight">Our Mission</h2>
          <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
            Modern web development involves countless decisions — frameworks, authentication,
            databases, deployment, testing, and more. Each choice requires research, implementation,
            and debugging. This takes time away from building the features that matter most.
          </p>
          <p className="text-muted-foreground mb-6 text-lg leading-relaxed">
            <strong className="text-foreground">Sunrise solves this problem</strong> by providing a
            complete, production-ready foundation. We&apos;ve made the hard decisions, implemented
            best practices, and documented everything thoroughly. You get a head start measured in
            weeks, not hours.
          </p>
          <p className="text-muted-foreground text-lg leading-relaxed">
            And because modern apps increasingly include AI agents, Sunrise ships with a complete
            orchestration layer too: providers, agents, capabilities, workflows, knowledge bases,
            and observability. The boring stuff done well — plus the modern agentic primitives so
            your app can include AI agents from day one.
          </p>
        </div>
      </Section>

      {/* Principles Section */}
      <Section
        title="Design Principles"
        description="The guiding principles that shape every decision in Sunrise."
      >
        <Features features={principles} columns={3} variant="card" />
      </Section>

      {/* Tech Stack Section */}
      <Section
        title="Technology Stack"
        description="Built with modern, proven technologies that scale."
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
      <Section title="Why Choose Sunrise?" description="What makes Sunrise different.">
        <div className="mx-auto max-w-2xl space-y-4">
          {[
            'Complete authentication system with email/password and OAuth support',
            'Database schema and migrations ready for user management',
            'Transactional email with beautiful React templates',
            'Docker configuration for development and production',
            'Comprehensive security: rate limiting, CORS, CSP, input sanitization',
            'Structured logging with environment-aware output',
            'Error monitoring with Sentry integration',
            'AI-friendly documentation in CLAUDE.md and .context/ substrate',
            'AI agent orchestration: providers, agents, capabilities, workflows',
            'Knowledge base with document ingestion and pgvector semantic search',
            'MCP server for Claude Code integration and AI-assisted development',
            'MIT licensed for commercial and personal use',
          ].map((item) => (
            <div key={item} className="flex items-start gap-3">
              <CheckCircle2 className="text-primary mt-0.5 h-5 w-5 shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* CTA Section */}
      <CTA
        title="Ready to Get Started?"
        description="Join developers building production applications faster with Sunrise."
        primaryAction={{ label: 'Start Building', href: '/signup' }}
        secondaryAction={{
          label: 'View Source',
          href: 'https://github.com/human-centric-engineering/sunrise',
          variant: 'outline',
        }}
        variant="gradient"
        className="border-t"
      />
    </>
  );
}
