/**
 * Template-generated cases: each template is filled from the pools below in
 * a fixed rotation, so the set is the same on every run and every value is
 * labelled by construction.
 *
 * The pools are invented. Names mix the backgrounds a UK install sees;
 * checksum identifiers were generated to pass their check.
 */
import type {
  CorpusCase,
  CorpusDomain,
  CorpusLabel,
} from '@/tests/fixtures/privacy/pii-corpus/types';

const PEOPLE = [
  ['Olivia', 'Brennan'],
  ['Mohammed', 'Siddiqui'],
  ['Eleanor', 'Whitcombe'],
  ['Kwame', 'Asante'],
  ['Zofia', 'Nowakowska'],
  ['Hamish', 'Drummond'],
  ['Anjali', 'Mehta'],
  ['Connor', 'Byrne'],
  ['Lucia', 'Ferrari'],
  ['Dylan', 'Prosser'],
  ['Amara', 'Eze'],
  ['Freddie', 'Ashworth'],
] as const;

const EMAIL_DOMAINS = ['example.com', 'example.co.uk', 'example.org', 'mail.example'];
const PHONES = [
  '07700 900111',
  '020 7946 0832',
  '0161 496 0254',
  '0117 496 0789',
  '+44 7700 900943',
  '0131 496 0055',
];
const STREETS = [
  ['12', 'Larkspur Avenue', 'Coventry', 'CV3 6GH'],
  ['7', 'Carrow Road', 'Norwich', 'NR1 1JE'],
  ['221', 'Baker Street', 'London', 'NW1 6XE'],
  ['3a', 'Thornfield Grove', 'Durham', 'DH1 4PQ'],
  ['56', 'Elmbank Crescent', 'Glasgow', 'G2 4NQ'],
  ['18', 'Penrhyn Terrace', 'Bangor', 'LL57 1RF'],
] as const;
const NHS = ['780 436 4636', '642 993 3733', '617 831 4930', '461 989 6071', '699 246 9444'];
const NINOS = ['OM 74 03 59 C', 'YY 90 26 97 B', 'EA 22 46 61 D', 'WA 58 12 26 D', 'ER 43 34 79 D'];
const IBANS = [
  'GB03 MIDL 2762 0956 3782 60',
  'GB50 HBUK 1433 5510 9267 84',
  'GB31 HBUK 0546 4147 8352 15',
  'GB34 NWBK 2738 1777 7522 02',
];
const COMPANIES = [
  'Fenwick Brothers Ltd',
  'Calder Valley Plastics Limited',
  'Oakridge Dental LLP',
  'Brackenbury Homes PLC',
];

interface Fill {
  first: string;
  last: string;
  email: string;
  phone: string;
  street: readonly [string, string, string, string];
  nhs: string;
  nino: string;
  iban: string;
  company: string;
  colleague: string;
}

interface Template {
  domain: CorpusDomain;
  render(f: Fill): { text: string; labels: CorpusLabel[] };
}

const person = (value: string): CorpusLabel => ({ type: 'PERSON', value });

const TEMPLATES: Template[] = [
  {
    domain: 'support',
    render: (f) => ({
      text: `Hello, this is ${f.first} ${f.last}. My order hasn't arrived at ${f.street[0]} ${f.street[1]}, ${f.street[2]} ${f.street[3]}. Please call me on ${f.phone}.`,
      labels: [
        person(`${f.first} ${f.last}`),
        { type: 'ADDRESS', value: `${f.street[0]} ${f.street[1]}` },
        { type: 'POSTCODE', value: f.street[3] },
        { type: 'PHONE', value: f.phone },
      ],
    }),
  },
  {
    domain: 'support',
    render: (f) => ({
      text: `Can you resend the invoice to ${f.email}? Thanks, ${f.first}`,
      labels: [{ type: 'EMAIL', value: f.email }, person(f.first)],
    }),
  },
  {
    domain: 'hr',
    render: (f) => ({
      text: `${f.first} ${f.last} starts on Monday. NI number ${f.nino}. Their buddy will be ${f.colleague}.`,
      labels: [
        person(`${f.first} ${f.last}`),
        { type: 'UK_NINO', value: f.nino },
        person(f.colleague),
      ],
    }),
  },
  {
    domain: 'hr',
    render: (f) => ({
      text: `Absence update: ${f.first} called in sick today. ${f.colleague} is covering. Please don't share this outside the team.`,
      labels: [person(f.first), person(f.colleague)],
    }),
  },
  {
    domain: 'health',
    render: (f) => ({
      text: `Patient ${f.first} ${f.last}, NHS number ${f.nhs}, was seen in clinic. Letter to follow to ${f.street[0]} ${f.street[1]}, ${f.street[3]}.`,
      labels: [
        person(`${f.first} ${f.last}`),
        { type: 'NHS_NUMBER', value: f.nhs },
        { type: 'ADDRESS', value: `${f.street[0]} ${f.street[1]}` },
        { type: 'POSTCODE', value: f.street[3] },
      ],
    }),
  },
  {
    domain: 'finance',
    render: (f) => ({
      text: `Refund of £120 approved for ${f.first} ${f.last}. Pay to ${f.iban} and email the remittance to ${f.email}.`,
      labels: [
        person(`${f.first} ${f.last}`),
        { type: 'IBAN', value: f.iban },
        { type: 'EMAIL', value: f.email },
      ],
    }),
  },
  {
    domain: 'b2b',
    render: (f) => ({
      text: `Intro: ${f.first} ${f.last} is the new account manager at ${f.company}. Reach them on ${f.phone} or ${f.email}.`,
      labels: [
        person(`${f.first} ${f.last}`),
        { type: 'ORG', value: f.company },
        { type: 'PHONE', value: f.phone },
        { type: 'EMAIL', value: f.email },
      ],
    }),
  },
  {
    domain: 'b2b',
    render: (f) => ({
      text: `Dear ${f.last},\n\nThank you for meeting us. We will send the proposal to ${f.company} this week.\n\nBest regards,\n${f.colleague}`,
      labels: [person(f.last), { type: 'ORG', value: f.company }, person(f.colleague)],
    }),
  },
];

/** How many fills of each template. */
const FILLS_PER_TEMPLATE = 6;

function fill(i: number): Fill {
  const [first, last] = PEOPLE[i % PEOPLE.length];
  const [cFirst, cLast] = PEOPLE[(i + 5) % PEOPLE.length];
  return {
    first,
    last,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${EMAIL_DOMAINS[i % EMAIL_DOMAINS.length]}`,
    phone: PHONES[i % PHONES.length],
    street: STREETS[i % STREETS.length],
    nhs: NHS[i % NHS.length],
    nino: NINOS[i % NINOS.length],
    iban: IBANS[i % IBANS.length],
    company: COMPANIES[i % COMPANIES.length],
    colleague: `${cFirst} ${cLast}`,
  };
}

export const TEMPLATE_CASES: CorpusCase[] = TEMPLATES.flatMap((template, t) =>
  Array.from({ length: FILLS_PER_TEMPLATE }, (_, n) => {
    const { text, labels } = template.render(fill(t * 3 + n));
    return { id: `template-${t + 1}-${n + 1}`, domain: template.domain, text, labels };
  })
);
