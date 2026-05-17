'use client';

/**
 * Single section in a structured approval view.
 *
 * Renders the section header (title + description) and the list of
 * items. Item-level state (accept/reject decision, sub-item state) is
 * owned by the parent `StructuredApprovalView`; this component is
 * presentational and forwards changes via `onItemChange`.
 */

import { ReviewItem } from '@/components/admin/orchestration/approvals/review-item';
import type { ItemState, ResolvedItem } from '@/lib/orchestration/review-schema/resolver';
import type { ReviewSection as ReviewSectionSpec } from '@/lib/orchestration/review-schema/types';

export interface ReviewSectionProps {
  section: ReviewSectionSpec;
  items: ResolvedItem[];
  state: Record<string, ItemState>;
  onItemChange: (itemKey: string, next: ItemState) => void;
}

export function ReviewSection({ section, items, state, onItemChange }: ReviewSectionProps) {
  return (
    <section className="bg-background rounded-md border">
      <header className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">
          {section.title}
          <span className="text-muted-foreground ml-2 text-xs font-normal">({items.length})</span>
        </h3>
        {section.description && (
          <p className="text-muted-foreground mt-1 text-xs">{section.description}</p>
        )}
      </header>
      {items.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">No items.</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.__key}>
              <ReviewItem
                section={section}
                item={item}
                state={state[item.__key]}
                onChange={(next) => onItemChange(item.__key, next)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
