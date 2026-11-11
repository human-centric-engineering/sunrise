/** HR conversations. Hand-written; every value invented. */
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const HR_CASES: CorpusCase[] = [
  {
    id: 'hr-sickness',
    domain: 'hr',
    text: 'Leanne Carver has been signed off for four weeks. Her manager, Oliver Dunmore, will cover the rota. Her National Insurance number is TJ 33 15 36 A for the SSP claim.',
    labels: [
      { type: 'PERSON', value: 'Leanne Carver' },
      { type: 'PERSON', value: 'Oliver Dunmore' },
      { type: 'UK_NINO', value: 'TJ 33 15 36 A' },
    ],
  },
  {
    id: 'hr-payroll-bank',
    domain: 'hr',
    text: 'New starter bank details for payroll: sort code 40-47-84, account number 31926819, NI no EP509054B. Start date 1 March.',
    labels: [
      { type: 'SORT_CODE', value: '40-47-84' },
      { type: 'BANK_ACCOUNT', value: '31926819' },
      { type: 'UK_NINO', value: 'EP509054B' },
    ],
  },
  {
    id: 'hr-disciplinary',
    domain: 'hr',
    text: 'Notes from the investigation meeting: present were Fatima Rahman (HR), Daniel Whitlock (investigating manager) and the employee, Kieran Moss. Kieran was born on 22 July 1994 and joined in 2019.',
    labels: [
      { type: 'PERSON', value: 'Fatima Rahman' },
      { type: 'PERSON', value: 'Daniel Whitlock' },
      { type: 'PERSON', value: 'Kieran Moss' },
      { type: 'PERSON', value: 'Kieran', occurrence: 2 },
      { type: 'DATE_OF_BIRTH', value: '22 July 1994' },
    ],
  },
  {
    id: 'hr-right-to-work',
    domain: 'hr',
    text: "For the right-to-work check I've attached my passport, number 519384726, and my driving licence MORGA753116SM9IJ. Contact me on 07700 900322 or at 5 Kestrel Way, Norwich NR4 7TJ.",
    labels: [
      { type: 'UK_PASSPORT', value: '519384726' },
      { type: 'UK_DRIVING_LICENCE', value: 'MORGA753116SM9IJ' },
      { type: 'PHONE', value: '07700 900322' },
      { type: 'ADDRESS', value: '5 Kestrel Way' },
      { type: 'POSTCODE', value: 'NR4 7TJ' },
    ],
  },
  {
    id: 'hr-reference',
    domain: 'hr',
    text: 'I am happy to provide a reference for Ewan McAllister, who worked for us as a warehouse supervisor.\n\nYours sincerely,\nPriyanka Desai\nOperations Director',
    labels: [
      { type: 'PERSON', value: 'Ewan McAllister' },
      { type: 'PERSON', value: 'Priyanka Desai' },
    ],
  },
  {
    id: 'hr-leaver',
    domain: 'hr',
    text: "Please send Tomasz's P45 to his personal email, tomasz.wojcik@example.net, and his final payslip to 41 Brook Street, Leicester LE2 1QP.",
    labels: [
      { type: 'PERSON', value: 'Tomasz' },
      { type: 'EMAIL', value: 'tomasz.wojcik@example.net' },
      { type: 'ADDRESS', value: '41 Brook Street' },
      { type: 'POSTCODE', value: 'LE2 1QP' },
    ],
  },
  {
    id: 'hr-reporting-line',
    domain: 'hr',
    text: 'From April the support team will report to Aisha Khan (Head of Operations) instead of Graham Pell, who is moving to the Glasgow office.',
    labels: [
      { type: 'PERSON', value: 'Aisha Khan' },
      { type: 'PERSON', value: 'Graham Pell' },
    ],
  },
  {
    id: 'hr-redundancy',
    domain: 'hr',
    text: 'The roles at risk are held by Niamh Gallagher, Bilal Hussain and Chloe Featherstone. Consultation starts on Monday; Acas guidance has been shared.',
    labels: [
      { type: 'PERSON', value: 'Niamh Gallagher' },
      { type: 'PERSON', value: 'Bilal Hussain' },
      { type: 'PERSON', value: 'Chloe Featherstone' },
    ],
  },
  {
    id: 'hr-known-employee',
    domain: 'hr',
    text: 'Can you check whether S. Okoro has enough holiday left? Okoro wants the last week of August off.',
    knownValues: [{ type: 'PERSON', value: 'Samuel Okoro' }],
    labels: [
      { type: 'PERSON', value: 'S. Okoro' },
      { type: 'PERSON', value: 'Okoro', occurrence: 2 },
    ],
  },
];
