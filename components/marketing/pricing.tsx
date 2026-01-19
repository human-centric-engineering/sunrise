import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Check } from 'lucide-react';
import Link from 'next/link';

export interface PricingFeature {
  /** Feature text */
  text: string;
  /** Whether feature is included */
  included?: boolean;
}

export interface PricingTier {
  /** Tier name */
  name: string;
  /** Tier description */
  description: string;
  /** Price display (e.g., "$0", "$99/mo", "Custom") */
  price: string;
  /** Price details (e.g., "per month", "one-time") */
  priceDetail?: string;
  /** List of features */
  features: (string | PricingFeature)[];
  /** CTA button text */
  ctaText: string;
  /** CTA button link */
  ctaHref: string;
  /** Whether this is the featured/highlighted tier */
  featured?: boolean;
  /** Optional badge text (e.g., "Popular", "Best Value") */
  badge?: string;
}

export interface PricingProps {
  /** Array of pricing tiers */
  tiers: PricingTier[];
  /** Additional className */
  className?: string;
}

/**
 * Pricing Component
 *
 * Display pricing tiers with feature lists and CTAs.
 * Supports highlighting a featured tier.
 *
 * @example
 * <Pricing
 *   tiers={[
 *     {
 *       name: "Free",
 *       description: "For individuals",
 *       price: "$0",
 *       features: ["Basic features", "Community support"],
 *       ctaText: "Get Started",
 *       ctaHref: "/signup",
 *     },
 *     {
 *       name: "Pro",
 *       description: "For teams",
 *       price: "$49",
 *       priceDetail: "per month",
 *       features: ["All features", "Priority support"],
 *       ctaText: "Start Trial",
 *       ctaHref: "/signup?plan=pro",
 *       featured: true,
 *       badge: "Popular",
 *     },
 *   ]}
 * />
 */
export function Pricing({ tiers, className }: PricingProps) {
  return (
    <div
      className={cn(
        'grid gap-6 md:grid-cols-2 lg:gap-8',
        tiers.length === 3 && 'lg:grid-cols-3',
        className
      )}
    >
      {tiers.map((tier) => (
        <PricingCard key={tier.name} tier={tier} />
      ))}
    </div>
  );
}

interface PricingCardProps {
  tier: PricingTier;
}

function PricingCard({ tier }: PricingCardProps) {
  return (
    <Card className={cn('relative flex flex-col', tier.featured && 'border-primary shadow-lg')}>
      {tier.badge && (
        <div className="bg-primary text-primary-foreground absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-sm font-medium">
          {tier.badge}
        </div>
      )}
      <CardHeader className={cn(tier.badge && 'pt-8')}>
        <CardTitle>{tier.name}</CardTitle>
        <CardDescription>{tier.description}</CardDescription>
        <div className="mt-4">
          <span className="text-4xl font-bold">{tier.price}</span>
          {tier.priceDetail && (
            <span className="text-muted-foreground ml-1">{tier.priceDetail}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <ul className="space-y-3">
          {tier.features.map((feature, index) => {
            const text = typeof feature === 'string' ? feature : feature.text;
            const included = typeof feature === 'string' ? true : feature.included !== false;

            return (
              <li key={index} className="flex items-start gap-3">
                <Check
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    included ? 'text-primary' : 'text-muted-foreground/50'
                  )}
                />
                <span className={cn(!included && 'text-muted-foreground/50 line-through')}>
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
      <CardFooter>
        <Button asChild className="w-full" variant={tier.featured ? 'default' : 'outline'}>
          <Link href={tier.ctaHref}>{tier.ctaText}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
