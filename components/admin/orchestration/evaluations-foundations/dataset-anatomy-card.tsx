/**
 * DatasetAnatomyCard — sidebar guidance for the /datasets/new page.
 *
 * Shows one concrete case from `datasetSamples` with field-by-field
 * annotations, then a short "what makes a good case" note. Mirrors the
 * Evaluation101Card style (accent border, no hard CTA) so the new
 * uploader sees worked examples alongside the form rather than buried
 * under a `<details>` toggle.
 */

import * as React from 'react';
import { FileText } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  datasetHelp,
  datasetSamples,
} from '@/components/admin/orchestration/evaluations-foundations/help-text';

interface FieldRowProps {
  name: string;
  required?: boolean;
  description: string;
  example: string;
}

function FieldRow({ name, required, description, example }: FieldRowProps): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <code className="bg-background rounded px-1 text-xs font-medium">{name}</code>
        {required ? (
          <span className="text-primary text-xs font-medium">required</span>
        ) : (
          <span className="text-muted-foreground text-xs">optional</span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{description}</p>
      <p className="text-foreground/80 bg-background/60 rounded px-2 py-1 font-mono text-xs">
        {example}
      </p>
    </div>
  );
}

export function DatasetAnatomyCard(): React.ReactElement {
  // Case 1 (index 1) is the richest example — has expectedOutput +
  // referenceCitations + tags, so every optional field is exercised.
  const sample = datasetSamples[1];
  return (
    <Card className="border-primary/30 bg-primary/5 dark:bg-primary/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" aria-hidden />
          Anatomy of a case
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{datasetHelp.goodCase}</p>

        <div className="space-y-3">
          <FieldRow
            name="input"
            required
            description="The question or prompt as a real user would phrase it."
            example={sample.input}
          />
          <FieldRow
            name="expectedOutput"
            description="The answer you would consider correct. Only required by reference graders (exact_match, contains, regex, json_schema)."
            example={sample.expectedOutput ?? '—'}
          />
          <FieldRow
            name="tags"
            description="Comma-separated labels for filtering cases later. Folded into metadata.tags on upload."
            example={sample.tags ?? '—'}
          />
          <FieldRow
            name="referenceCitations"
            description="JSON array of source documents the answer should ground in. Used by RAG graders (faithfulness, groundedness)."
            example={sample.referenceCitations ? JSON.stringify(sample.referenceCitations) : '—'}
          />
          <FieldRow
            name="metadata"
            description="Free-form JSON for case-level annotations (category, intent, difficulty)."
            example={sample.metadata ? JSON.stringify(sample.metadata) : '—'}
          />
        </div>
      </CardContent>
    </Card>
  );
}
