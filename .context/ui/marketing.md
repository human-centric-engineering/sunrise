# Marketing Components

## Overview

Sunrise includes a library of marketing components for building landing pages and promotional content. These components are composable, responsive, and follow shadcn/ui patterns.

## Component Library

| Component  | Purpose                                     | File                                |
| ---------- | ------------------------------------------- | ----------------------------------- |
| `Hero`     | Eye-catching hero sections                  | `components/marketing/hero.tsx`     |
| `Features` | Feature grid with icons                     | `components/marketing/features.tsx` |
| `Pricing`  | Pricing tier cards                          | `components/marketing/pricing.tsx`  |
| `FAQ`      | Accordion-based FAQ section                 | `components/marketing/faq.tsx`      |
| `CTA`      | Call-to-action banners                      | `components/marketing/cta.tsx`      |
| `Section`  | Wrapper with consistent spacing and headers | `components/marketing/section.tsx`  |

Import all components from the barrel export:

```tsx
import { Hero, Features, Pricing, FAQ, CTA, Section } from '@/components/marketing';
```

## Hero Component

Eye-catching hero section for landing pages.

```tsx
<Hero
  badge="New Release"
  title="Build faster with Sunrise"
  description="Production-ready Next.js starter template for rapid development."
  primaryAction={{ label: 'Get Started', href: '/signup' }}
  secondaryAction={{ label: 'Learn More', href: '/about', variant: 'outline' }}
  variant="centered" // or "split"
/>
```

**Props:**

| Prop              | Type                      | Description                          |
| ----------------- | ------------------------- | ------------------------------------ |
| `badge`           | `string`                  | Optional badge text above title      |
| `title`           | `string`                  | Main headline (required)             |
| `description`     | `string`                  | Supporting text (required)           |
| `primaryAction`   | `HeroAction`              | Primary CTA button                   |
| `secondaryAction` | `HeroAction`              | Secondary CTA button                 |
| `variant`         | `"centered"` \| `"split"` | Layout variant (default: "centered") |
| `children`        | `ReactNode`               | Right-side content for split variant |

**Variants:**

- `centered` - Centered text layout (default)
- `split` - Two-column layout with children on the right

## Features Component

Grid of feature cards with icons.

```tsx
import { Zap, Shield, Gauge, Lock } from 'lucide-react';

<Features
  features={[
    { icon: Zap, title: 'Fast', description: 'Lightning-quick performance' },
    { icon: Shield, title: 'Secure', description: 'Enterprise-grade security' },
    { icon: Gauge, title: 'Optimized', description: 'Production-ready defaults' },
    { icon: Lock, title: 'Private', description: 'Your data stays yours' },
  ]}
  columns={4} // 2, 3, or 4
  variant="card" // "card", "minimal", or "icon-top"
/>;
```

**Props:**

| Prop       | Type                                    | Description                  |
| ---------- | --------------------------------------- | ---------------------------- |
| `features` | `Feature[]`                             | Array of features (required) |
| `columns`  | `2` \| `3` \| `4`                       | Grid columns (default: 3)    |
| `variant`  | `"card"` \| `"minimal"` \| `"icon-top"` | Card style (default: "card") |

**Variants:**

- `card` - Full card with shadow and border
- `minimal` - No border or shadow
- `icon-top` - Centered icon above title

## Pricing Component

Display pricing tiers with feature lists.

```tsx
<Pricing
  tiers={[
    {
      name: 'Free',
      description: 'For individuals getting started',
      price: '$0',
      features: ['5 projects', 'Basic analytics', 'Community support'],
      ctaText: 'Get Started',
      ctaHref: '/signup',
    },
    {
      name: 'Pro',
      description: 'For growing teams',
      price: '$49',
      priceDetail: 'per month',
      features: [
        'Unlimited projects',
        'Advanced analytics',
        'Priority support',
        { text: 'Custom integrations', included: true },
      ],
      ctaText: 'Start Free Trial',
      ctaHref: '/signup?plan=pro',
      featured: true,
      badge: 'Popular',
    },
  ]}
/>
```

**PricingTier Props:**

| Prop          | Type                           | Description                      |
| ------------- | ------------------------------ | -------------------------------- |
| `name`        | `string`                       | Tier name (required)             |
| `description` | `string`                       | Tier description (required)      |
| `price`       | `string`                       | Price display (required)         |
| `priceDetail` | `string`                       | Price period (e.g., "per month") |
| `features`    | `(string \| PricingFeature)[]` | Feature list (required)          |
| `ctaText`     | `string`                       | Button text (required)           |
| `ctaHref`     | `string`                       | Button link (required)           |
| `featured`    | `boolean`                      | Highlight this tier              |
| `badge`       | `string`                       | Badge text (e.g., "Popular")     |

## FAQ Component

Accordion-based FAQ section.

```tsx
<FAQ
  items={[
    {
      question: 'What is Sunrise?',
      answer: 'Sunrise is a production-ready Next.js starter template.',
    },
    {
      question: 'Is it free to use?',
      answer: 'Yes, Sunrise is open source and free for personal and commercial use.',
    },
  ]}
  maxWidth="2xl" // "sm", "md", "lg", "xl", "2xl", "3xl"
/>
```

**Props:**

| Prop       | Type                                                       | Description                    |
| ---------- | ---------------------------------------------------------- | ------------------------------ |
| `items`    | `FAQItem[]`                                                | Array of Q&A items (required)  |
| `maxWidth` | `"sm"` \| `"md"` \| `"lg"` \| `"xl"` \| `"2xl"` \| `"3xl"` | Maximum width (default: "3xl") |

## CTA Component

Call-to-action banner for encouraging user action.

```tsx
<CTA
  title="Ready to get started?"
  description="Start building your next project with Sunrise today."
  primaryAction={{ label: 'Get Started', href: '/signup' }}
  secondaryAction={{ label: 'Contact Sales', href: '/contact', variant: 'outline' }}
  variant="gradient" // "default", "gradient", or "card"
/>
```

**Props:**

| Prop              | Type                                    | Description                       |
| ----------------- | --------------------------------------- | --------------------------------- |
| `title`           | `string`                                | Headline (required)               |
| `description`     | `string`                                | Supporting text (required)        |
| `primaryAction`   | `CTAAction`                             | Primary button (required)         |
| `secondaryAction` | `CTAAction`                             | Secondary button                  |
| `variant`         | `"default"` \| `"gradient"` \| `"card"` | Visual style (default: "default") |

**Variants:**

- `default` - Plain background
- `gradient` - Subtle gradient background
- `card` - Contained in a card

## Section Component

Wrapper component for consistent section styling.

```tsx
<Section
  id="features"
  title="Features"
  description="Everything you need to build fast"
  variant="muted"  // "default" or "muted"
  size="lg"        // "sm", "default", or "lg"
  align="center"   // "left" or "center"
>
  <Features features={...} />
</Section>
```

**Props:**

| Prop          | Type                            | Description                           |
| ------------- | ------------------------------- | ------------------------------------- |
| `id`          | `string`                        | HTML id for anchor links              |
| `title`       | `string`                        | Section title                         |
| `description` | `string`                        | Section description                   |
| `variant`     | `"default"` \| `"muted"`        | Background style (default: "default") |
| `size`        | `"sm"` \| `"default"` \| `"lg"` | Padding size (default: "default")     |
| `align`       | `"left"` \| `"center"`          | Header alignment (default: "center")  |

## Building a Landing Page

Example composition for a complete landing page:

```tsx
import { Hero, Section, Features, Pricing, FAQ, CTA } from '@/components/marketing';
import { Zap, Shield, Gauge, Users } from 'lucide-react';

export default function LandingPage() {
  return (
    <>
      <Hero
        badge="v1.0 Released"
        title="Build faster with Sunrise"
        description="The production-ready Next.js starter."
        primaryAction={{ label: 'Get Started', href: '/signup' }}
        secondaryAction={{ label: 'View Demo', href: '/demo' }}
      />

      <Section id="features" title="Features" variant="muted">
        <Features
          features={[
            { icon: Zap, title: 'Fast', description: 'Optimized performance' },
            { icon: Shield, title: 'Secure', description: 'Built-in security' },
            { icon: Gauge, title: 'Modern', description: 'Latest tech stack' },
            { icon: Users, title: 'Team Ready', description: 'Multi-user support' },
          ]}
          columns={4}
        />
      </Section>

      <Section id="pricing" title="Pricing" description="Simple, transparent pricing">
        <Pricing tiers={pricingTiers} />
      </Section>

      <Section id="faq" title="FAQ" variant="muted">
        <FAQ items={faqItems} />
      </Section>

      <CTA
        title="Ready to start?"
        description="Join thousands of developers."
        primaryAction={{ label: 'Sign Up Free', href: '/signup' }}
        variant="gradient"
      />
    </>
  );
}
```

## Footer Components

The project includes two footer components:

| Component         | Location                                  | Use For                       |
| ----------------- | ----------------------------------------- | ----------------------------- |
| `PublicFooter`    | `components/layouts/public-footer.tsx`    | Public pages (landing, about) |
| `ProtectedFooter` | `components/layouts/protected-footer.tsx` | Protected pages (dashboard)   |

Both footers include a "Manage Cookies" link that opens the cookie preferences modal.

## Related Documentation

- [UI Patterns Overview](./overview.md) - URL-persistent tabs and other patterns
- [Architecture Patterns](../architecture/patterns.md) - Component organization
