'use client';

import { useRouter } from 'next/navigation';
import { ChevronDown, Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { STEP_REGISTRY, type StepRegistryEntry } from '@/lib/orchestration/engine/step-registry';
import type { WorkflowDefinition } from '@/types/orchestration';

interface UsePatternButtonProps {
  patternNumber: number;
}

function buildDefinitionUrl(entry: StepRegistryEntry): string {
  const definition: WorkflowDefinition = {
    steps: [
      {
        id: 'step-1',
        name: entry.label,
        type: entry.type,
        config: { ...entry.defaultConfig },
        nextSteps: [],
      },
    ],
    entryStepId: 'step-1',
    errorStrategy: 'fail',
  };
  return `/admin/orchestration/workflows/new?definition=${encodeURIComponent(JSON.stringify(definition))}`;
}

export function UsePatternButton({ patternNumber }: UsePatternButtonProps) {
  const router = useRouter();
  const entries = STEP_REGISTRY.filter((e) => e.patternNumber === patternNumber);

  if (entries.length === 0) return null;

  if (entries.length === 1) {
    const entry = entries[0];
    return (
      <Button size="sm" onClick={() => router.push(buildDefinitionUrl(entry))}>
        <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Use this pattern
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Use this pattern
          <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {entries.map((entry) => (
          <DropdownMenuItem key={entry.type} onClick={() => router.push(buildDefinitionUrl(entry))}>
            <entry.icon className="mr-2 h-4 w-4" aria-hidden="true" />
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
