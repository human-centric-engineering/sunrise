import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import Link from 'next/link';

const ctaVariants = cva('py-12 md:py-16', {
  variants: {
    variant: {
      default: '',
      gradient: 'bg-gradient-to-br from-primary/10 via-background to-secondary/10',
      card: '',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export interface CTAAction {
  /** Button text */
  label: string;
  /** Link URL */
  href: string;
  /** Button variant */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
}

export interface CTAProps extends VariantProps<typeof ctaVariants> {
  /** Main headline */
  title: string;
  /** Supporting description */
  description: string;
  /** Primary call-to-action */
  primaryAction: CTAAction;
  /** Optional secondary call-to-action */
  secondaryAction?: CTAAction;
  /** Additional className */
  className?: string;
}

/**
 * CTA Component
 *
 * Call-to-action banner for encouraging user action.
 * Supports multiple visual variants.
 *
 * @example
 * <CTA
 *   title="Ready to get started?"
 *   description="Start building your next project today."
 *   primaryAction={{ label: "Get Started", href: "/signup" }}
 *   variant="gradient"
 * />
 */
export function CTA({
  title,
  description,
  primaryAction,
  secondaryAction,
  variant = 'default',
  className,
}: CTAProps) {
  const content = (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">{title}</h2>
      <p className="text-muted-foreground mb-8 text-lg">{description}</p>
      <div className="flex flex-wrap justify-center gap-4">
        <Button asChild size="lg">
          <Link href={primaryAction.href}>{primaryAction.label}</Link>
        </Button>
        {secondaryAction && (
          <Button asChild variant={secondaryAction.variant || 'outline'} size="lg">
            <Link href={secondaryAction.href}>{secondaryAction.label}</Link>
          </Button>
        )}
      </div>
    </div>
  );

  if (variant === 'card') {
    return <Card className={cn('p-8 md:p-12', className)}>{content}</Card>;
  }

  return (
    <div className={cn(ctaVariants({ variant }), className)}>
      <div className="container mx-auto px-4">{content}</div>
    </div>
  );
}
