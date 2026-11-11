/** Health and care conversations. Hand-written; every value invented. */
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const HEALTH_CASES: CorpusCase[] = [
  {
    id: 'health-referral',
    domain: 'health',
    text: 'Referral for Margaret Ellison, NHS number 699 910 0438, DOB 14/02/1948, of 3 Chapel Lane, Harrogate HG2 0LT. Seen today by Dr Venkataraman for recurrent falls.',
    labels: [
      { type: 'PERSON', value: 'Margaret Ellison' },
      { type: 'NHS_NUMBER', value: '699 910 0438' },
      { type: 'DATE_OF_BIRTH', value: '14/02/1948' },
      { type: 'ADDRESS', value: '3 Chapel Lane' },
      { type: 'POSTCODE', value: 'HG2 0LT' },
      { type: 'PERSON', value: 'Venkataraman' },
    ],
  },
  {
    id: 'health-pharmacy-bare-nhs',
    domain: 'health',
    text: 'The pharmacy needs the NHS no 6446054815 before they can release the prescription for my mum.',
    labels: [{ type: 'NHS_NUMBER', value: '6446054815' }],
  },
  {
    id: 'health-care-home',
    domain: 'health',
    text: 'Resident Albert Grimshaw had a quiet night. His daughter, Lorraine, asked to be called on 01632 960 471 if anything changes.',
    labels: [
      { type: 'PERSON', value: 'Albert Grimshaw' },
      { type: 'PERSON', value: 'Lorraine' },
      { type: 'PHONE', value: '01632 960 471' },
    ],
  },
  {
    id: 'health-therapy',
    domain: 'health',
    text: "I've been seeing my therapist, Dr Halvorsen, since January. My partner Jamie thinks the new medication is helping.",
    labels: [
      { type: 'PERSON', value: 'Halvorsen' },
      { type: 'PERSON', value: 'Jamie' },
    ],
  },
  {
    id: 'health-appointment',
    domain: 'health',
    text: 'Booking for Ifeoma Nwosu, patient 719 550 7297. She lives at 60 Moorland Drive, Leeds LS17 6HX and prefers morning appointments.',
    labels: [
      { type: 'PERSON', value: 'Ifeoma Nwosu' },
      { type: 'NHS_NUMBER', value: '719 550 7297' },
      { type: 'ADDRESS', value: '60 Moorland Drive' },
      { type: 'POSTCODE', value: 'LS17 6HX' },
    ],
  },
  {
    id: 'health-discharge',
    domain: 'health',
    text: 'Discharge summary: Mr Dennis Fairweather, born 30 September 1952, NHS 664 181 4912. Follow-up with Ms Abernethy (cardiology) in six weeks.',
    labels: [
      { type: 'PERSON', value: 'Dennis Fairweather' },
      { type: 'DATE_OF_BIRTH', value: '30 September 1952' },
      { type: 'NHS_NUMBER', value: '664 181 4912' },
      { type: 'PERSON', value: 'Abernethy' },
    ],
  },
  {
    id: 'health-next-of-kin',
    domain: 'health',
    text: 'Next of kin: Graham Lister (husband), mobile 07700 900618, email graham.lister@example.co.uk.',
    labels: [
      { type: 'PERSON', value: 'Graham Lister' },
      { type: 'PHONE', value: '07700 900618' },
      { type: 'EMAIL', value: 'graham.lister@example.co.uk' },
    ],
  },
];
