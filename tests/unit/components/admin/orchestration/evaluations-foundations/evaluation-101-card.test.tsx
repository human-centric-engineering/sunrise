/**
 * Evaluation101Card Component Tests
 *
 * Test coverage:
 * - Renders headline + 3 sections (Datasets, Graders, Runs) by default
 * - `hideSection='datasets'` hides the Datasets section + its CTA
 * - `hideSection='runs'` hides the Runs section + its CTA
 * - Dataset CTA links to /admin/orchestration/evaluations/datasets/new
 * - Run CTA links to /admin/orchestration/evaluations/runs/new
 *
 * @see components/admin/orchestration/evaluations-foundations/evaluation-101-card.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Evaluation101Card } from '@/components/admin/orchestration/evaluations-foundations/evaluation-101-card';
import { evaluation101 } from '@/components/admin/orchestration/evaluations-foundations/help-text';

describe('Evaluation101Card', () => {
  describe('default render', () => {
    it('renders the headline', () => {
      render(<Evaluation101Card />);
      expect(screen.getByText(evaluation101.headline)).toBeInTheDocument();
    });

    it('renders all three section headings by default', () => {
      render(<Evaluation101Card />);
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.datasetsHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.gradersHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.runsHeading, 'i') })
      ).toBeInTheDocument();
    });

    it('renders the Datasets CTA linking to /datasets/new', () => {
      render(<Evaluation101Card />);
      const link = screen.getByRole('link', { name: new RegExp(evaluation101.datasetsCta, 'i') });
      expect(link).toHaveAttribute('href', '/admin/orchestration/evaluations/datasets/new');
    });

    it('renders the Runs CTA linking to /runs/new', () => {
      render(<Evaluation101Card />);
      const link = screen.getByRole('link', { name: new RegExp(evaluation101.runsCta, 'i') });
      expect(link).toHaveAttribute('href', '/admin/orchestration/evaluations/runs/new');
    });
  });

  describe('hideSection="datasets"', () => {
    it('hides the Datasets heading and its CTA', () => {
      render(<Evaluation101Card hideSection="datasets" />);
      expect(
        screen.queryByRole('heading', { name: new RegExp(evaluation101.datasetsHeading, 'i') })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: new RegExp(evaluation101.datasetsCta, 'i') })
      ).not.toBeInTheDocument();
    });

    it('still renders the Graders and Runs sections', () => {
      render(<Evaluation101Card hideSection="datasets" />);
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.gradersHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.runsHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: new RegExp(evaluation101.runsCta, 'i') })
      ).toBeInTheDocument();
    });
  });

  describe('hideSection="runs"', () => {
    it('hides the Runs heading and its CTA', () => {
      render(<Evaluation101Card hideSection="runs" />);
      expect(
        screen.queryByRole('heading', { name: new RegExp(evaluation101.runsHeading, 'i') })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: new RegExp(evaluation101.runsCta, 'i') })
      ).not.toBeInTheDocument();
    });

    it('still renders the Datasets and Graders sections', () => {
      render(<Evaluation101Card hideSection="runs" />);
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.datasetsHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: new RegExp(evaluation101.gradersHeading, 'i') })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: new RegExp(evaluation101.datasetsCta, 'i') })
      ).toBeInTheDocument();
    });
  });
});
