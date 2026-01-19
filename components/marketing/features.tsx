import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';

const featuresGridVariants = cva('grid gap-6', {
  variants: {
    columns: {
      2: 'md:grid-cols-2',
      3: 'md:grid-cols-2 lg:grid-cols-3',
      4: 'md:grid-cols-2 lg:grid-cols-4',
    },
  },
  defaultVariants: {
    columns: 3,
  },
});

const featureCardVariants = cva('', {
  variants: {
    variant: {
      card: '',
      minimal: 'border-none shadow-none bg-transparent',
      'icon-top': 'text-center',
    },
  },
  defaultVariants: {
    variant: 'card',
  },
});

export interface Feature {
  /** Feature icon component */
  icon: LucideIcon;
  /** Feature title */
  title: string;
  /** Feature description */
  description: string;
}

export interface FeaturesProps extends VariantProps<typeof featuresGridVariants> {
  /** Array of features to display */
  features: Feature[];
  /** Card style variant */
  variant?: 'card' | 'minimal' | 'icon-top';
  /** Additional className */
  className?: string;
}

/**
 * Features Component
 *
 * Grid of feature cards with icons for showcasing product capabilities.
 *
 * @example
 * <Features
 *   features={[
 *     { icon: Zap, title: "Fast", description: "Lightning quick" },
 *     { icon: Shield, title: "Secure", description: "Enterprise security" },
 *   ]}
 *   columns={3}
 *   variant="card"
 * />
 */
export function Features({ features, columns, variant = 'card', className }: FeaturesProps) {
  return (
    <div className={cn(featuresGridVariants({ columns }), className)}>
      {features.map((feature) => (
        <FeatureCard key={feature.title} feature={feature} variant={variant} />
      ))}
    </div>
  );
}

interface FeatureCardProps {
  feature: Feature;
  variant: 'card' | 'minimal' | 'icon-top';
}

function FeatureCard({ feature, variant }: FeatureCardProps) {
  const Icon = feature.icon;
  const isIconTop = variant === 'icon-top';

  return (
    <Card className={cn(featureCardVariants({ variant }))}>
      <CardHeader className={cn(isIconTop && 'items-center')}>
        <div
          className={cn(
            'bg-primary/10 text-primary mb-3 flex h-10 w-10 items-center justify-center rounded-lg',
            isIconTop && 'mx-auto'
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <CardTitle className="text-lg">{feature.title}</CardTitle>
        <CardDescription>{feature.description}</CardDescription>
      </CardHeader>
      {variant === 'card' && <CardContent />}
    </Card>
  );
}
