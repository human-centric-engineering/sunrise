/**
 * Tier C: names, addresses and companies from lists and cues. Each rule is
 * tested for what it finds and for the ordinary text it must leave alone,
 * because this tier's errors are mostly false positives.
 */
import { describe, expect, it } from 'vitest';
import {
  findListSpans,
  LIST_CONFIDENCE,
  LISTS_DETECTOR_ID,
  LISTS_ENTITY_TYPES,
  listsDetector,
} from '@/lib/privacy/pii/lists';

/** `[type, covered text]`, in text order, deduplicated. */
function found(text: string, prior: { start: number; end: number }[] = []): [string, string][] {
  const seen = new Set<string>();
  return findListSpans(text, prior)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((s): [string, string] => [s.type, text.slice(s.start, s.end)])
    .filter(([type, t]) => {
      const key = `${type}:${t}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function confidenceOf(text: string, covered: string): number | undefined {
  return findListSpans(text).find((s) => text.slice(s.start, s.end) === covered)?.confidence;
}

describe('companies', () => {
  it('finds a name ending in a legal suffix, suffix and full stop included', () => {
    const text = 'Invoice from Corrigan Joinery Ltd. today';
    expect(found(text)).toEqual([['ORG', 'Corrigan Joinery Ltd.']]);
    expect(confidenceOf(text, 'Corrigan Joinery Ltd.')).toBe(LIST_CONFIDENCE.orgWithSuffix);
  });

  it('keeps connectors and ampersands inside the name', () => {
    expect(found('Employer: Sefton & Rowe Surveyors LLP.')[0]).toEqual([
      'ORG',
      'Sefton & Rowe Surveyors LLP',
    ]);
  });

  it('drops a leading sentence starter', () => {
    expect(found('Contact Halden Logistics Ltd about it')[0]).toEqual([
      'ORG',
      'Halden Logistics Ltd',
    ]);
  });

  it('learns the short form and the head word, and marks them elsewhere', () => {
    const text = 'Halden Logistics Ltd will pay. Halden Logistics confirmed; Halden is reliable.';
    const spans = findListSpans(text);
    // The type and confidence of what covers the Nth whole-word "Halden…".
    const at = (value: string, nth: number) => {
      let start = -1;
      for (let k = 0; k < nth; k++) start = text.indexOf(value, start + 1);
      return spans
        .filter((s) => s.start === start && s.end === start + value.length)
        .map((s) => [s.type, s.confidence]);
    };
    expect(at('Halden Logistics', 2)).toEqual([['ORG', LIST_CONFIDENCE.orgShortForm]]);
    expect(at('Halden', 3)).toEqual([['ORG', LIST_CONFIDENCE.orgHead]]);
    // Nothing is re-marked inside the full name it was learned from.
    expect(spans.filter((s) => s.start === 0)).toEqual([
      { type: 'ORG', start: 0, end: 20, confidence: LIST_CONFIDENCE.orgWithSuffix },
    ]);
    // Each form found elsewhere is marked learned; the full name is not (t-1018).
    for (const s of spans) {
      expect([text.slice(s.start, s.end), s.learned === true]).toEqual([
        text.slice(s.start, s.end),
        s.start !== 0,
      ]);
    }
    expect(spans.filter((s) => s.learned === true).length).toBeGreaterThanOrEqual(2);
  });

  it('does not learn a head word that is a first name', () => {
    // "Sarah" alone after this is a person, not the company.
    const spans = found('Sarah Jones Ltd was founded by Sarah.');
    expect(spans).not.toContainEqual(['ORG', 'Sarah']);
  });

  it('takes a capitalised "Co" as a suffix, with its ampersand', () => {
    expect(found('Quote from Ashby Tile Co today')).toEqual([['ORG', 'Ashby Tile Co']]);
    expect(found('We paid Morton & Co. in full')[0]).toEqual(['ORG', 'Morton & Co.']);
    expect(found('the Morton co op')).toEqual([]);
  });

  it('leaves an allowlisted company alone', () => {
    expect(found('We buy from Microsoft Ltd and Tesco PLC.')).toEqual([]);
  });

  it('needs a capitalised word before the suffix', () => {
    expect(found('the company is a limited one')).toEqual([]);
  });
});

describe('addresses', () => {
  it('finds a numbered street and the towns after it', () => {
    expect(found('She lives at 14 Acacia Avenue, Leeds, West Yorkshire now')).toEqual([
      ['ADDRESS', '14 Acacia Avenue, Leeds, West Yorkshire'],
    ]);
  });

  it('includes a flat or unit number before the street', () => {
    expect(found('Send to Flat 4, 112 Gloucester Road please')).toEqual([
      ['ADDRESS', 'Flat 4, 112 Gloucester Road'],
    ]);
  });

  it('includes an abbreviated suffix and its full stop', () => {
    expect(found('at 5 Elm Rd. tomorrow')).toEqual([['ADDRESS', '5 Elm Rd.']]);
  });

  it('finds an unnumbered street only after an address cue', () => {
    expect(found('He moved to Canal Wharf last year')).toEqual([['ADDRESS', 'Canal Wharf']]);
    expect(found('The bus stops on Station Road.')).toEqual([]);
  });

  it('does not join a street across a line break', () => {
    expect(found('12 Larkspur\nAvenue').filter(([type]) => type === 'ADDRESS')).toEqual([]);
  });
});

describe('people', () => {
  it('finds a name after a title, and leaves the title visible', () => {
    expect(found('Ask Dr Okafor or Mrs J. Hart.')).toEqual([
      ['PERSON', 'Okafor'],
      ['PERSON', 'J. Hart'],
    ]);
  });

  it('finds a full name from the lists', () => {
    expect(found('Notes from Niamh Gallagher and Bilal Hussain.')).toEqual([
      ['PERSON', 'Niamh Gallagher'],
      ['PERSON', 'Bilal Hussain'],
    ]);
  });

  it('accepts a first name that is a word only with a surname, or mid-sentence', () => {
    // "Grace" is a word; "Patel" is a known surname; "Okafor" is neither.
    expect(found('Attendees: Will Patel, Grace Okafor')).toEqual([
      ['PERSON', 'Will Patel'],
      ['PERSON', 'Grace Okafor'],
    ]);
    // Sentence-initial, a word before a word: not a name.
    expect(found('Grace Period ends today.')).toEqual([]);
  });

  it('accepts a surname that is also a street word', () => {
    expect(found('I met Sarah Green yesterday.')).toEqual([['PERSON', 'Sarah Green']]);
    expect(found('Ask Dr Green about it')).toEqual([['PERSON', 'Green']]);
    expect(found('Tom Park signed it')).toEqual([['PERSON', 'Tom Park']]);
    // Numbered, it is still an address, and the address names the span.
    expect(found('Send it to 4 Holly Lane, Leeds')).toContainEqual([
      'ADDRESS',
      '4 Holly Lane, Leeds',
    ]);
  });

  it('does not take a street or company for a person', () => {
    expect(found('Visit 10 Jordan Road.')).toEqual([['ADDRESS', '10 Jordan Road']]);
  });

  it('finds a name after a strong cue even when no list has it', () => {
    expect(found('Dear Ngozi, thanks')).toEqual([['PERSON', 'Ngozi']]);
    expect(confidenceOf('Dear Ngozi, thanks', 'Ngozi')).toBe(LIST_CONFIDENCE.cuedUnknownName);
  });

  it('does not learn the words of a cued run that no name list has', () => {
    const text = 'Dear Customer Services,\nThe Customer is here.';
    expect(found(text)).toEqual([['PERSON', 'Customer Services']]);
  });

  it('needs a known first name after a weak cue', () => {
    expect(found('A note from Siobhan.')).toEqual([['PERSON', 'Siobhan']]);
    expect(found('A note from Accounts.')).toEqual([]);
  });

  it('finds a known first name alone, at the lowest confidence', () => {
    expect(found('Yesterday Olivia called.')).toEqual([['PERSON', 'Olivia']]);
    expect(confidenceOf('Yesterday Olivia called.', 'Olivia')).toBe(LIST_CONFIDENCE.loneFirstName);
  });

  it('leaves names that are also words, places and products alone', () => {
    expect(
      found(
        'May I ask? Will you mark it? Hope so. Reading and Chelsea are busy. Ask Alexa or Claude. German supplier.'
      )
    ).toEqual([]);
  });

  it('does not take a short all-capitals word for a name', () => {
    expect(found('The AMY report is due')).toEqual([]);
  });

  it('cuts a possessive off the name', () => {
    expect(found("It is Priya Sharma's turn")).toEqual([['PERSON', 'Priya Sharma']]);
  });

  it('marks the parts of a full name elsewhere in the text, capitalised only', () => {
    const text = 'Kieran Moss joined. Later Moss left; moss grew.';
    expect(found(text)).toEqual([
      ['PERSON', 'Kieran Moss'],
      ['PERSON', 'Moss'],
    ]);
    expect(confidenceOf(text, 'Moss')).toBe(LIST_CONFIDENCE.learnedName);
    // Personal only because of the full name: a refusal under `block` places
    // the full name, not this (t-1018).
    const spans = findListSpans(text);
    expect(spans.find((s) => text.slice(s.start, s.end) === 'Moss')?.learned).toBe(true);
    expect(spans.find((s) => text.slice(s.start, s.end) === 'Kieran Moss')).not.toHaveProperty(
      'learned'
    );
  });
});

describe('signatures', () => {
  it('finds the name on the line after a closing', () => {
    expect(found('Thanks for this.\n\nKind regards,\nMarcus Achterberg')).toEqual([
      ['PERSON', 'Marcus Achterberg'],
    ]);
    expect(
      confidenceOf('Thanks for this.\n\nKind regards,\nMarcus Achterberg', 'Marcus Achterberg')
    ).toBe(LIST_CONFIDENCE.signature);
  });

  it('finds the writer in CRLF text', () => {
    // A lone surname: only the signature rule finds it, so this fails if CRLF
    // lines stop matching.
    for (const eol of ['\n', '\r\n']) {
      const text = `All good.${eol}Kind regards,${eol}Sharma${eol}Sales`;
      expect(confidenceOf(text, 'Sharma')).toBe(LIST_CONFIDENCE.signature);
    }
  });

  it('does not take a team or a product for the writer', () => {
    expect(found('Best,\nThe Support Team')).toEqual([]);
    expect(found('Cheers,\nSlack Bot')).toEqual([]);
  });
});

describe('earlier tiers', () => {
  it('drops what lies wholly inside text an earlier detector already covered', () => {
    const text = 'Email Sarah Jones about it';
    // As if tier B had found "Sarah Jones" already.
    expect(found(text, [{ start: 6, end: 17 }])).toEqual([]);
    expect(found(text)).toEqual([['PERSON', 'Sarah Jones']]);
  });

  it('still finds a name an earlier span covers only part of', () => {
    // Tier B masked the user's own first name, "James"; the colleague's
    // surname must not be left with nothing to start from.
    const text = 'I met James Patel yesterday.';
    expect(found(text, [{ start: 6, end: 11 }])).toEqual([['PERSON', 'James Patel']]);
    // "Anne" of the user's "Anne Smith" inside someone's "Anne-Marie Dubois".
    const hyphen = 'Write to Anne-Marie Dubois about it';
    expect(found(hyphen, [{ start: 9, end: 13 }])).toEqual([['PERSON', 'Anne-Marie Dubois']]);
  });
});

describe('listsDetector', () => {
  it('declares only the types it reports, and passes on the prior spans', async () => {
    const detector = listsDetector();
    expect(detector.id).toBe(LISTS_DETECTOR_ID);
    expect(detector.egress).toBe('in_process');
    expect(detector.languages).toEqual(['en']);
    const text = 'Sarah Jones of Halden Ltd lives at 3 Mill Lane.';
    const spans = await detector.detect(
      { text },
      { signal: new AbortController().signal, scopeId: 's', knownValues: [], priorSpans: [] }
    );
    expect(new Set(spans.map((s) => s.type))).toEqual(new Set(LISTS_ENTITY_TYPES));
    const skipped = await detector.detect(
      { text },
      {
        signal: new AbortController().signal,
        scopeId: 's',
        knownValues: [],
        priorSpans: [
          { type: 'PERSON', start: 0, end: 11, confidence: 0.98, source: 'core.known-values' },
        ],
      }
    );
    expect(skipped.some((s) => s.type === 'PERSON')).toBe(false);
  });

  it('grows linearly with the text, not quadratically', () => {
    // Each word used to rescan everything before it to decide whether it
    // started a sentence. Sixteen times the text now costs about sixteen
    // times the time; it used to cost about 250 times.
    const unit = 'and Grace Zqxvb went home. ';
    const time = (n: number) => {
      const text = unit.repeat(n);
      const t0 = performance.now();
      findListSpans(text);
      return performance.now() - t0;
    };
    time(200); // warm-up
    const small = Math.max(time(500), 1);
    const large = time(8000);
    expect(large / small).toBeLessThan(80);
  });

  it('grows linearly with the number of names it learns', () => {
    // Each learned name part used to be its own scan of the whole text.
    const names = (n: number) =>
      Array.from({ length: n }, (_, i) => `Dear Olivia Zq${i.toString(36)}x, `).join('');
    const time = (n: number) => {
      const text = names(n);
      const t0 = performance.now();
      findListSpans(text);
      return performance.now() - t0;
    };
    time(100);
    const small = Math.max(time(250), 1);
    const large = time(4000);
    expect(large / small).toBeLessThan(80);
  });

  it('rejects when its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(
      listsDetector().detect(
        { text: 'x' },
        { signal: controller.signal, scopeId: 's', knownValues: [], priorSpans: [] }
      )
    ).rejects.toThrow('gone');
  });
});
