---
name: component-builder
version: 1.0.0
description: |
  Expert component builder for Sunrise. Creates reusable React components following
  shadcn/ui patterns with proper TypeScript interfaces, accessibility, and styling.
  Use when creating new components or refactoring existing ones.

triggers:
  - 'create component'
  - 'build a reusable'
  - 'add hero section'
  - 'create marketing component'
  - 'build pricing table'
  - 'new component for'

contexts:
  - 'components/**/*.tsx'
  - 'components/ui/**/*'
  - '.context/guidelines.md'

mcp_integrations:
  context7:
    libraries:
      - { shadcn: '/websites/ui_shadcn' }
      - { tailwindcss: '/websites/tailwindcss' }
---

# Component Builder Skill - Overview

## Mission

You are a component builder for the Sunrise project. Your role is to create reusable React components following **shadcn/ui patterns**, with proper TypeScript interfaces, accessibility attributes, and Tailwind CSS styling.

**CRITICAL:** Always check if a shadcn/ui base component exists before creating from scratch.

## Component Organization

### Directory Structure

```
components/
├── ui/                    # shadcn/ui components (auto-generated + custom)
│   ├── button.tsx         # Base UI primitives
│   ├── card.tsx
│   ├── input.tsx
│   └── ...
├── forms/                 # Form-related components
│   ├── login-form.tsx
│   ├── form-error.tsx
│   └── ...
├── layouts/               # Layout components
│   ├── header.tsx
│   ├── footer.tsx
│   └── ...
├── marketing/             # Marketing page components
│   ├── hero.tsx
│   ├── features.tsx
│   ├── pricing.tsx
│   └── ...
├── auth/                  # Auth-related UI
│   └── logout-button.tsx
└── shared/                # Shared utility components
    └── loading-spinner.tsx
```

### Placement Rules

| Component Type     | Directory    | Examples                     |
| ------------------ | ------------ | ---------------------------- |
| Base primitives    | `ui/`        | Button, Input, Card          |
| Form components    | `forms/`     | LoginForm, FormError         |
| Auth UI            | `auth/`      | LogoutButton                 |
| Marketing sections | `marketing/` | Hero, Features, Pricing      |
| Page layouts       | `layouts/`   | Header, Footer, Sidebar      |
| Shared utilities   | `shared/`    | LoadingSpinner, ErrorMessage |

## 4-Step Workflow

### Step 1: Check for Existing Components

**Before creating, check if shadcn/ui has the component:**

```bash
# Check available components
npx shadcn@latest add --help

# Add a component
npx shadcn@latest add [component-name]
```

**Common shadcn/ui components:**

- `button`, `input`, `label`, `textarea`
- `card`, `dialog`, `sheet`, `drawer`
- `select`, `checkbox`, `radio-group`, `switch`
- `tabs`, `accordion`, `collapsible`
- `alert`, `badge`, `avatar`
- `table`, `pagination`
- `form` (with react-hook-form integration)

### Step 2: Design Component Interface

**TypeScript interface pattern:**

```typescript
interface ComponentProps {
  /** Required prop with description */
  title: string;
  /** Optional prop with default */
  variant?: 'default' | 'outline' | 'ghost';
  /** Children for composition */
  children?: React.ReactNode;
  /** Additional class names */
  className?: string;
}
```

### Step 3: Create Component

**Server Component (default):**

```typescript
import { cn } from '@/lib/utils';

interface FeatureCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  className?: string;
}

export function FeatureCard({
  title,
  description,
  icon,
  className,
}: FeatureCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-6 text-card-foreground shadow-sm',
        className
      )}
    >
      <div className="mb-4 text-primary">{icon}</div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}
```

**Client Component (for interactivity):**

```typescript
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface CounterProps {
  initialValue?: number;
}

export function Counter({ initialValue = 0 }: CounterProps) {
  const [count, setCount] = useState(initialValue);

  return (
    <div className="flex items-center gap-4">
      <Button onClick={() => setCount((c) => c - 1)}>-</Button>
      <span className="text-xl font-bold">{count}</span>
      <Button onClick={() => setCount((c) => c + 1)}>+</Button>
    </div>
  );
}
```

### Step 4: Add Accessibility

**Required accessibility attributes:**

```typescript
// Buttons
<button
  type="button"
  aria-label="Close dialog"
  aria-pressed={isPressed}
>

// Images
<img alt="Descriptive text" />

// Icons (decorative)
<Icon aria-hidden="true" />

// Icons (meaningful)
<Icon role="img" aria-label="Warning" />

// Links
<a href="/page" aria-current={isCurrentPage ? 'page' : undefined}>

// Form fields
<input
  id="email"
  aria-describedby="email-error"
  aria-invalid={hasError}
/>
<span id="email-error" role="alert">{error}</span>
```

## Component Templates

### Marketing Hero Section

```typescript
// components/marketing/hero.tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

interface HeroProps {
  title: string;
  subtitle: string;
  primaryCTA: {
    text: string;
    href: string;
  };
  secondaryCTA?: {
    text: string;
    href: string;
  };
}

export function Hero({ title, subtitle, primaryCTA, secondaryCTA }: HeroProps) {
  return (
    <section className="py-20 text-center md:py-32">
      <div className="container mx-auto px-4">
        <h1 className="mb-6 text-4xl font-bold tracking-tight md:text-6xl">
          {title}
        </h1>
        <p className="text-muted-foreground mx-auto mb-8 max-w-2xl text-xl">
          {subtitle}
        </p>
        <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button asChild size="lg">
            <Link href={primaryCTA.href}>
              {primaryCTA.text}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          {secondaryCTA && (
            <Button asChild variant="outline" size="lg">
              <Link href={secondaryCTA.href}>{secondaryCTA.text}</Link>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
```

### Feature Grid

```typescript
// components/marketing/features.tsx
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface Feature {
  title: string;
  description: string;
  icon: LucideIcon;
}

interface FeaturesProps {
  title: string;
  subtitle?: string;
  features: Feature[];
  columns?: 2 | 3 | 4;
  className?: string;
}

export function Features({
  title,
  subtitle,
  features,
  columns = 3,
  className,
}: FeaturesProps) {
  const gridCols = {
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-2 lg:grid-cols-4',
  };

  return (
    <section className={cn('py-16', className)}>
      <div className="container mx-auto px-4">
        <div className="mb-12 text-center">
          <h2 className="mb-4 text-3xl font-bold">{title}</h2>
          {subtitle && (
            <p className="text-muted-foreground mx-auto max-w-2xl">{subtitle}</p>
          )}
        </div>
        <div className={cn('grid gap-8', gridCols[columns])}>
          {features.map((feature, index) => (
            <div
              key={index}
              className="rounded-lg border bg-card p-6 text-card-foreground"
            >
              <feature.icon className="text-primary mb-4 h-10 w-10" />
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-muted-foreground text-sm">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

### Pricing Table

```typescript
// components/marketing/pricing.tsx
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PricingPlan {
  name: string;
  price: string;
  description: string;
  features: string[];
  cta: string;
  popular?: boolean;
}

interface PricingProps {
  plans: PricingPlan[];
}

export function Pricing({ plans }: PricingProps) {
  return (
    <section className="py-16">
      <div className="container mx-auto px-4">
        <div className="mb-12 text-center">
          <h2 className="mb-4 text-3xl font-bold">Simple, Transparent Pricing</h2>
          <p className="text-muted-foreground">
            Choose the plan that works for you
          </p>
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          {plans.map((plan, index) => (
            <Card
              key={index}
              className={cn(plan.popular && 'border-primary shadow-lg')}
            >
              {plan.popular && (
                <div className="bg-primary text-primary-foreground rounded-t-lg px-4 py-1 text-center text-sm font-medium">
                  Most Popular
                </div>
              )}
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-6">
                  <span className="text-4xl font-bold">{plan.price}</span>
                  <span className="text-muted-foreground">/month</span>
                </div>
                <ul className="space-y-3">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <Check className="text-primary h-4 w-4" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button
                  className="w-full"
                  variant={plan.popular ? 'default' : 'outline'}
                >
                  {plan.cta}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
```

## Common Imports

```typescript
// Styling utility
import { cn } from '@/lib/utils';

// shadcn/ui components
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Icons
import { Check, ArrowRight, Star, Loader2 } from 'lucide-react';

// Next.js
import Link from 'next/link';
import Image from 'next/image';
```

## Verification Checklist

- [ ] Component in correct directory
- [ ] TypeScript interface defined with JSDoc comments
- [ ] Props have sensible defaults where appropriate
- [ ] `className` prop available for customization
- [ ] Uses `cn()` for conditional classes
- [ ] Accessibility attributes added
- [ ] Server component unless interactivity needed
- [ ] Responsive design (mobile-first)
- [ ] Uses design tokens (bg-card, text-primary, etc.)

## Usage Examples

**Create a hero section:**

```
User: "Create a hero section for the landing page"
Assistant: [Creates components/marketing/hero.tsx with title, subtitle, CTAs]
```

**Build pricing table:**

```
User: "Add a pricing component with 3 tiers"
Assistant: [Creates components/marketing/pricing.tsx with plan props]
```

**Create data display card:**

```
User: "Create a stats card showing metrics"
Assistant: [Creates components/shared/stats-card.tsx with title, value, change]
```
