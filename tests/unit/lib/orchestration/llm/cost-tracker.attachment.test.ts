import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  calculateAttachmentCost,
  IMAGE_USD_PER_IMAGE,
  PDF_USD_PER_PDF,
} from '@/lib/orchestration/llm/cost-tracker';

describe('calculateAttachmentCost', () => {
  it('returns zero for zero attachments of both kinds', () => {
    const cost = calculateAttachmentCost(0, 0);
    expect(cost.totalCostUsd).toBe(0);
    expect(cost.inputCostUsd).toBe(0);
    expect(cost.outputCostUsd).toBe(0);
    expect(cost.isLocal).toBe(false);
  });

  it('charges flat per image only when imageCount > 0', () => {
    const cost = calculateAttachmentCost(3, 0);
    expect(cost.totalCostUsd).toBeCloseTo(3 * IMAGE_USD_PER_IMAGE, 10);
  });

  it('charges flat per PDF only when pdfCount > 0', () => {
    const cost = calculateAttachmentCost(0, 2);
    expect(cost.totalCostUsd).toBeCloseTo(2 * PDF_USD_PER_PDF, 10);
  });

  it('sums image and PDF charges when both are present', () => {
    const cost = calculateAttachmentCost(2, 3);
    expect(cost.totalCostUsd).toBeCloseTo(2 * IMAGE_USD_PER_IMAGE + 3 * PDF_USD_PER_PDF, 10);
  });

  it('floors fractional counts to integers (defensive)', () => {
    const cost = calculateAttachmentCost(2.7, 1.9);
    expect(cost.totalCostUsd).toBeCloseTo(2 * IMAGE_USD_PER_IMAGE + 1 * PDF_USD_PER_PDF, 10);
  });

  it('treats negative counts as zero', () => {
    const cost = calculateAttachmentCost(-1, -5);
    expect(cost.totalCostUsd).toBe(0);
  });

  it('treats NaN counts as zero', () => {
    const cost = calculateAttachmentCost(NaN, Infinity);
    expect(cost.totalCostUsd).toBe(0);
  });
});
