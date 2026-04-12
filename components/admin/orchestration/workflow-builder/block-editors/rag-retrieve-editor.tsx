'use client';

/**
 * RAG Retrieve step editor — query template, top K, similarity threshold.
 *
 * Maps to the knowledge-search capability at runtime. `similarityThreshold`
 * drops results below the cutoff even when `topK` hasn't been reached,
 * keeping irrelevant chunks out of the downstream prompt.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

export interface RagRetrieveConfig extends Record<string, unknown> {
  query: string;
  topK?: number;
  similarityThreshold?: number;
}

export function RagRetrieveEditor({ config, onChange }: EditorProps<RagRetrieveConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="rag-query" className="flex items-center text-xs">
          Search query{' '}
          <FieldHelp title="Search query">
            The query sent to the knowledge base. Supports <code>{'{{variables}}'}</code> templating
            from upstream step outputs.
          </FieldHelp>
        </Label>
        <Textarea
          id="rag-query"
          value={config.query ?? ''}
          onChange={(e) => onChange({ query: e.target.value })}
          placeholder="Design patterns for pattern 3 (Route)…"
          rows={4}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rag-top-k" className="flex items-center text-xs">
          Result count{' '}
          <FieldHelp title="Top K">
            Maximum number of chunks to return. Default: <code>5</code>. More chunks = more context
            but more tokens.
          </FieldHelp>
        </Label>
        <Input
          id="rag-top-k"
          type="number"
          min={1}
          max={50}
          value={config.topK ?? 5}
          onChange={(e) => onChange({ topK: Number(e.target.value) })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rag-threshold" className="flex items-center text-xs">
          Similarity threshold{' '}
          <FieldHelp title="Similarity threshold">
            Drops results with cosine similarity below this cutoff. Range <code>0&ndash;1</code>;
            default <code>0.7</code>. Raise to be stricter.
          </FieldHelp>
        </Label>
        <Input
          id="rag-threshold"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={config.similarityThreshold ?? 0.7}
          onChange={(e) => onChange({ similarityThreshold: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
