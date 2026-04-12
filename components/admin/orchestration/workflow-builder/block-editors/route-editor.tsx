'use client';

/**
 * Route step editor — classification prompt and a dynamic list of branch
 * labels.
 *
 * The labels are stored in `config.routes` as `{ label: string }[]`. They
 * are intentionally **not** synced to outgoing edge labels in Session
 * 5.1b — the inline edge label editor (click an edge to set its condition)
 * lands in Session 5.1c. For now the route step documents its branches in
 * config and the user draws edges on the canvas separately.
 */

import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

interface RouteBranch {
  label: string;
}

export interface RouteConfig extends Record<string, unknown> {
  classificationPrompt: string;
  routes: RouteBranch[];
}

export function RouteEditor({ config, onChange }: EditorProps<RouteConfig>) {
  const routes = Array.isArray(config.routes) ? config.routes : [];

  const updateLabel = (index: number, label: string): void => {
    const next = routes.map((r, i) => (i === index ? { ...r, label } : r));
    onChange({ routes: next });
  };

  const addBranch = (): void => {
    onChange({ routes: [...routes, { label: `branch-${routes.length + 1}` }] });
  };

  const removeBranch = (index: number): void => {
    onChange({ routes: routes.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="route-classification" className="flex items-center text-xs">
          Classification prompt{' '}
          <FieldHelp title="Classification prompt">
            The instruction sent to the router model. It should ask the model to classify the
            incoming state into exactly one of the branch labels below.
          </FieldHelp>
        </Label>
        <Textarea
          id="route-classification"
          value={config.classificationPrompt ?? ''}
          onChange={(e) => onChange({ classificationPrompt: e.target.value })}
          placeholder="Classify the user's intent as one of: refund, technical, sales…"
          rows={5}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="flex items-center text-xs">
          Branches{' '}
          <FieldHelp title="Branches">
            The possible classification outcomes. Needs at least two. In Session 5.1c each label
            will bind to an outgoing edge — for now they live in config only.
          </FieldHelp>
        </Label>
        <div className="space-y-2">
          {routes.length === 0 && (
            <p className="text-muted-foreground text-xs italic">
              No branches yet — add two or more below.
            </p>
          )}
          {routes.map((branch, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Branch ${index + 1} label`}
                value={branch.label}
                onChange={(e) => updateLabel(index, e.target.value)}
                placeholder={`branch-${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeBranch(index)}
                aria-label={`Remove branch ${index + 1}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addBranch} className="w-full">
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add branch
          </Button>
        </div>
      </div>
    </div>
  );
}
