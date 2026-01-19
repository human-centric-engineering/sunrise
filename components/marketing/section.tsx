import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const sectionVariants = cva('py-16 md:py-24', {
  variants: {
    variant: {
      default: 'bg-background',
      muted: 'bg-muted/50',
    },
    size: {
      default: '',
      sm: 'py-12 md:py-16',
      lg: 'py-20 md:py-32',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

const headerAlignVariants = cva('mb-12 max-w-3xl', {
  variants: {
    align: {
      left: '',
      center: 'mx-auto text-center',
    },
  },
  defaultVariants: {
    align: 'center',
  },
});

export interface SectionProps
  extends React.HTMLAttributes<HTMLElement>, VariantProps<typeof sectionVariants> {
  /** Section HTML id for anchor links */
  id?: string;
  /** Section title */
  title?: string;
  /** Section description */
  description?: string;
  /** Header alignment */
  align?: 'left' | 'center';
}

/**
 * Marketing Section Wrapper
 *
 * Provides consistent section styling with optional title and description.
 * Supports background variants for alternating sections.
 *
 * @example
 * <Section title="Features" description="Everything you need">
 *   <FeatureGrid />
 * </Section>
 */
export function Section({
  id,
  title,
  description,
  align = 'center',
  variant,
  size,
  className,
  children,
  ...props
}: SectionProps) {
  return (
    <section id={id} className={cn(sectionVariants({ variant, size }), className)} {...props}>
      <div className="container mx-auto px-4">
        {(title || description) && (
          <div className={headerAlignVariants({ align })}>
            {title && (
              <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">{title}</h2>
            )}
            {description && (
              <p className="text-muted-foreground text-lg md:text-xl">{description}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
