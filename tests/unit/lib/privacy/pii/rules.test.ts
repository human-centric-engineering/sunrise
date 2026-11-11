/**
 * Tier A's recognisers. Each test asserts the exact text a span covers
 * (`found()` slices the input by the span's offsets), so an off-by-one or a
 * code-point offset fails as visibly as a miss.
 */
import { describe, expect, it } from 'vitest';
import type { DetectedSpan } from '@/lib/privacy/adapters/types';
import {
  __recognisersForTests as R,
  RULES_DETECTOR_ID,
  RULES_ENTITY_TYPES,
  rulesDetector,
} from '@/lib/privacy/pii/rules';

type Recogniser = (text: string) => DetectedSpan[];

/** What a recogniser found, as `[type, covered text, confidence]`. */
function found(recognise: Recogniser, text: string): [string, string, number][] {
  return recognise(text).map((s) => [s.type, text.slice(s.start, s.end), s.confidence]);
}

function texts(recognise: Recogniser, text: string): string[] {
  return found(recognise, text).map(([, t]) => t);
}

describe('emails', () => {
  it('finds an address and covers all of it', () => {
    expect(found(R.emails, 'Write to jo.bloggs+news@mail.example.co.uk today.')).toEqual([
      ['EMAIL', 'jo.bloggs+news@mail.example.co.uk', 1],
    ]);
  });

  it('does not take the sentence full stop', () => {
    expect(texts(R.emails, 'It is a@example.com.')).toEqual(['a@example.com']);
  });

  it('ignores an @ that is not an address', () => {
    expect(texts(R.emails, 'Meet @ 3pm, or ping @team on Slack.')).toEqual([]);
  });
});

describe('phones', () => {
  it('reports a valid UK number in any common spelling', () => {
    expect(texts(R.phones, 'Call 020 7946 0958, or (0161) 496-0254, or +44 113 496 0123.')).toEqual(
      ['020 7946 0958', '(0161) 496-0254', '+44 113 496 0123']
    );
  });

  it('reports an international number by its prefix', () => {
    expect(texts(R.phones, 'My French mobile is +33 6 12 34 56 78.')).toEqual([
      '+33 6 12 34 56 78',
    ]);
  });

  it('reports a number that is only possible when a phone word comes before it', () => {
    // 07700 900xxx is Ofcom's drama range: possible, never allocated.
    expect(found(R.phones, 'Text me on 07700 900123 later')).toEqual([
      ['PHONE', '07700 900123', 0.85],
    ]);
    expect(texts(R.phones, 'Reference 07700 900123 is closed')).toEqual([]);
  });

  it('ranks a valid number below a checksum or context-confirmed identifier', () => {
    const [phone] = R.phones('Ring 020 7946 0958');
    expect(phone.confidence).toBe(0.9);
  });
});

describe('postcodes', () => {
  it.each(['SW1A 1AA', 'M1 1AE', 'B33 8TH', 'CR2 6XH', 'DN55 1PT', 'EC1A 1BB', 'GIR 0AA'])(
    'finds %s',
    (pc) => {
      expect(texts(R.postcodes, `Send it to ${pc}, please.`)).toEqual([pc]);
    }
  );

  it('finds a capitalised postcode without its space', () => {
    expect(texts(R.postcodes, 'Postcode LS64AB.')).toEqual(['LS64AB']);
  });

  it('needs the space when the postcode is not in capitals', () => {
    expect(texts(R.postcodes, 'near ls6 4ab')).toEqual(['ls6 4ab']);
    expect(texts(R.postcodes, 'near ls64ab')).toEqual([]);
  });

  it('refuses letters Royal Mail never uses in the inward code', () => {
    // C, I, K, M, O and V are never inward-code letters.
    expect(texts(R.postcodes, 'Code SW1A 1CI here')).toEqual([]);
  });

  it('does not find one inside a longer token', () => {
    expect(texts(R.postcodes, 'Part XSW1A1AAX')).toEqual([]);
  });
});

describe('ninos', () => {
  it('reports a NINO with its suffix outright, at full confidence', () => {
    expect(found(R.ninos, 'NINO: TJ 33 15 36 A.')).toEqual([['UK_NINO', 'TJ 33 15 36 A', 1]]);
    expect(texts(R.ninos, 'it is EP509054B')).toEqual(['EP509054B']);
  });

  it('needs a National Insurance word when the suffix is missing', () => {
    expect(found(R.ninos, 'National Insurance number AB123456')).toEqual([
      ['UK_NINO', 'AB123456', 0.9],
    ]);
    expect(texts(R.ninos, 'SKU AB123456 is out of stock')).toEqual([]);
  });

  it('needs the context word for one typed in lower case', () => {
    expect(texts(R.ninos, 'my ni number is ab123456c')).toEqual(['ab123456c']);
    expect(texts(R.ninos, 'code ab123456c')).toEqual([]);
  });

  it('does not take a following lower-case word for the suffix', () => {
    expect(texts(R.ninos, 'NINO AB123456 a dog')).toEqual(['AB123456']);
    expect(texts(R.ninos, 'NINO AB123456 A')).toEqual(['AB123456 A']);
  });

  it('refuses prefixes HMRC never issues, even with context', () => {
    expect(texts(R.ninos, 'NI number QQ 12 34 56 C')).toEqual([]);
    expect(texts(R.ninos, 'NI number GB 12 34 56 C')).toEqual([]);
  });
});

describe('nhsNumbers', () => {
  it('reports a valid number printed 3-3-4', () => {
    expect(found(R.nhsNumbers, 'Patient 943 476 5919 seen')).toEqual([
      ['NHS_NUMBER', '943 476 5919', 1],
    ]);
    expect(texts(R.nhsNumbers, 'ref 943-476-5919')).toEqual(['943-476-5919']);
  });

  it('reports a bare valid number only with a health word before it', () => {
    expect(texts(R.nhsNumbers, 'NHS no 9434765919')).toEqual(['9434765919']);
    expect(texts(R.nhsNumbers, 'Order 9434765919 shipped')).toEqual([]);
  });

  it('rejects a number whose check digit is wrong, even with context', () => {
    expect(texts(R.nhsNumbers, 'NHS number 943 476 5918')).toEqual([]);
  });

  it('rejects mixed separators', () => {
    expect(texts(R.nhsNumbers, 'NHS 943 476-5919')).toEqual([]);
  });
});

describe('bankDetails', () => {
  it('reports a sort code and account number together', () => {
    expect(found(R.bankDetails, 'Pay 20-00-00 41234567 please')).toEqual([
      ['SORT_CODE', '20-00-00', 0.95],
      ['BANK_ACCOUNT', '41234567', 0.95],
    ]);
  });

  it('reports each one on its own with a banking word', () => {
    expect(texts(R.bankDetails, 'sort code 200000')).toEqual(['200000']);
    expect(texts(R.bankDetails, 'account no. 41234567')).toEqual(['41234567']);
  });

  it('leaves a date-shaped or bare number alone without context', () => {
    expect(texts(R.bankDetails, 'Meeting 12-03-24 at noon')).toEqual([]);
    expect(texts(R.bankDetails, 'Ticket 41234567 is closed')).toEqual([]);
  });

  it('does not take a date with a year as a sort code', () => {
    expect(texts(R.bankDetails, 'bank holiday 12-03-2024')).toEqual([]);
  });
});

describe('ibans', () => {
  it('reports a grouped IBAN and stops before the next word', () => {
    expect(found(R.ibans, 'IBAN GB82 WEST 1234 5698 7654 32 thanks')).toEqual([
      ['IBAN', 'GB82 WEST 1234 5698 7654 32', 1],
    ]);
  });

  it('shortens a match that ran into a following capitalised reference', () => {
    // The pattern is greedy, so "REF" is swallowed; the check finds the real end.
    expect(texts(R.ibans, 'Pay GB82WEST12345698765432 REF 99')).toEqual(['GB82WEST12345698765432']);
  });

  it('rejects one whose check digits are wrong', () => {
    expect(texts(R.ibans, 'IBAN GB82 WEST 1234 5698 7654 33')).toEqual([]);
  });
});

describe('cards', () => {
  it('reports a card in groups, with dashes or none', () => {
    expect(
      texts(R.cards, '4111 1111 1111 1111 and 5555-5555-5555-4444 and 378282246310005')
    ).toEqual(['4111 1111 1111 1111', '5555-5555-5555-4444', '378282246310005']);
  });

  it('stops at the card when an expiry date follows it', () => {
    expect(texts(R.cards, 'Card 4111 1111 1111 1111 12 27')).toEqual(['4111 1111 1111 1111']);
  });

  it('finds a card written after a short group of other digits', () => {
    expect(texts(R.cards, 'Qty 2 4111 1111 1111 1111')).toEqual(['4111 1111 1111 1111']);
    expect(texts(R.cards, 'Item 12 4111111111111111')).toEqual(['4111111111111111']);
  });

  it('rejects a number that fails Luhn, or is not a card scheme', () => {
    expect(texts(R.cards, 'card 4111 1111 1111 1112')).toEqual([]);
    expect(texts(R.cards, 'ref 1234 5678 1234 5670')).toEqual([]);
  });
});

describe('utrs', () => {
  it('reports ten digits near a tax word', () => {
    expect(found(R.utrs, 'My UTR is 84720 19365')).toEqual([['UK_UTR', '84720 19365', 0.95]]);
    expect(texts(R.utrs, 'self assessment reference 8472019365K')).toEqual(['8472019365K']);
  });

  it('leaves ten digits alone without one', () => {
    expect(texts(R.utrs, 'Order 8472019365 shipped')).toEqual([]);
  });
});

describe('vatNumbers', () => {
  it('reports a GB-prefixed number that passes the check', () => {
    expect(found(R.vatNumbers, 'VAT GB 999 9999 73.')).toContainEqual([
      'UK_VAT',
      'GB 999 9999 73',
      1,
    ]);
    expect(texts(R.vatNumbers, 'reg GB086832870 ok')).toEqual(['GB086832870']);
  });

  it('reports a bare number only near "VAT"', () => {
    expect(texts(R.vatNumbers, 'VAT reg 999 9999 73')).toEqual(['999 9999 73']);
    expect(texts(R.vatNumbers, 'Order 999 9999 73')).toEqual([]);
  });

  it('rejects one that fails the check, prefixed or not', () => {
    expect(texts(R.vatNumbers, 'VAT GB 999 9999 74')).toEqual([]);
  });
});

describe('passports and drivingLicences', () => {
  it('reports nine digits only near "passport"', () => {
    expect(found(R.passports, 'Passport no. 519384726')).toEqual([
      ['UK_PASSPORT', '519384726', 0.95],
    ]);
    expect(texts(R.passports, 'Upload was 519384726 bytes')).toEqual([]);
  });

  it('reports a licence on its shape, and is certain with a licence word', () => {
    expect(found(R.drivingLicences, 'MORGA753116SM9IJ')).toEqual([
      ['UK_DRIVING_LICENCE', 'MORGA753116SM9IJ', 0.95],
    ]);
    expect(found(R.drivingLicences, 'driving licence MORGA753116SM9IJ 01')).toEqual([
      ['UK_DRIVING_LICENCE', 'MORGA753116SM9IJ 01', 1],
    ]);
  });

  it('rejects a licence-shaped run whose encoded date is impossible', () => {
    expect(texts(R.drivingLicences, 'MORGA713116SM9IJ')).toEqual([]);
  });
});

describe('ipAddresses', () => {
  it('reports IPv4 and IPv6 addresses', () => {
    expect(texts(R.ipAddresses, 'from 203.0.113.42 and 2001:db8:85a3::8a2e:370:7334.')).toEqual([
      '203.0.113.42',
      '2001:db8:85a3::8a2e:370:7334',
    ]);
  });

  it('leaves version numbers alone', () => {
    expect(texts(R.ipAddresses, 'Version 1.2.3.4, v10.0.0.1, build is 2.0.0.17')).toEqual([]);
  });

  it('refuses an octet over 255 and a fifth group', () => {
    expect(texts(R.ipAddresses, 'bad 256.1.1.1 and 1.2.3.4.5')).toEqual([]);
  });

  it('does not take a short hex word for an IPv6 address', () => {
    expect(texts(R.ipAddresses, 'Use cafe::1 now, or a:b::c, or dead::beef')).toEqual([]);
    expect(texts(R.ipAddresses, 'loopback ::1 and fe80::1 and fd12:3456::1')).toEqual([
      '::1',
      'fe80::1',
      'fd12:3456::1',
    ]);
  });

  it('does not take a time of day for an IPv6 address', () => {
    expect(texts(R.ipAddresses, 'at 12:30:45 sharp')).toEqual([]);
  });
});

describe('secrets', () => {
  // Built from parts so no credential-shaped literal sits in the source.
  const github = ['gh', 'p_', 'a1B2c3'.repeat(6)].join('');
  const aws = ['AK', 'IA', 'Q7XZ'.repeat(4)].join('');

  it('reports credentials with a published prefix, whole', () => {
    expect(found(R.secrets, `token ${github} and key ${aws}`)).toEqual(
      expect.arrayContaining([
        ['SECRET', github, 1],
        ['SECRET', aws, 1],
      ])
    );
  });

  it('reports a private key block from BEGIN to END', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEow', '-----END RSA PRIVATE KEY-----'].join(
      '\n'
    );
    expect(texts(R.secrets, `here:\n${pem}\nthanks`)).toEqual([pem]);
  });

  it('reports an assigned value only, without the name or the full stop', () => {
    expect(found(R.secrets, 'The password: hunter22x.')).toEqual([['SECRET', 'hunter22x', 0.9]]);
    expect(texts(R.secrets, 'api_key="abc123def456"')).toEqual(['abc123def456']);
  });

  it('keeps the punctuation when trimming it would leave too short a password', () => {
    expect(texts(R.secrets, 'password: Abc12! ok')).toEqual(['Abc12!']);
  });

  it('reports a value under a quoted key, as in JSON', () => {
    expect(texts(R.secrets, '{"password": "hunter22x", "client_secret":"s3cr3tvalue"}')).toEqual([
      'hunter22x',
      's3cr3tvalue',
    ]);
  });

  it('reports a value under an .env-style name with a prefix', () => {
    // An underscore is a word character, so a \\b before the name missed these.
    expect(texts(R.secrets, 'DB_PASSWORD=hunter22x')).toEqual(['hunter22x']);
    expect(texts(R.secrets, 'csrf_token=abcdef123456')).toEqual(['abcdef123456']);
    expect(texts(R.secrets, 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY')).toEqual([
      'wJalrXUtnFEMIK7MDENGbPxRfiCY',
    ]);
  });

  it('takes a word after a token label for a label, not a token', () => {
    expect(texts(R.secrets, 'Token: please see the attached')).toEqual([]);
    expect(texts(R.secrets, 'token: expired')).toEqual([]);
    // A password is taken whatever it looks like: weak ones are plain words.
    expect(texts(R.secrets, 'password: sunshine')).toEqual(['sunshine']);
  });

  it('ignores a value too short to be a credential', () => {
    expect(texts(R.secrets, 'password: abc')).toEqual([]);
  });

  it('masks a PIN, which is shorter than other credentials', () => {
    expect(found(R.secrets, 'PIN: 1234')).toEqual([['SECRET', '1234', 0.9]]);
    expect(texts(R.secrets, 'my pin is 4821.')).toEqual(['4821']);
    expect(texts(R.secrets, 'pin number 12')).toEqual([]);
  });

  it('after "is", masks only a value that looks like a credential', () => {
    expect(texts(R.secrets, 'the password is correct, but your token is expired')).toEqual([]);
    expect(texts(R.secrets, 'the password is Tr0ub4dor&3 for now')).toEqual(['Tr0ub4dor&3']);
  });
});

describe('datesOfBirth', () => {
  it.each(['14/03/1987', '14-03-87', '1987-03-14', '14th March 1987', 'March 14, 1987'])(
    'reports %s after a birth word',
    (date) => {
      expect(found(R.datesOfBirth, `Born on ${date}.`)).toEqual([['DATE_OF_BIRTH', date, 0.9]]);
    }
  );

  it('reads a year-first date, and a US date when its day makes the order plain', () => {
    expect(texts(R.datesOfBirth, 'born 1990/12/25')).toEqual(['1990/12/25']);
    expect(texts(R.datesOfBirth, 'born on 12/25/1990')).toEqual(['12/25/1990']);
  });

  it('accepts "the" and a dash between the birth word and the date', () => {
    expect(texts(R.datesOfBirth, 'born on the 3rd of May 1980')).toEqual(['3rd of May 1980']);
    expect(texts(R.datesOfBirth, 'Date of birth - 12/03/1980')).toEqual(['12/03/1980']);
  });

  it('accepts the common birth words', () => {
    for (const cue of ['DOB', 'D.O.B.', 'date of birth:', 'birthday is']) {
      expect(texts(R.datesOfBirth, `${cue} 01/02/1990`)).toEqual(['01/02/1990']);
    }
  });

  it('leaves every other date alone', () => {
    expect(texts(R.datesOfBirth, 'Invoice dated 14/03/2024, due 2024-04-14.')).toEqual([]);
  });
});

describe('offsets are UTF-16 code units', () => {
  it('covers the right text after astral characters', () => {
    // Each emoji is two UTF-16 code units: a code-point offset would be off by four here.
    const text = '😀🎉 a@example.com 🙏 TJ 33 15 36 A';
    expect(texts(R.emails, text)).toEqual(['a@example.com']);
    expect(texts(R.ninos, text)).toEqual(['TJ 33 15 36 A']);
  });
});

describe('rulesDetector', () => {
  const ctx = () => ({
    signal: new AbortController().signal,
    scopeId: 's',
    knownValues: [],
    priorSpans: [],
  });

  it('declares itself as core, in-process, with every type it reports', async () => {
    const detector = rulesDetector();
    expect(detector.id).toBe(RULES_DETECTOR_ID);
    expect(detector.id.startsWith('core.')).toBe(true);
    expect(detector.egress).toBe('in_process');
    const spans = await detector.detect(
      { text: 'a@example.com 020 7946 0958 TJ 33 15 36 A SW1A 1AA' },
      ctx()
    );
    expect(new Set(spans.map((s) => s.type))).toEqual(
      new Set(['EMAIL', 'PHONE', 'UK_NINO', 'POSTCODE'])
    );
    for (const s of spans) expect(RULES_ENTITY_TYPES).toContain(s.type);
  });

  it('rejects when its timeout expires during the work, rather than resolving late', async () => {
    // The runner's timeout is a timer. Synchronous work alone would resolve
    // before that timer could fire; once a time slice of work has passed, the
    // detector's turn on the event loop lets it fire, and the next signal
    // check rejects. The text is large enough for the work to pass a slice.
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('timed out')), 0);
    const text = 'Write to a@example.com or ring 020 7946 0958. '.repeat(12_000);
    await expect(
      rulesDetector().detect({ text }, { ...ctx(), signal: controller.signal })
    ).rejects.toThrow('timed out');
  });

  it('does not wait on the event loop when the work is quick', async () => {
    // A turn per recogniser would add at least a millisecond each to every call.
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await rulesDetector().detect({ text: 'a@example.com' }, ctx());
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('stops when its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(
      rulesDetector().detect({ text: 'a@example.com' }, { ...ctx(), signal: controller.signal })
    ).rejects.toThrow('gone');
  });
});
