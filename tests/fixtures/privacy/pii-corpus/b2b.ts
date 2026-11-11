/** Business-to-business conversations. Hand-written; every value invented. */
import { FAKE_SECRETS } from '@/tests/fixtures/privacy/pii-corpus/fake-secrets';
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const B2B_CASES: CorpusCase[] = [
  {
    id: 'b2b-sales-email',
    domain: 'b2b',
    text: 'Following up on the demo: Priya at Northwind Analytics Ltd wants pricing for 40 seats. Her direct line is 0113 496 0123 and her email is priya.raman@northwind.example.',
    labels: [
      { type: 'PERSON', value: 'Priya' },
      { type: 'ORG', value: 'Northwind Analytics Ltd' },
      { type: 'PHONE', value: '0113 496 0123' },
      { type: 'EMAIL', value: 'priya.raman@northwind.example' },
    ],
  },
  {
    id: 'b2b-contract',
    domain: 'b2b',
    text: 'This agreement is between Brightfield Systems Limited (company number 09876543) and Halden Logistics Ltd. Halden will provide warehousing; Brightfield will provide the software.',
    labels: [
      { type: 'ORG', value: 'Brightfield Systems Limited' },
      { type: 'ORG', value: 'Halden Logistics Ltd' },
      { type: 'ORG', value: 'Halden', occurrence: 2 },
      { type: 'ORG', value: 'Brightfield', occurrence: 2 },
    ],
  },
  {
    id: 'b2b-ticket-api-key',
    domain: 'b2b',
    text: `Our integration stopped working this morning. We're calling the API with key ${FAKE_SECRETS.anthropic} and also tried the backup ${FAKE_SECRETS.openai}. Error 401 both times.`,
    labels: [
      { type: 'SECRET', value: FAKE_SECRETS.anthropic },
      { type: 'SECRET', value: FAKE_SECRETS.openai },
    ],
  },
  {
    id: 'b2b-crm-notes',
    domain: 'b2b',
    text: 'Call notes: spoke with Rowena Blackwood, procurement lead. Rowena found us on LinkedIn and is comparing us with Salesforce. Budget sign-off sits with her CFO, Martin Osei.',
    labels: [
      { type: 'PERSON', value: 'Rowena Blackwood' },
      { type: 'PERSON', value: 'Rowena', occurrence: 2 },
      { type: 'PERSON', value: 'Martin Osei' },
    ],
  },
  {
    id: 'b2b-meeting-attendees',
    domain: 'b2b',
    text: 'Attendees: Tom Ellis, Grace Okafor, Will Patel, Yusuf Demir\nApologies: Bethany Cole\nActions: Will to send the revised SOW by Friday.',
    labels: [
      { type: 'PERSON', value: 'Tom Ellis' },
      { type: 'PERSON', value: 'Grace Okafor' },
      { type: 'PERSON', value: 'Will Patel' },
      { type: 'PERSON', value: 'Yusuf Demir' },
      { type: 'PERSON', value: 'Bethany Cole' },
      { type: 'PERSON', value: 'Will', occurrence: 2 },
    ],
  },
  {
    id: 'b2b-server-logs',
    domain: 'b2b',
    text: '2026-11-02T09:14:03Z login ok user=m.ferreira@acme.example ip=203.0.113.42\n2026-11-02T09:15:11Z login failed user=k.boateng@acme.example ip=2001:db8:85a3::8a2e:370:7334',
    labels: [
      { type: 'EMAIL', value: 'm.ferreira@acme.example' },
      { type: 'IP_ADDRESS', value: '203.0.113.42' },
      { type: 'EMAIL', value: 'k.boateng@acme.example' },
      { type: 'IP_ADDRESS', value: '2001:db8:85a3::8a2e:370:7334' },
    ],
  },
  {
    id: 'b2b-pasted-headers',
    domain: 'b2b',
    text: `Here is the failing request:\nAuthorization: Bearer ${FAKE_SECRETS.jwt}\nX-Api-Key: ${FAKE_SECRETS.stripe}\nAWS key ${FAKE_SECRETS.aws} was rotated yesterday; the GitHub token ${FAKE_SECRETS.github} is still live and so is the Slack bot ${FAKE_SECRETS.slack}.`,
    labels: [
      { type: 'SECRET', value: FAKE_SECRETS.jwt },
      { type: 'SECRET', value: FAKE_SECRETS.stripe },
      { type: 'SECRET', value: FAKE_SECRETS.aws },
      { type: 'SECRET', value: FAKE_SECRETS.github },
      { type: 'SECRET', value: FAKE_SECRETS.slack },
    ],
  },
  {
    id: 'b2b-protected-term',
    domain: 'b2b',
    text: 'Project Kingfisher is on track; the Kingfisher pilot with Marlowe Freight goes live next week. Ask Dimitri Vlahos if you need access.',
    knownValues: [
      { type: 'ORG', value: 'Kingfisher' },
      { type: 'ORG', value: 'Marlowe Freight Ltd' },
    ],
    labels: [
      { type: 'ORG', value: 'Kingfisher' },
      { type: 'ORG', value: 'Marlowe Freight' },
      { type: 'PERSON', value: 'Dimitri Vlahos' },
    ],
  },
  {
    id: 'b2b-supplier-onboarding',
    domain: 'b2b',
    text: 'Supplier onboarding: Ashgrove Print & Packaging Ltd, VAT GB 180 6572 00, 14 Riverside Park, Swansea SA1 8QY. Accounts contact: Carys Llewellyn, carys@ashgrove.example.',
    labels: [
      { type: 'ORG', value: 'Ashgrove Print & Packaging Ltd' },
      { type: 'UK_VAT', value: 'GB 180 6572 00' },
      { type: 'ADDRESS', value: '14 Riverside Park' },
      { type: 'POSTCODE', value: 'SA1 8QY' },
      { type: 'PERSON', value: 'Carys Llewellyn' },
      { type: 'EMAIL', value: 'carys@ashgrove.example' },
    ],
  },
];
