import Link from 'next/link';
import { MessageCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface DiscussPatternButtonProps {
  patternNumber: number;
}

export function DiscussPatternButton({ patternNumber }: DiscussPatternButtonProps) {
  const href = `/admin/orchestration/learn?tab=advisor&contextType=pattern&contextId=${patternNumber}`;

  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>
        <MessageCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Discuss this pattern
      </Link>
    </Button>
  );
}
