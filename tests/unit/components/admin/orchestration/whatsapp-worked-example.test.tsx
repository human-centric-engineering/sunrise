/**
 * Tests: WhatsAppWorkedExample component on the New Trigger page.
 *
 * Smoke tests only — the value of this component is the prose content,
 * not the interaction. We assert the three section headings render so
 * a future restructure (e.g. accidentally collapsing the accordion into
 * one section, or losing one of the three frames) trips a test.
 *
 * @see components/admin/orchestration/whatsapp-worked-example.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WhatsAppWorkedExample } from '@/components/admin/orchestration/whatsapp-worked-example';

describe('WhatsAppWorkedExample', () => {
  it('renders the top-level heading + framing sentence', () => {
    render(<WhatsAppWorkedExample />);
    expect(
      screen.getByText(/Worked example — answering an inbound WhatsApp message/)
    ).toBeInTheDocument();
  });

  it('exposes all three frames as expandable accordion triggers', () => {
    render(<WhatsAppWorkedExample />);
    expect(screen.getByText(/Why a user engages via WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/End-to-end flow/)).toBeInTheDocument();
    expect(screen.getByText(/Input \/ output \/ persistence map/)).toBeInTheDocument();
  });
});
