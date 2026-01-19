'use client';

import { cn } from '@/lib/utils';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export interface FAQItem {
  /** Question text */
  question: string;
  /** Answer text */
  answer: string;
}

export interface FAQProps {
  /** Array of FAQ items */
  items: FAQItem[];
  /** Maximum width of the FAQ list */
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  /** Additional className */
  className?: string;
}

const maxWidthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
};

/**
 * FAQ Component
 *
 * Accordion-based FAQ section for common questions.
 *
 * @example
 * <FAQ
 *   items={[
 *     { question: "What is Sunrise?", answer: "A Next.js starter template." },
 *     { question: "Is it free?", answer: "Yes, it's open source." },
 *   ]}
 * />
 */
export function FAQ({ items, maxWidth = '3xl', className }: FAQProps) {
  return (
    <Accordion
      type="single"
      collapsible
      className={cn('mx-auto w-full', maxWidthClasses[maxWidth], className)}
    >
      {items.map((item, index) => (
        <AccordionItem key={index} value={`item-${index}`}>
          <AccordionTrigger className="text-left text-base font-medium">
            {item.question}
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground">{item.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
