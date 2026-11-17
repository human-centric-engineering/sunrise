/**
 * The development confidential-content corpus (§130, t-1036).
 *
 * Written alongside the phrase list, so it measures the cases the list was
 * designed for; the held-out set (`held-out.ts`) is the closer estimate of how
 * it does on text nobody tuned it for. Every message is invented.
 */
import type { SensitivityCorpusCase } from '@/tests/fixtures/privacy/sensitivity-corpus/types';

export const DEVELOPMENT_CASES: SensitivityCorpusCase[] = [
  // --- health -------------------------------------------------------------
  {
    id: 'dev-health-1',
    text: "I've been signed off with depression, how do I tell my manager?",
    categories: ['health'],
  },
  {
    id: 'dev-health-2',
    text: 'My colleague Priya was diagnosed with breast cancer last month and starts chemo on Monday. How should we cover her accounts?',
    categories: ['health'],
  },
  {
    id: 'dev-health-3',
    text: "Draft a note to the team saying Tom is off sick for two weeks after his operation. Don't say what it was.",
    categories: ['health'],
  },
  {
    id: 'dev-health-4',
    text: "I'm 14 weeks pregnant and haven't told work yet. When do I legally have to?",
    categories: ['health'],
  },
  {
    id: 'dev-health-5',
    text: 'Our new starter is autistic and has asked for reasonable adjustments to the open-plan seating.',
    categories: ['health'],
  },
  {
    id: 'dev-health-6',
    text: 'my son has ADHD and the school keeps calling, can you help me write to them',
    categories: ['health'],
  },
  {
    id: 'dev-health-7',
    text: 'Sam has been struggling with mental health issues and panic attacks since the restructure was mentioned to her team.',
    categories: ['health', 'restructuring'],
  },
  // --- ethnicity ----------------------------------------------------------
  {
    id: 'dev-ethnicity-1',
    text: 'One of the warehouse team says he has been subjected to racial abuse by a supervisor.',
    categories: ['ethnicity'],
  },
  {
    id: 'dev-ethnicity-2',
    text: 'She is of Nigerian heritage and feels she was passed over because of it.',
    categories: ['ethnicity'],
  },
  {
    id: 'dev-ethnicity-3',
    text: 'Can you summarise the ethnicity breakdown for these five named candidates before the panel meets?',
    categories: ['ethnicity'],
  },
  // --- religion -----------------------------------------------------------
  {
    id: 'dev-religion-1',
    text: 'Aisha is fasting for Ramadan, can we move her review away from lunchtime?',
    categories: ['religion'],
  },
  {
    id: 'dev-religion-2',
    text: 'He is a devout Catholic and has asked not to work on Sundays.',
    categories: ['religion'],
  },
  {
    id: 'dev-religion-3',
    text: 'A Sikh colleague was told to remove his turban for the site photo and is upset; he says it was religious discrimination.',
    categories: ['religion'],
  },
  // --- politics -----------------------------------------------------------
  {
    id: 'dev-politics-1',
    text: 'My manager found out I voted Reform and now he barely speaks to me.',
    categories: ['politics'],
  },
  {
    id: 'dev-politics-2',
    text: 'Dan is a Labour councillor in his spare time; does that create a conflict with the council contract?',
    categories: ['politics'],
  },
  {
    id: 'dev-politics-3',
    text: 'Write a polite reply to Jo, who keeps sharing her political views in the client channel.',
    categories: ['politics'],
  },
  // --- trade_union --------------------------------------------------------
  {
    id: 'dev-union-1',
    text: "I'm the Unison rep for the depot and need to prepare for Thursday's meeting with management.",
    categories: ['trade_union'],
  },
  {
    id: 'dev-union-2',
    text: 'Three of the drivers joined the union last week and want to bring a rep to their meetings.',
    categories: ['trade_union'],
  },
  {
    id: 'dev-union-3',
    text: 'Staff at the Leeds site have voted for industrial action over the pay offer.',
    categories: ['trade_union'],
  },
  // --- sexuality ----------------------------------------------------------
  {
    id: 'dev-sexuality-1',
    text: 'Marcus came out as gay to the team last week and someone has been making comments since.',
    categories: ['sexuality'],
  },
  {
    id: 'dev-sexuality-2',
    text: "A colleague is transitioning and wants to change the name on her email account. What's the process?",
    categories: ['sexuality'],
  },
  {
    id: 'dev-sexuality-3',
    text: "He thinks people are gossiping about his sexuality and doesn't want to come into the office.",
    categories: ['sexuality'],
  },
  // --- criminal -----------------------------------------------------------
  {
    id: 'dev-criminal-1',
    text: 'A candidate disclosed an unspent conviction for theft on his application. Can we still offer him the job?',
    categories: ['criminal'],
  },
  {
    id: 'dev-criminal-2',
    text: 'Our driver Kev was arrested for drink driving at the weekend and has a court date next month.',
    categories: ['criminal'],
  },
  {
    id: 'dev-criminal-3',
    text: 'She served time ten years ago and is worried it will come up in the DBS check.',
    categories: ['criminal'],
  },
  // --- hr_matter ----------------------------------------------------------
  {
    id: 'dev-hr-1',
    text: 'I want to raise a grievance against my line manager for the way he spoke to me in front of the team.',
    categories: ['hr_matter'],
  },
  {
    id: 'dev-hr-2',
    text: 'We need a letter inviting Gary to a disciplinary hearing about the missing stock.',
    categories: ['hr_matter'],
  },
  {
    id: 'dev-hr-3',
    text: "I've been made redundant after 12 years. What should I check in the redundancy letter?",
    categories: ['hr_matter'],
  },
  {
    id: 'dev-hr-4',
    text: 'Put Lucy on a performance improvement plan for the next eight weeks and draft the objectives.',
    categories: ['hr_matter'],
  },
  {
    id: 'dev-hr-5',
    text: 'Two people on the night shift have made a bullying complaint about the same team leader.',
    categories: ['hr_matter'],
  },
  {
    id: 'dev-hr-6',
    text: 'Ahmed got a final written warning yesterday for lateness and wants to appeal.',
    categories: ['hr_matter'],
  },
  // --- legal_matter -------------------------------------------------------
  {
    id: 'dev-legal-1',
    text: "I'm going through a divorce and need to take Fridays off for the next month for mediation.",
    categories: ['legal_matter'],
  },
  {
    id: 'dev-legal-2',
    text: 'A former employee has lodged an employment tribunal claim; summarise what we need to send our solicitors.',
    categories: ['legal_matter'],
  },
  {
    id: 'dev-legal-3',
    text: "My landlord is trying to evict me and I'm taking him to court. Can you help me write to the council?",
    categories: ['legal_matter'],
  },
  // --- personal_finance ---------------------------------------------------
  {
    id: 'dev-finance-1',
    text: "I'm three months behind on the rent and the bailiffs have written. Can I ask work for an advance?",
    categories: ['personal_finance'],
  },
  {
    id: 'dev-finance-2',
    text: 'Our cleaner told me she has been using payday loans to get to the end of the month.',
    categories: ['personal_finance'],
  },
  {
    id: 'dev-finance-3',
    text: 'He went bankrupt in 2021, does that stop him being a director of the new company?',
    categories: ['personal_finance'],
  },
  // --- not_public ---------------------------------------------------------
  {
    id: 'dev-notpublic-1',
    text: "Design the launch messaging for the Galaxy S27. It's unannounced until 4 March, so nothing leaves this chat.",
    categories: ['not_public'],
  },
  {
    id: 'dev-notpublic-2',
    text: 'Strictly confidential: Q3 numbers come in 20% under forecast. Draft talking points for the board.',
    categories: ['not_public'],
  },
  {
    id: 'dev-notpublic-3',
    text: "This is under NDA but the client's new TV range is using our panels. Write a case study we can publish after the announcement.",
    categories: ['not_public'],
  },
  {
    id: 'dev-notpublic-4',
    text: "Don't share this with anyone yet: we're opening an office in Lisbon in the spring.",
    categories: ['not_public'],
  },
  // --- deal ---------------------------------------------------------------
  {
    id: 'dev-deal-1',
    text: "We're in due diligence to acquire Harbourside Ltd. Draft a list of questions about their contracts.",
    categories: ['deal'],
  },
  {
    id: 'dev-deal-2',
    text: 'Summarise the term sheet from the Series A lead investor and flag anything unusual.',
    categories: ['deal'],
  },
  {
    id: 'dev-deal-3',
    text: 'The merger with Calder Group goes to the board next week; write the staff Q&A.',
    categories: ['deal'],
  },
  // --- restructuring ------------------------------------------------------
  {
    id: 'dev-restructuring-1',
    text: "We're making 30 staff redundant in March, not announced yet. Draft the manager briefing.",
    categories: ['restructuring', 'not_public'],
  },
  {
    id: 'dev-restructuring-2',
    text: 'Plan the comms for closing the Bristol warehouse and the layoffs that come with it.',
    categories: ['restructuring'],
  },
  {
    id: 'dev-restructuring-3',
    text: 'The restructuring will cut the sales team from 40 to 25. How do we run collective consultation?',
    categories: ['restructuring'],
  },
  // --- business_distress --------------------------------------------------
  {
    id: 'dev-distress-1',
    text: "If the Henderson invoice isn't paid this week we can't make payroll. Draft a chaser.",
    categories: ['business_distress'],
  },
  {
    id: 'dev-distress-2',
    text: 'Our biggest supplier is going into administration; what does that mean for our open orders?',
    categories: ['business_distress'],
  },
  {
    id: 'dev-distress-3',
    text: 'We have about six weeks of runway left. Help me write an update for the investors.',
    categories: ['business_distress'],
  },
  // --- litigation ---------------------------------------------------------
  {
    id: 'dev-litigation-1',
    text: "We're being sued by a former supplier over a late delivery. Summarise our side for the insurers.",
    categories: ['litigation'],
  },
  {
    id: 'dev-litigation-2',
    text: 'The client has threatened legal action if we miss the next milestone. Draft a calm reply.',
    categories: ['litigation'],
  },
  {
    id: 'dev-litigation-3',
    text: 'Explain our options now that the dispute with the landlord over the dilapidations is going to arbitration.',
    categories: ['litigation'],
  },
  // --- more than one -------------------------------------------------------
  {
    id: 'dev-multi-1',
    text: 'Her grievance says the disciplinary was really about her pregnancy.',
    categories: ['hr_matter', 'health'],
  },
  {
    id: 'dev-multi-2',
    text: 'Confidential until the announcement: we are buying Northgate, and the integration means redundancies in finance.',
    categories: ['not_public', 'deal', 'restructuring'],
  },

  // --- must not flag --------------------------------------------------------
  { id: 'dev-neg-1', text: "What's our grievance procedure?", categories: [] },
  {
    id: 'dev-neg-2',
    text: 'Write a short guide to the disciplinary policy for new managers.',
    categories: [],
  },
  { id: 'dev-neg-3', text: 'How does statutory sick pay work in the UK?', categories: [] },
  {
    id: 'dev-neg-4',
    text: 'Can you restructure this paragraph so it flows better?',
    categories: [],
  },
  {
    id: 'dev-neg-5',
    text: 'Restructure the data so each row is one order, not one line item.',
    categories: [],
  },
  {
    id: 'dev-neg-6',
    text: 'Our customer acquisition cost doubled last quarter. Suggest three channels to test.',
    categories: [],
  },
  { id: 'dev-neg-7', text: "I'm sick of this printer, how do I reset it?", categories: [] },
  {
    id: 'dev-neg-8',
    text: 'She was charged with leading the migration project and did a great job.',
    categories: [],
  },
  {
    id: 'dev-neg-9',
    text: 'The quarterly report came out yesterday. Summarise it.',
    categories: [],
  },
  { id: 'dev-neg-10', text: 'What is ADHD?', categories: [] },
  { id: 'dev-neg-11', text: 'Explain how the European Union makes trade rules.', categories: [] },
  {
    id: 'dev-neg-12',
    text: 'Remove redundancies in the code and add tests for the parser.',
    categories: [],
  },
  {
    id: 'dev-neg-13',
    text: 'How do I write a union type in TypeScript that accepts a string or a number?',
    categories: [],
  },
  {
    id: 'dev-neg-14',
    text: 'We have a lot of technical debt in the billing module.',
    categories: [],
  },
  {
    id: 'dev-neg-15',
    text: 'Write the launch post for our new range of kettles, which went on sale this morning.',
    categories: [],
  },
  {
    id: 'dev-neg-16',
    text: 'Plan an Instagram takeover with our ambassador for the summer campaign.',
    categories: [],
  },
  {
    id: 'dev-neg-17',
    text: 'Draft an agenda for Thursday: Q4 targets, the new CRM, and the office move.',
    categories: [],
  },
  { id: 'dev-neg-18', text: 'Kill the process that is holding port 3000.', categories: [] },
  {
    id: 'dev-neg-19',
    text: 'Summarise the history of the Labour Party in three paragraphs.',
    categories: [],
  },
  {
    id: 'dev-neg-20',
    text: 'Grace and Hope from accounts are joining the call; can you send them the deck?',
    categories: [],
  },
  {
    id: 'dev-neg-21',
    text: 'Write a recipe for a vegetarian lasagne for six people.',
    categories: [],
  },
  {
    id: 'dev-neg-22',
    text: 'What are the rules on maternity pay for small employers?',
    categories: [],
  },
  {
    id: 'dev-neg-23',
    text: 'Our talent acquisition team needs a better job ad template for engineers.',
    categories: [],
  },
  {
    id: 'dev-neg-24',
    text: 'Book me a train to Manchester on Tuesday morning and a hotel near the venue.',
    categories: [],
  },
  {
    id: 'dev-neg-25',
    text: 'Give me five subject lines for the newsletter announcing our new opening hours.',
    categories: [],
  },
  {
    id: 'dev-neg-26',
    text: "It's criminal how slow this laptop is. Any tips?",
    categories: [],
  },
  {
    id: 'dev-neg-27',
    text: 'Create a confidentiality clause for our standard freelancer contract.',
    categories: [],
  },
  {
    id: 'dev-neg-28',
    text: 'Explain the difference between administration and liquidation for a business studies class.',
    categories: [],
  },
  {
    id: 'dev-neg-29',
    text: 'Refactor this class: it handles both parsing and validation.',
    categories: [],
  },
  {
    id: 'dev-neg-31',
    text: 'The background is black, can you change it to grey?',
    categories: [],
  },
  { id: 'dev-neg-32', text: 'We run a multi-disciplinary team of designers.', categories: [] },
  { id: 'dev-neg-33', text: 'Our payroll is bi weekly, draft a reminder email.', categories: [] },
  {
    id: 'dev-neg-34',
    text: 'Write a blurb for the Museum of Industrial Heritage.',
    categories: [],
  },
  {
    id: 'dev-neg-35',
    text: 'Our team is doing a community service day next Friday.',
    categories: [],
  },
  { id: 'dev-neg-36', text: 'Can you restructure this into bullet points?', categories: [] },
  {
    id: 'dev-neg-30',
    text: 'Our open day is on Saturday; write a friendly reminder for the parents.',
    categories: [],
  },
];
