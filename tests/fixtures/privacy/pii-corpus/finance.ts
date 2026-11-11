/** Finance conversations. Hand-written; every value invented. */
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const FINANCE_CASES: CorpusCase[] = [
  {
    id: 'finance-transfer',
    domain: 'finance',
    text: 'Please pay the deposit to Imogen Hargreaves, IBAN GB50 MIDL 4075 6734 4787 23, reference FLAT-12. If that fails, use sort code 07-50-61 and account 44785220.',
    labels: [
      { type: 'PERSON', value: 'Imogen Hargreaves' },
      { type: 'IBAN', value: 'GB50 MIDL 4075 6734 4787 23' },
      { type: 'SORT_CODE', value: '07-50-61' },
      { type: 'BANK_ACCOUNT', value: '44785220' },
    ],
  },
  {
    id: 'finance-self-assessment',
    domain: 'finance',
    text: "I'm filing my self assessment late. My UTR is 84720 19365 and my NI number is HL 51 92 84 D. The return is in my married name, Joanna Pryce.",
    labels: [
      { type: 'UK_UTR', value: '84720 19365' },
      { type: 'UK_NINO', value: 'HL 51 92 84 D' },
      { type: 'PERSON', value: 'Joanna Pryce' },
    ],
  },
  {
    id: 'finance-invoice',
    domain: 'finance',
    text: 'Invoice 2291 from Corrigan Joinery Ltd, VAT reg GB 086 8328 70. Remit to GB52 LOYD 2087 1583 4643 53. Queries to Sean Corrigan on 028 9649 6012.',
    labels: [
      { type: 'ORG', value: 'Corrigan Joinery Ltd' },
      { type: 'UK_VAT', value: 'GB 086 8328 70' },
      { type: 'IBAN', value: 'GB52 LOYD 2087 1583 4643 53' },
      { type: 'PERSON', value: 'Sean Corrigan' },
      { type: 'PHONE', value: '028 9649 6012' },
    ],
  },
  {
    id: 'finance-mortgage',
    domain: 'finance',
    text: 'Mortgage application for the property at 19 Mill Hill, Ludlow SY8 1BB. Applicant date of birth: 07.06.1985. Employer: Sefton & Rowe Surveyors LLP, annual salary £48,000.',
    labels: [
      { type: 'ADDRESS', value: '19 Mill Hill' },
      { type: 'POSTCODE', value: 'SY8 1BB' },
      { type: 'DATE_OF_BIRTH', value: '07.06.1985' },
      { type: 'ORG', value: 'Sefton & Rowe Surveyors LLP' },
    ],
  },
  {
    id: 'finance-card-dispute',
    domain: 'finance',
    text: 'I am disputing two payments on my Mastercard 5555-5555-5555-4444 from 12/10 and 14/10. My Amex 3782 822463 10005 was not affected.',
    labels: [
      { type: 'CARD_NUMBER', value: '5555-5555-5555-4444' },
      { type: 'CARD_NUMBER', value: '3782 822463 10005' },
    ],
  },
  {
    id: 'finance-eu-supplier',
    domain: 'finance',
    text: 'Our German supplier, Weber Feinmechanik GmbH, has asked us to pay DE89370400440532013000 from now on. The Irish office uses IE29AIBK93115212345678.',
    labels: [
      { type: 'ORG', value: 'Weber Feinmechanik GmbH' },
      { type: 'IBAN', value: 'DE89370400440532013000' },
      { type: 'IBAN', value: 'IE29AIBK93115212345678' },
    ],
  },
  {
    id: 'finance-payroll-bureau',
    domain: 'finance',
    text: 'Bureau checklist: client VAT 873 5470 43, client UTR 61029 48371, contact Hannah Oyelaran. HMRC has the 64-8 on file.',
    labels: [
      { type: 'UK_VAT', value: '873 5470 43' },
      { type: 'UK_UTR', value: '61029 48371' },
      { type: 'PERSON', value: 'Hannah Oyelaran' },
    ],
  },
];
