/**
 * Tests: lib/privacy/sensitivity/classifier.ts — core's phrase-list
 * sensitivity classifier (§130 t-1036).
 *
 * How it matches: which parts it reads, whole words, exclusions, separators.
 * How well it matches is the corpus gate's job (`corpus.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  CORE_SENSITIVITY_CATEGORIES,
  type SensitivityInput,
  type SensitivityPart,
} from '@/lib/privacy/adapters/types';
import {
  classifyText,
  phraseSource,
  SENSITIVITY_PHRASES_CLASSIFIER_ID,
  sensitivityPhrasesClassifier,
} from '@/lib/privacy/sensitivity/classifier';
import { SENSITIVITY_PHRASES } from '@/lib/privacy/sensitivity/phrases';

async function classify(parts: SensitivityPart[]): Promise<string[]> {
  const input: SensitivityInput = { parts };
  const findings = await sensitivityPhrasesClassifier().classify(input, {
    signal: new AbortController().signal,
    scopeId: 's',
  });
  return findings.map((f) => f.category);
}

describe('the classifier', () => {
  it('is core, in-process, and declares exactly the core categories in their groups', () => {
    const c = sensitivityPhrasesClassifier();
    expect(c.id).toBe(SENSITIVITY_PHRASES_CLASSIFIER_ID);
    expect(c.id.startsWith('core.')).toBe(true);
    expect(c.egress).toBe('in_process');
    expect(c.categories).toEqual(CORE_SENSITIVITY_CATEGORIES);
  });

  it('has phrases for every category it declares, and none it does not', () => {
    expect(Object.keys(SENSITIVITY_PHRASES).sort()).toEqual(
      Object.keys(CORE_SENSITIVITY_CATEGORIES).sort()
    );
    for (const { phrases } of Object.values(SENSITIVITY_PHRASES)) {
      expect(phrases.length).toBeGreaterThan(0);
    }
  });

  it('reads user parts and embedding inputs', async () => {
    expect(
      await classify([{ role: 'user', text: "I've been signed off with depression" }])
    ).toEqual(['health']);
    expect(await classify([{ role: 'embedding', text: 'signed off with depression' }])).toEqual([
      'health',
    ]);
  });

  it('does not read the system prompt, tool results or the assistant', async () => {
    const text = 'Handle each grievance and every case of depression with care.';
    // The same text flags as a user's...
    expect(await classify([{ role: 'user', text }])).toEqual(['health', 'hr_matter']);
    // ...and not in any part the user did not write.
    expect(
      await classify([
        { role: 'system', text },
        { role: 'tool', text },
        { role: 'assistant', text },
      ])
    ).toEqual([]);
  });

  it('never matches a phrase across two parts', async () => {
    expect(
      await classify([
        { role: 'user', text: 'She was admitted to' },
        { role: 'user', text: 'hospital records are kept for six years' },
      ])
    ).toEqual([]);
    expect(await classify([{ role: 'user', text: 'She was admitted to hospital' }])).toEqual([
      'health',
    ]);
  });

  it('finds nothing in an empty call', async () => {
    expect(await classify([])).toEqual([]);
    expect(await classify([{ role: 'system', text: 'depression' }])).toEqual([]);
  });
});

describe('matching', () => {
  it('matches whole words only', () => {
    expect(classifyText('the archive is in the hippo enclosure')).toEqual([]);
    expect(classifyText('a cancerous mole')).toEqual([]);
    expect(classifyText('the IPO is in May')).toEqual(['deal']);
  });

  it('ignores case', () => {
    expect(classifyText('SIGNED OFF WITH DEPRESSION')).toEqual(['health']);
  });

  it('reads a space in a phrase as any run of spaces or hyphens', () => {
    expect(classifyText('she is mixed-race')).toEqual(['ethnicity']);
    expect(classifyText('she is mixed   race')).toEqual(['ethnicity']);
    expect(phraseSource('mixed race')).toBe('mixed[\\s\\-]+race');
  });

  it('reads a space then ? as no separator or any', () => {
    expect(classifyText('she uses the food bank')).toEqual(['personal_finance']);
    expect(classifyText('she uses the foodbank')).toEqual(['personal_finance']);
    expect(phraseSource('food ?bank')).toBe('food[\\s\\-]*bank');
  });

  it('reads curly apostrophes as straight ones', () => {
    expect(classifyText('I’m bi and nervous about the party')).toEqual(['sexuality']);
    expect(classifyText("I'm bi and nervous about the party")).toEqual(['sexuality']);
  });

  it('reads an identity only with a person as its subject', () => {
    expect(classifyText('The background is black, can you change it to grey?')).toEqual([]);
    expect(classifyText('Our payroll is bi weekly, draft a reminder')).toEqual([]);
    expect(classifyText("She's Black Caribbean and was passed over")).toEqual(['ethnicity']);
    expect(classifyText('they were asian and new to the team')).toEqual(['ethnicity']);
  });

  it('does not read the second half of a hyphenated word as the phrase', () => {
    expect(classifyText('We run a multi-disciplinary team')).toEqual([]);
    expect(classifyText('A disciplinary hearing is booked')).toEqual(['hr_matter']);
  });

  it('does not read a hyphenated prefix as an identity', () => {
    expect(classifyText('The report is bi-weekly')).toEqual([]);
    expect(classifyText('The route is trans-Pennine')).toEqual([]);
  });

  it('reports each category once, however often it appears', () => {
    expect(classifyText('depression, chemo, and more depression')).toEqual(['health']);
  });
});

describe('exclusions', () => {
  it('blank out a phrase that shares a category word and means something else', () => {
    expect(classifyText('Our customer acquisition cost is up')).toEqual([]);
    expect(classifyText("What's our grievance procedure?")).toEqual([]);
    expect(classifyText('Can you restructure this paragraph?')).toEqual([]);
    expect(classifyText('Explain the European Union')).toEqual([]);
  });

  it('blank only their own text, so a real disclosure beside one still flags', () => {
    expect(
      classifyText(
        'Ignore customer acquisition for now; the acquisition of Harbourside is the priority.'
      )
    ).toEqual(['deal']);
    expect(
      classifyText(
        'I read the grievance procedure and I want to raise a grievance about my manager.'
      )
    ).toEqual(['hr_matter']);
  });

  it('blank every occurrence, not the first', () => {
    expect(classifyText('customer acquisition, user acquisition, talent acquisition')).toEqual([]);
  });

  it('apply to their own category only', () => {
    // "European Union" is excluded from trade_union; nothing excludes it elsewhere.
    expect(classifyText('a union rep from the European Union office')).toEqual(['trade_union']);
  });
});

describe('cost', () => {
  it('classifies a very long history in well under its default timeout', () => {
    const filler = 'The quarterly figures are attached; please review the slides before Thursday. ';
    const text = filler.repeat(25_000) + 'I was diagnosed with diabetes.';
    expect(text.length).toBeGreaterThan(1_900_000);
    const started = performance.now();
    expect(classifyText(text)).toEqual(['health']);
    // The default per-classifier timeout is 1 s, and a synchronous classifier
    // cannot be interrupted, so it must finish well inside it.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('review round 2', () => {
  it('reads plurals of the nouns a phrase ends on', () => {
    expect(classifyText('Our union reps are pushing back')).toEqual(['trade_union']);
    expect(classifyText('The union members voted to reject the offer')).toEqual(['trade_union']);
    expect(classifyText('She filed two harassment claims')).toEqual(['hr_matter']);
    expect(classifyText('I have tribunal hearings next week')).toEqual(['legal_matter']);
    expect(classifyText('The custody battles have been exhausting')).toEqual(['legal_matter']);
  });

  it('does not blank a restructure of a team as if it were a document', () => {
    expect(classifyText('We are restructuring the data team next month')).toEqual([
      'restructuring',
    ]);
    expect(classifyText('Restructure the data so each row is one order')).toEqual([]);
  });

  it('does not read "public-facing" as not public', () => {
    expect(classifyText('This endpoint is not public-facing')).toEqual([]);
    expect(classifyText('The launch is not public yet')).toEqual(['not_public']);
  });
});
