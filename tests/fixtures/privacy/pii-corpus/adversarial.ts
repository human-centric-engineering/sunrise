/**
 * False-positive traps: text that looks like personal data and is not.
 * Most cases have no labels at all, so anything detected in them counts
 * against precision. A few mix real values in, to check a trap beside a real
 * value does not hide it.
 */
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

export const ADVERSARIAL_CASES: CorpusCase[] = [
  {
    id: 'adv-modal-verbs',
    domain: 'adversarial',
    text: 'May I ask whether the meeting can move? Will you confirm by Friday? Mark the date in the diary, and Grant applications close in June.',
    labels: [],
  },
  {
    id: 'adv-versions',
    domain: 'adversarial',
    text: 'Version 1.2.3.4 fixed the crash, and v10.0.0.1 is in testing. The build is 2.0.0.17.',
    labels: [],
  },
  {
    id: 'adv-order-numbers',
    domain: 'adversarial',
    text: 'Order 4829301756 has shipped with tracking 1Z999AA10123456784. Your basket reference is 7731 0042 9918 and the SKU is AB123456.',
    labels: [],
  },
  {
    id: 'adv-invalid-checksums',
    domain: 'adversarial',
    text: 'These failed validation: NHS number 943 476 5918, IBAN GB82 WEST 1234 5698 7654 33, card 4111 1111 1111 1112, VAT GB 999 9999 74.',
    labels: [],
  },
  {
    id: 'adv-places',
    domain: 'adversarial',
    text: 'We have offices in Reading, Bath and Wells. Victoria station was busy, and the Chelsea branch opens in Kent next spring.',
    labels: [],
  },
  {
    id: 'adv-brands-and-bodies',
    domain: 'adversarial',
    text: 'We use Microsoft Teams, Slack and Xero. HMRC and the NHS were both mentioned, and Claude helped draft the reply. Apple and Amazon reported earnings.',
    labels: [],
  },
  {
    id: 'adv-dates-not-births',
    domain: 'adversarial',
    text: 'Invoice dated 14/03/2024, due 2024-04-14. The meeting on 12-03-24 moved to 3 April 2025.',
    labels: [],
  },
  {
    id: 'adv-numbers-without-context',
    domain: 'adversarial',
    text: 'The upload was 123456789 bytes. Ratio 12-34-56 is in cell B4. Call 999 or 111 in an emergency. The room holds 40.',
    labels: [],
  },
  {
    id: 'adv-code',
    domain: 'adversarial',
    text: 'const max = Math.max(a, b);\nlet page = 1;\nif (user.isAdmin) { return grant(user); }\nexport default Will;',
    labels: [],
  },
  {
    id: 'adv-times-and-hashes',
    domain: 'adversarial',
    text: 'Started 12:30:45, finished 13:02:11. Commit 9f8e7d6 fixed it; the checksum is ab:cd:ef:01.',
    labels: [],
  },
  {
    id: 'adv-standards',
    domain: 'adversarial',
    text: 'We are certified to ISO 27001 and BS 7799, and follow GDPR Article 28. The M1 and A1 were both closed.',
    labels: [],
  },
  {
    id: 'adv-prices',
    domain: 'adversarial',
    text: 'The quote is £1,234.56 plus VAT, or £12,345 for three years. Line 4 of the spreadsheet shows 1234 5678.',
    labels: [],
  },
  {
    id: 'adv-sentence-start-words',
    domain: 'adversarial',
    text: 'Hope this helps. Many thanks for your patience. Faith in the process is low. Sterling fell against the dollar.',
    labels: [],
  },
  {
    id: 'adv-programming-languages',
    domain: 'adversarial',
    text: 'The backend is Ruby, the data team uses Julia and Scala, and the old reports are in Perl.',
    labels: [],
  },
  {
    id: 'adv-mixed-real-and-traps',
    domain: 'adversarial',
    text: 'Version 4.1.2.0 is out. Ask Josephine Wainwright (josephine.w@example.com) whether May works for the Reading launch.',
    labels: [
      { type: 'PERSON', value: 'Josephine Wainwright' },
      { type: 'EMAIL', value: 'josephine.w@example.com' },
    ],
  },
  {
    id: 'adv-street-names-alone',
    domain: 'adversarial',
    text: 'Our shop is on the High Street, near Victoria Road station; the bus stops on Station Road.',
    labels: [],
  },
  {
    id: 'adv-greetings',
    domain: 'adversarial',
    text: 'Hi Team,\n\nDear Sir or Madam, hello there — thanks all for the quick turnaround.\n\nBest,\nThe Support Team',
    labels: [],
  },
];
