/**
 * DatasetAnatomyCard component tests.
 *
 * Coverage:
 *  - All 5 field names render as <code> elements (regression guard against
 *    accidentally deleted FieldRows)
 *  - `input` renders as "required"; the other 4 render as "optional"
 *    (guards against a boolean swap on `required`)
 *  - Content is driven by datasetSamples[1] — if the wrong sample index
 *    were used some optional fields would render as "—"; asserting an
 *    actual string from samples[1] catches that.
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-anatomy-card.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DatasetAnatomyCard } from '@/components/admin/orchestration/evaluations-foundations/dataset-anatomy-card';
import {
  datasetHelp,
  datasetSamples,
} from '@/components/admin/orchestration/evaluations-foundations/help-text';

describe('DatasetAnatomyCard', () => {
  it('renders all 5 expected field names as code elements', () => {
    render(<DatasetAnatomyCard />);

    const fieldNames = ['input', 'expectedOutput', 'tags', 'referenceCitations', 'metadata'];
    for (const name of fieldNames) {
      // getByText with selector ensures the text is inside a <code> element,
      // not just anywhere on the page.
      expect(screen.getByText(name, { selector: 'code' })).toBeInTheDocument();
    }
  });

  it('marks input as required and the other four fields as optional', () => {
    render(<DatasetAnatomyCard />);

    // There should be exactly one "required" badge and four "optional" badges.
    const requiredBadges = screen.getAllByText('required');
    const optionalBadges = screen.getAllByText('optional');

    expect(requiredBadges).toHaveLength(1);
    expect(optionalBadges).toHaveLength(4);

    // The single "required" badge must be adjacent to the "input" code element.
    // Both live inside the same parent flex row — verify by checking DOM order.
    const inputCode = screen.getByText('input', { selector: 'code' });
    const requiredBadge = requiredBadges[0];
    // They share a direct parent <div class="flex …">.
    expect(inputCode.parentElement).toBe(requiredBadge.parentElement);
  });

  it('renders content from datasetSamples[1], not samples[0] or samples[2]', () => {
    render(<DatasetAnatomyCard />);

    const sample1 = datasetSamples[1];
    const sample0 = datasetSamples[0];

    // The input value for samples[1] is distinct from samples[0] and samples[2].
    // If the wrong index is used, this assertion fails.
    expect(screen.getByText(sample1.input)).toBeInTheDocument();
    expect(screen.queryByText(sample0.input)).not.toBeInTheDocument();

    // samples[1] has a referenceCitations array — the card JSON.stringifies it.
    // samples[0] has no referenceCitations, so it would render "—" at index 0.
    const expectedCitationText = JSON.stringify(sample1.referenceCitations);
    expect(screen.getByText(expectedCitationText)).toBeInTheDocument();

    // The goodCase help text must appear in the card body.
    expect(screen.getByText(datasetHelp.goodCase)).toBeInTheDocument();
  });
});
