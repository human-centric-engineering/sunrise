/** Customer support conversations. Hand-written; every value invented. */
import { FAKE_SECRETS } from '@/tests/fixtures/privacy/pii-corpus/fake-secrets';
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const SUPPORT_CASES: CorpusCase[] = [
  {
    id: 'support-delivery',
    domain: 'support',
    text: "Hi, my parcel hasn't arrived. Order 58213 was meant to come Tuesday. It's for Gemma Thornton at 27 Wellfield Road, Sheffield S10 3TR. You can reach me on 0114 496 0372 or gemma.thornton@example.co.uk.",
    labels: [
      { type: 'PERSON', value: 'Gemma Thornton' },
      { type: 'ADDRESS', value: '27 Wellfield Road' },
      { type: 'POSTCODE', value: 'S10 3TR' },
      { type: 'PHONE', value: '0114 496 0372' },
      { type: 'EMAIL', value: 'gemma.thornton@example.co.uk' },
    ],
  },
  {
    id: 'support-account-recovery',
    domain: 'support',
    text: "I can't log in. The account email is d.okonjo@example.com and my date of birth is 03/11/1979. The card on file ends 4242 if that helps.",
    labels: [
      { type: 'EMAIL', value: 'd.okonjo@example.com' },
      { type: 'DATE_OF_BIRTH', value: '03/11/1979' },
    ],
  },
  {
    id: 'support-refund-card',
    domain: 'support',
    text: 'Please refund to the same card: 4000 0566 5566 5556, expiry 09/28. Name on the card is Rhys Pritchard.',
    labels: [
      { type: 'CARD_NUMBER', value: '4000 0566 5566 5556' },
      { type: 'PERSON', value: 'Rhys Pritchard' },
    ],
  },
  {
    id: 'support-change-address',
    domain: 'support',
    text: 'We have moved from 8 Orchard Close, Bristol BS7 9QA to Flat 4, 112 Gloucester Road, Bristol BS7 8AE. Please update both the billing and delivery address.',
    labels: [
      { type: 'ADDRESS', value: '8 Orchard Close' },
      { type: 'POSTCODE', value: 'BS7 9QA' },
      { type: 'ADDRESS', value: 'Flat 4, 112 Gloucester Road' },
      { type: 'POSTCODE', value: 'BS7 8AE' },
    ],
  },
  {
    id: 'support-complaint-staff',
    domain: 'support',
    text: 'I want to complain about the agent I spoke to on Monday, Callum. He said a manager called Deborah Fairley would ring me back and nobody did.',
    labels: [
      { type: 'PERSON', value: 'Callum' },
      { type: 'PERSON', value: 'Deborah Fairley' },
    ],
  },
  {
    id: 'support-broadband',
    domain: 'support',
    text: `My router keeps dropping. Its address is 192.168.1.254 and my public IP shows as 81.2.69.160. The admin password: ${FAKE_SECRETS.password} — I know, I should change it.`,
    labels: [
      { type: 'IP_ADDRESS', value: '192.168.1.254' },
      { type: 'IP_ADDRESS', value: '81.2.69.160' },
      { type: 'SECRET', value: FAKE_SECRETS.password },
    ],
  },
  {
    id: 'support-emoji-offsets',
    domain: 'support',
    text: '😀🎉 Thanks so much!! 🙏 Please send the receipt to 🙂 harriet.lowe@example.org and text me on 07700 900481 when it ships 📦',
    labels: [
      { type: 'EMAIL', value: 'harriet.lowe@example.org' },
      { type: 'PHONE', value: '07700 900481' },
    ],
  },
  {
    id: 'support-lowercase-name',
    domain: 'support',
    text: 'hi its sarah from leeds, my order still hasnt come. can you ring me on 0113 496 0911',
    labels: [
      // Tier C works on capitalised words, so this name is a recorded miss.
      { type: 'PERSON', value: 'sarah' },
      { type: 'PHONE', value: '0113 496 0911' },
    ],
  },
  {
    id: 'support-known-user',
    domain: 'support',
    text: 'my name is jo bloggs and my number is +44 7700 900 515. jo is fine to call me.',
    knownValues: [
      { type: 'PERSON', value: 'Jo Bloggs' },
      { type: 'PHONE', value: '07700900515' },
    ],
    labels: [
      { type: 'PERSON', value: 'jo bloggs' },
      { type: 'PHONE', value: '+44 7700 900 515' },
      // A two-letter first name is below tier B's variant length.
      { type: 'PERSON', value: 'jo', occurrence: 2 },
    ],
  },
  {
    id: 'support-international-phone',
    domain: 'support',
    text: 'I am travelling, so please call my French mobile, +33 6 12 34 56 78, not the UK one. My name is Anaïs Duval.',
    labels: [
      { type: 'PHONE', value: '+33 6 12 34 56 78' },
      { type: 'PERSON', value: 'Anaïs Duval' },
    ],
  },
  {
    id: 'support-signature',
    domain: 'support',
    text: 'The replacement kettle works, thank you for sorting it so quickly.\n\nKind regards,\nMarcus Achterberg',
    labels: [{ type: 'PERSON', value: 'Marcus Achterberg' }],
  },
  {
    id: 'support-titled-names',
    domain: 'support',
    text: 'Mrs Adeyemi phoned on behalf of her father, Mr Kowalczyk, who cannot use the website. She asked us to post the forms.',
    labels: [
      { type: 'PERSON', value: 'Adeyemi' },
      { type: 'PERSON', value: 'Kowalczyk' },
    ],
  },
];
