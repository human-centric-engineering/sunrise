import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const heroVariants = cva('py-16 md:py-24 lg:py-32', {
  variants: {
    variant: {
      centered: 'text-center',
      split: 'text-left',
    },
  },
  defaultVariants: {
    variant: 'centered',
  },
});

export interface HeroAction {
  /** Button text */
  label: string;
  /** Link URL */
  href: string;
  /** Button variant */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
}

export interface HeroProps extends VariantProps<typeof heroVariants> {
  /** Optional badge text above title */
  badge?: string;
  /** Main headline */
  title: string;
  /** Supporting description */
  description: string;
  /** Primary call-to-action */
  primaryAction?: HeroAction;
  /** Secondary call-to-action */
  secondaryAction?: HeroAction;
  /** Additional className */
  className?: string;
  /** Content to display on the right side (for split variant) */
  children?: React.ReactNode;
}

/**
 * Hero Component
 *
 * Eye-catching hero section for landing and marketing pages.
 * Supports centered and split layout variants.
 *
 * @example
 * <Hero
 *   badge="New Release"
 *   title="Build faster with Sunrise"
 *   description="Production-ready Next.js starter template"
 *   primaryAction={{ label: "Get Started", href: "/signup" }}
 *   secondaryAction={{ label: "Learn More", href: "/about", variant: "outline" }}
 * />
 */
export function Hero({
  badge,
  title,
  description,
  primaryAction,
  secondaryAction,
  variant = 'centered',
  className,
  children,
}: HeroProps) {
  const isSplit = variant === 'split';

  return (
    <section className={cn(heroVariants({ variant }), className)}>
      <div className="container mx-auto px-4">
        <div className={cn(isSplit && 'grid items-center gap-12 lg:grid-cols-2')}>
          <div className={cn(!isSplit && 'mx-auto max-w-3xl')}>
            {badge && (
              <div
                className={cn(
                  'mb-6 inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium',
                  !isSplit && 'mx-auto'
                )}
              >
                {badge}
              </div>
            )}
            <h1 className="mb-6 text-4xl font-bold tracking-tight md:text-5xl lg:text-6xl">
              {title}
            </h1>
            <p className="text-muted-foreground mb-8 text-lg md:text-xl">{description}</p>
            {(primaryAction || secondaryAction) && (
              <div className={cn('flex flex-wrap gap-4', !isSplit && 'justify-center')}>
                {primaryAction && (
                  <Button asChild size="lg">
                    <Link href={primaryAction.href}>{primaryAction.label}</Link>
                  </Button>
                )}
                {secondaryAction && (
                  <Button asChild variant={secondaryAction.variant || 'outline'} size="lg">
                    <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
                  </Button>
                )}
              </div>
            )}
          </div>
          {isSplit && children && <div>{children}</div>}
        </div>
      </div>
    </section>
  );
}
