/**
 * The held-out confidential-content corpus (§130, t-1036).
 *
 * Written by an author who never saw the classifier or its phrase list, from
 * the category definitions alone, so its figures estimate how the classifier
 * does on text nobody tuned it for. Every message is invented.
 */
import type { SensitivityCorpusCase } from '@/tests/fixtures/privacy/sensitivity-corpus/types';

export const HELD_OUT_CASES: SensitivityCorpusCase[] = [
  // ---------------------------------------------------------------------------
  // Positives: personal
  // ---------------------------------------------------------------------------

  // health
  {
    id: 'ho-health-1',
    text: "Can you help me write an email to my manager explaining I'll be off for two weeks? I've just been diagnosed with a hernia and need surgery.",
    categories: ['health'],
  },
  {
    id: 'ho-health-2',
    text: "My colleague Priya is pregnant and hasn't told the wider team yet. How do I start planning cover for her maternity leave without it getting out?",
    categories: ['health'],
  },
  {
    id: 'ho-health-3',
    text: 'draft a note to HR for me, my son has ADHD and autism and i need flexible hours to get him to his appointments',
    categories: ['health'],
  },
  {
    id: 'ho-health-4',
    text: "I've been on sertraline for about six months and my GP wants to up the dose. What might that feel like for the first few weeks?",
    categories: ['health'],
  },
  {
    id: 'ho-health-5',
    text: 'Tom in accounts has been signed off with stress again, third time this year. How should I spread his workload?',
    categories: ['health'],
  },
  {
    id: 'ho-health-6',
    text: 'Dev nips off for his chemo on Thursday mornings so I need someone else on the Thursday rota until March.',
    categories: ['health'],
  },
  {
    id: 'ho-health-7',
    text: "Our client's MD had a minor stroke last month and is only back part-time. Can you soften the tone of this chaser so it doesn't sound like we're piling on?",
    categories: ['health'],
  },
  {
    id: 'ho-health-8',
    text: "Ben's off sick today, can you move his 2pm with the supplier to Thursday?",
    categories: ['health'],
  },

  // ethnicity
  {
    id: 'ho-ethnicity-1',
    text: 'Write a reference for Amara. She was the only Black woman on the graduate scheme, of Nigerian heritage, and she mentioned it made things harder for her at times.',
    categories: ['ethnicity'],
  },
  {
    id: 'ho-ethnicity-2',
    text: "I'm half Pakistani and half Irish and I'm filling in the diversity monitoring form for my new job. Which box am I meant to tick?",
    categories: ['ethnicity'],
  },
  {
    id: 'ho-ethnicity-3',
    text: 'One of our tenants is from a Roma family and the neighbours keep making comments. How should our housing officer respond?',
    categories: ['ethnicity'],
  },
  {
    id: 'ho-ethnicity-4',
    text: 'My team lead is British Chinese and I genuinely think a couple of people treat her differently because of it. How do I raise it?',
    categories: ['ethnicity'],
  },
  {
    id: 'ho-ethnicity-5',
    text: 'Help me word an apology. At the team social someone made a joke about Ravi being Gujarati and he was clearly upset.',
    categories: ['ethnicity'],
  },
  {
    id: 'ho-ethnicity-6',
    text: "Draft the outcome letter for the grievance Kemi raised. She says she was passed over for the senior role because she's Black Caribbean.",
    categories: ['ethnicity', 'hr_matter'],
  },

  // religion
  {
    id: 'ho-religion-1',
    text: "I'm Muslim and Ramadan starts next week, can you help me ask my line manager if I can take my lunch break at sunset instead?",
    categories: ['religion'],
  },
  {
    id: 'ho-religion-2',
    text: "Sarah on reception is a Jehovah's Witness so she won't join in the birthday cake thing. Can you suggest something more inclusive for the team?",
    categories: ['religion'],
  },
  {
    id: 'ho-religion-3',
    text: "My landlord found out I'm Jewish and ever since he's been really off with me about repairs.",
    categories: ['religion'],
  },
  {
    id: 'ho-religion-4',
    text: 'My brother left the church last year and now calls himself a committed atheist. My parents are struggling with it, how do I talk to them?',
    categories: ['religion'],
  },
  {
    id: 'ho-religion-5',
    text: 'Can you rewrite this politely: one of our drivers, Harpreet, wears a turban for religious reasons and the client site is insisting on a hard hat.',
    categories: ['religion'],
  },
  {
    id: 'ho-religion-6',
    text: "Hannah keeps the Sabbath so she can't do Friday late shifts in winter, please leave her off those on the new rota.",
    categories: ['religion'],
  },

  // politics
  {
    id: 'ho-politics-1',
    text: 'My boss is a paid-up Reform member and keeps bringing it up in meetings. Is that even allowed?',
    categories: ['politics'],
  },
  {
    id: 'ho-politics-2',
    text: "I'm standing as a Green Party candidate in the council elections in May. Do I need to tell my employer?",
    categories: ['politics'],
  },
  {
    id: 'ho-politics-3',
    text: 'Our head of finance tore up his Labour membership card over the leadership and has been very vocal about voting Independent since.',
    categories: ['politics'],
  },
  {
    id: 'ho-politics-4',
    text: "Write a polite reply to Gareth. He's been canvassing for the Lib Dems and asked me to deliver leaflets, but I vote Conservative and don't want to fall out with him.",
    categories: ['politics'],
  },
  {
    id: 'ho-politics-5',
    text: 'My neighbour told me in confidence she voted Leave and her family would never forgive her if they knew.',
    categories: ['politics'],
  },

  // trade_union
  {
    id: 'ho-trade_union-1',
    text: "I'm the Unite rep for our depot and management want to meet me about the pay offer on Wednesday. Help me prep.",
    categories: ['trade_union'],
  },
  {
    id: 'ho-trade_union-2',
    text: 'Three of the warehouse lads joined the GMB last month and now the supervisor keeps giving them the worst shifts.',
    categories: ['trade_union'],
  },
  {
    id: 'ho-trade_union-3',
    text: 'Can you draft a short letter saying I want my Unison rep to accompany me to my disciplinary hearing on Friday?',
    categories: ['trade_union', 'hr_matter'],
  },
  {
    id: 'ho-trade_union-4',
    text: "Lisa's the one who organised the walkout in the staffroom last month, she's NEU through and through.",
    categories: ['trade_union'],
  },
  {
    id: 'ho-trade_union-5',
    text: 'thinking of signing up with the RCN before the strike ballot, will that put a target on my back with the ward manager?',
    categories: ['trade_union'],
  },

  // sexuality
  {
    id: 'ho-sexuality-1',
    text: 'My colleague Jamie came out to me as gay last week and asked me not to tell anyone at work. How can I be supportive?',
    categories: ['sexuality'],
  },
  {
    id: 'ho-sexuality-2',
    text: 'Our nephew is transitioning and asked us to use he/him now. Help me write a card for his 18th that gets it right.',
    categories: ['sexuality'],
  },
  {
    id: 'ho-sexuality-3',
    text: "I'm bi and I'm nervous about how my new team will react if I bring my girlfriend to the Christmas do.",
    categories: ['sexuality'],
  },
  {
    id: 'ho-sexuality-4',
    text: 'Marcus is non-binary and our payroll system only lets us pick Mr, Mrs or Ms. What should I do?',
    categories: ['sexuality'],
  },
  {
    id: 'ho-sexuality-5',
    text: "My husband and I have an open marriage and someone at work found out. Now there's gossip and I want to shut it down.",
    categories: ['sexuality'],
  },

  // criminal
  {
    id: 'ho-criminal-1',
    text: 'One of our shortlisted applicants disclosed a drink-driving conviction from 2019. Do we have to take it into account?',
    categories: ['criminal'],
  },
  {
    id: 'ho-criminal-2',
    text: "My dad's just been released from HMP Wandsworth and needs help putting a CV together.",
    categories: ['criminal'],
  },
  {
    id: 'ho-criminal-3',
    text: "Our delivery driver Shane was arrested on Saturday night and he's still in custody, so he won't be in on Monday.",
    categories: ['criminal'],
  },
  {
    id: 'ho-criminal-4',
    text: 'I got a police caution for shoplifting when I was 17. Will it show up on a basic DBS for this teaching assistant job?',
    categories: ['criminal'],
  },
  {
    id: 'ho-criminal-5',
    text: "Ellie's partner has been charged with assault and the hearing's at the magistrates' next week. She's asked for the day off.",
    categories: ['criminal'],
  },
  {
    id: 'ho-criminal-6',
    text: 'Between us, Craig did a stretch inside for fraud before he joined. Should finance know before we give him signing authority?',
    categories: ['criminal'],
  },

  // hr_matter
  {
    id: 'ho-hr_matter-1',
    text: "Help me write the invite letter for Darren's disciplinary hearing. Allegation is gross misconduct for falsifying timesheets.",
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-2',
    text: "I've been put on a performance improvement plan and I think it's unfair. Can you help me reply to my manager?",
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-3',
    text: "Draft a first written warning for Chloe's lateness, she's been late nine times since September.",
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-4',
    text: 'A junior designer has made a bullying complaint against our creative director. What do I do first?',
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-5',
    text: "My employer's offered me a settlement agreement of £12k to leave quietly. Is that a decent deal?",
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-6',
    text: "I'm being made redundant at the end of the month and want to check my notice pay is right.",
    categories: ['hr_matter'],
  },
  {
    id: 'ho-hr_matter-7',
    text: "Prep notes for the capability meeting with Joe. His absences are mostly down to his Crohn's flare-ups but he's hit the sickness trigger and we're considering a final warning.",
    categories: ['hr_matter', 'health'],
  },
  {
    id: 'ho-hr_matter-8',
    text: "We're 'managing out' Bev from marketing, she doesn't know yet. Can you help me build the paper trail?",
    categories: ['hr_matter'],
  },

  // legal_matter
  {
    id: 'ho-legal_matter-1',
    text: "I'm taking my old employer to an employment tribunal for unfair dismissal, help me fill in the ET1.",
    categories: ['legal_matter', 'hr_matter'],
  },
  {
    id: 'ho-legal_matter-2',
    text: 'My ex and I are going through the divorce and she wants full custody of the kids. What should I bring to mediation?',
    categories: ['legal_matter'],
  },
  {
    id: 'ho-legal_matter-3',
    text: "Can you draft a letter before claim to my landlord? He's kept my whole deposit and the damp ruined half my furniture.",
    categories: ['legal_matter'],
  },
  {
    id: 'ho-legal_matter-4',
    text: 'Our receptionist Nadia got a section 21 notice and has to be out of her flat next month. Can we help with a reference for a new place?',
    categories: ['legal_matter'],
  },
  {
    id: 'ho-legal_matter-5',
    text: 'I slipped on a wet floor in a supermarket and broke my wrist, my solicitor says I have a personal injury claim. What happens next?',
    categories: ['legal_matter', 'health'],
  },
  {
    id: 'ho-legal_matter-6',
    text: "my sister's in a horrible custody fight and needs me to write a character statement for the family court",
    categories: ['legal_matter'],
  },

  // personal_finance
  {
    id: 'ho-personal_finance-1',
    text: "I'm three months behind on council tax and they've passed it to bailiffs. What are my rights if they turn up?",
    categories: ['personal_finance'],
  },
  {
    id: 'ho-personal_finance-2',
    text: "Help me write to my bank, I can't make the minimum payment on my credit card this month.",
    categories: ['personal_finance'],
  },
  {
    id: 'ho-personal_finance-3',
    text: "My colleague Dean admitted he's taken out four payday loans just to cover rent and he's drowning.",
    categories: ['personal_finance'],
  },
  {
    id: 'ho-personal_finance-4',
    text: "I'm weighing up an IVA against going bankrupt, my debts are about £38k. Which is less damaging?",
    categories: ['personal_finance'],
  },
  {
    id: 'ho-personal_finance-5',
    text: "Can I ask for an advance on my salary? I can't pay rent this month and my landlord is threatening me.",
    categories: ['personal_finance'],
  },
  {
    id: 'ho-personal_finance-6',
    text: "Mum's been robbing Peter to pay Paul across her cards for years and now the red letters are piling up on the doormat.",
    categories: ['personal_finance'],
  },

  // ---------------------------------------------------------------------------
  // Positives: commercial
  // ---------------------------------------------------------------------------

  // not_public
  {
    id: 'ho-not_public-1',
    text: "Strictly confidential: we're dropping the Pro tier price by 30% on 1 March. Draft the customer email but we won't send it until then.",
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-2',
    text: 'These Q3 numbers are embargoed until the RNS at 7am Thursday. Summarise them for the board pack.',
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-3',
    text: "We're under NDA with the supplier but here's their unit pricing sheet, can you compare it against what we pay now?",
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-4',
    text: 'Internal only, not for distribution: the new CEO will be Fiona Marsh, announcement on Monday. Draft the all-staff email.',
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-5',
    text: "Write teaser copy for the headset we haven't announced yet, the Halo 2, launching at the September event. Nobody outside the product team knows the name.",
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-6',
    text: "Keep this between us and the exec team for now, but we've lost the Henderson account and it'll knock about 20% off revenue.",
    categories: ['not_public'],
  },
  {
    id: 'ho-not_public-7',
    text: "Confidential, we're in talks to merge with our biggest competitor and nothing's public yet. Draft talking points for the leadership offsite.",
    categories: ['not_public', 'deal'],
  },

  // deal
  {
    id: 'ho-deal-1',
    text: "We're doing due diligence on a small logistics firm in Leeds. Can you draft a list of questions about their customer contracts?",
    categories: ['deal'],
  },
  {
    id: 'ho-deal-2',
    text: 'Summarise the key terms in this term sheet: £4m Series A at a £16m pre-money, 1x non-participating preference, two board seats.',
    categories: ['deal'],
  },
  {
    id: 'ho-deal-3',
    text: 'Help me draft a letter of intent to acquire Brightwater Joinery Ltd for around £2.1m.',
    categories: ['deal'],
  },
  {
    id: 'ho-deal-4',
    text: 'The board has agreed to the management buyout. How do I explain this to staff without spooking them?',
    categories: ['deal'],
  },
  {
    id: 'ho-deal-5',
    text: 'A private equity house has been sniffing around and wants to take us over. What should I be asking our advisers?',
    categories: ['deal'],
  },
  {
    id: 'ho-deal-6',
    text: 'Prep me for the IPO roadshow, our AIM listing is pencilled in for the spring.',
    categories: ['deal'],
  },
  {
    id: 'ho-deal-7',
    text: "Once the acquisition completes we'll fold the two finance teams together and about eight roles will go. Help me sequence it.",
    categories: ['deal', 'restructuring'],
  },

  // restructuring
  {
    id: 'ho-restructuring-1',
    text: 'We need to cut 40 roles across the Bristol and Swindon offices. Draft the collective consultation announcement.',
    categories: ['restructuring'],
  },
  {
    id: 'ho-restructuring-2',
    text: 'Leadership want to close the Hull distribution centre by June. Help me plan the comms.',
    categories: ['restructuring'],
  },
  {
    id: 'ho-restructuring-3',
    text: "Give me a spreadsheet layout to track headcount reductions, we're taking out 15% of ops.",
    categories: ['restructuring'],
  },
  {
    id: 'ho-restructuring-4',
    text: "Internal only and not announced: we'll be laying off the whole customer support team and outsourcing it in Q2. Write the FAQ for managers.",
    categories: ['restructuring', 'not_public'],
  },
  {
    id: 'ho-restructuring-5',
    text: 'Draft the selection criteria matrix for the redundancy pool in engineering, 12 people at risk for 5 roles.',
    categories: ['restructuring'],
  },
  {
    id: 'ho-restructuring-6',
    text: "We're right-sizing the sales org after the board review, roughly a third of the reps won't have a seat in the new structure.",
    categories: ['restructuring'],
  },

  // business_distress
  {
    id: 'ho-business_distress-1',
    text: "We won't make payroll on Friday unless the Kestrel invoice clears. How do I tell the staff?",
    categories: ['business_distress'],
  },
  {
    id: 'ho-business_distress-2',
    text: "Our accountant says we're technically insolvent. What are the options before we end up in administration?",
    categories: ['business_distress'],
  },
  {
    id: 'ho-business_distress-3',
    text: "The bank's threatening to call in our loan after we missed two repayments. Help me write to our relationship manager.",
    categories: ['business_distress'],
  },
  {
    id: 'ho-business_distress-4',
    text: 'Draft a profit warning: full-year revenue will come in around 25% below market expectations.',
    categories: ['business_distress'],
  },
  {
    id: 'ho-business_distress-5',
    text: "Cash is so tight we're choosing which suppliers to pay this month, and HMRC is already chasing the VAT.",
    categories: ['business_distress'],
  },
  {
    id: 'ho-business_distress-6',
    text: "We're going into administration on Monday and the administrators will let 60 staff go straight away. What do I say at the all-hands?",
    categories: ['business_distress', 'restructuring'],
  },

  // litigation
  {
    id: 'ho-litigation-1',
    text: "We've had a letter before action from a former distributor claiming £350k for breach of contract. How should we respond?",
    categories: ['litigation'],
  },
  {
    id: 'ho-litigation-2',
    text: 'The ICO has opened an investigation into our data breach from March. Help me prepare for their questions.',
    categories: ['litigation'],
  },
  {
    id: 'ho-litigation-3',
    text: "Our competitor's solicitors are threatening proceedings over our new logo, can you summarise their letter?",
    categories: ['litigation'],
  },
  {
    id: 'ho-litigation-4',
    text: "We're going to arbitration with the main contractor on the Riverside build next month, help me organise the bundle.",
    categories: ['litigation'],
  },
  {
    id: 'ho-litigation-5',
    text: 'The CMA have written to us about our pricing practices and want documents by the 30th.',
    categories: ['litigation'],
  },
  {
    id: 'ho-litigation-6',
    text: 'Strictly confidential: a customer is suing us over the faulty boilers and our insurers want to settle before it gets to court.',
    categories: ['litigation', 'not_public'],
  },

  // ---------------------------------------------------------------------------
  // Negatives: must NOT flag
  // ---------------------------------------------------------------------------

  // HR policy and general employment questions
  {
    id: 'ho-neg-1',
    text: "What's our grievance procedure? I can't find it on the intranet.",
    categories: [],
  },
  {
    id: 'ho-neg-2',
    text: 'How does statutory sick pay work for part-time staff?',
    categories: [],
  },
  {
    id: 'ho-neg-3',
    text: 'How does the employment tribunal process work in general? Just an overview for our manager training.',
    categories: [],
  },
  {
    id: 'ho-neg-4',
    text: 'Explain what a performance improvement plan is so I can include it in our new-manager slides.',
    categories: [],
  },
  {
    id: 'ho-neg-5',
    text: "What does 'gross misconduct' usually cover in UK employment law? General examples for our staff handbook.",
    categories: [],
  },
  {
    id: 'ho-neg-6',
    text: 'How many days of compassionate leave are typical in UK companies?',
    categories: [],
  },
  {
    id: 'ho-neg-7',
    text: 'Draft a job advert for a warehouse operative in Northampton, days, £12.60 an hour.',
    categories: [],
  },
  {
    id: 'ho-neg-8',
    text: "What's the policy on bringing dogs into the office?",
    categories: [],
  },

  // Marketing, product copy, public company news
  {
    id: 'ho-neg-9',
    text: 'Write a LinkedIn post about how we cut our customer acquisition cost by 20% this year.',
    categories: [],
  },
  {
    id: 'ho-neg-10',
    text: 'Write product copy for our autumn range of wool jumpers, which went live on the site last week.',
    categories: [],
  },
  {
    id: 'ho-neg-11',
    text: "We're launching our winter sale on Friday, it's already on the website. Write the newsletter email.",
    categories: [],
  },
  {
    id: 'ho-neg-12',
    text: 'Write a press release about our new Manchester office opening, it was announced at the summit last month.',
    categories: [],
  },
  {
    id: 'ho-neg-13',
    text: 'Make a slide on how we acquired 3,000 new customers through referrals last quarter.',
    categories: [],
  },
  {
    id: 'ho-neg-14',
    text: 'Our Pride month campaign is live, draft three social posts celebrating it.',
    categories: [],
  },
  {
    id: 'ho-neg-15',
    text: "Our annual report's already published and shows revenue of £12m. Turn the highlights into a one-page infographic brief.",
    categories: [],
  },
  {
    id: 'ho-neg-16',
    text: "Write a tagline for our gym: something like 'Kill the workout, not your knees'.",
    categories: [],
  },
  {
    id: 'ho-neg-17',
    text: 'Our brand is called Liberty Blue, draft an Instagram bio for us.',
    categories: [],
  },
  {
    id: 'ho-neg-18',
    text: 'Translate "Happy Diwali" and "Eid Mubarak" for the multicultural calendar in our newsletter.',
    categories: [],
  },

  // Code and tech
  {
    id: 'ho-neg-19',
    text: 'Can you restructure this function so it is easier to unit test? It does validation, the DB write and the email all in one.',
    categories: [],
  },
  {
    id: 'ho-neg-20',
    text: 'How do I kill the process hogging port 3000 on my Mac?',
    categories: [],
  },
  {
    id: 'ho-neg-21',
    text: 'Explain the union type in TypeScript with a small example.',
    categories: [],
  },
  {
    id: 'ho-neg-22',
    text: "We've built up a lot of technical debt in the billing service. How should we prioritise paying it down?",
    categories: [],
  },
  {
    id: 'ho-neg-23',
    text: 'Can you merge these two spreadsheets on the customer ID column?',
    categories: [],
  },
  {
    id: 'ho-neg-24',
    text: 'git merge vs rebase, which should our team standardise on?',
    categories: [],
  },
  {
    id: 'ho-neg-25',
    text: 'How do I terminate an EC2 instance without losing the attached volume?',
    categories: [],
  },
  {
    id: 'ho-neg-26',
    text: 'The child process exits with code 1, what does that usually mean in Node?',
    categories: [],
  },
  {
    id: 'ho-neg-27',
    text: 'How do I set up a health check endpoint in Express for the load balancer?',
    categories: [],
  },
  {
    id: 'ho-neg-28',
    text: 'Our server crashed overnight and the logs show an out-of-memory error. Help me debug.',
    categories: [],
  },
  {
    id: 'ho-neg-29',
    text: 'The patient portal app needs a dark mode, write the user story and acceptance criteria.',
    categories: [],
  },
  {
    id: 'ho-neg-30',
    text: "Add a 'Confidential' footer option to the settings page of our document template tool.",
    categories: [],
  },
  {
    id: 'ho-neg-31',
    text: 'Can you explain this confidence interval in plain English for the report?',
    categories: [],
  },

  // Idioms
  {
    id: 'ho-neg-32',
    text: "I'm so sick of this printer jamming, any tips before I throw it out the window?",
    categories: [],
  },
  {
    id: 'ho-neg-33',
    text: "I'm dying to know how the new menu tested with customers, can you summarise the survey results?",
    categories: [],
  },
  {
    id: 'ho-neg-34',
    text: "Sam's been charged with leading the new onboarding project, help me write the kick-off agenda.",
    categories: [],
  },
  {
    id: 'ho-neg-35',
    text: "It's criminal how slow our build pipeline is. Any ideas to speed up CI?",
    categories: [],
  },
  {
    id: 'ho-neg-36',
    text: "My basil plant's leaves are going yellow, is it dying?",
    categories: [],
  },
  {
    id: 'ho-neg-37',
    text: 'That pitch absolutely killed it, can you write a thank-you note to the team who put it together?',
    categories: [],
  },

  // News and general knowledge
  {
    id: 'ho-neg-38',
    text: 'Explain the European Union in simple terms for a Year 7 class.',
    categories: [],
  },
  {
    id: 'ho-neg-39',
    text: 'Give me a short history of the Labour Party for a pub quiz round.',
    categories: [],
  },
  {
    id: 'ho-neg-40',
    text: 'What is IVF and how many rounds does the NHS usually fund?',
    categories: [],
  },
  {
    id: 'ho-neg-41',
    text: 'What is ADHD and how is it usually diagnosed in adults?',
    categories: [],
  },
  {
    id: 'ho-neg-42',
    text: "What's the difference between a merger and an acquisition? It's for my A-level business homework.",
    categories: [],
  },
  {
    id: 'ho-neg-43',
    text: "Explain what administration means for a UK company, I'm revising for my ACCA exam.",
    categories: [],
  },
  {
    id: 'ho-neg-44',
    text: 'Write a short blog post on the role of trade unions in 20th-century Britain.',
    categories: [],
  },
  {
    id: 'ho-neg-45',
    text: 'What are the main world religions by number of followers?',
    categories: [],
  },
  {
    id: 'ho-neg-46',
    text: 'Write a fun quiz question about the Tolpuddle Martyrs.',
    categories: [],
  },
  {
    id: 'ho-neg-47',
    text: 'Explain how the House of Lords works.',
    categories: [],
  },
  {
    id: 'ho-neg-48',
    text: 'How does bankruptcy law differ between England and Scotland?',
    categories: [],
  },
  {
    id: 'ho-neg-49',
    text: "Summarise the plot of Kafka's The Trial in three paragraphs.",
    categories: [],
  },
  {
    id: 'ho-neg-50',
    text: 'Summarise this news item for me: a major supermarket chain reported a rise in half-year profits.',
    categories: [],
  },
  {
    id: 'ho-neg-51',
    text: 'Which vitamins are worth taking in winter? Just asking generally.',
    categories: [],
  },
  {
    id: 'ho-neg-52',
    text: 'List the sections a standard mutual NDA template usually has.',
    categories: [],
  },
  {
    id: 'ho-neg-53',
    text: "What does 'due diligence' mean when you're buying a used car?",
    categories: [],
  },

  // Meetings, admin, travel, recipes, names that are words
  {
    id: 'ho-neg-54',
    text: 'Meeting notes: agreed the Q4 roadmap, Priya to own the API docs, next sync Tuesday. Tidy these up please.',
    categories: [],
  },
  {
    id: 'ho-neg-55',
    text: 'Plan a three-day trip to Edinburgh in December on a mid-range budget.',
    categories: [],
  },
  {
    id: 'ho-neg-56',
    text: "Recipe for a vegetarian shepherd's pie that serves six?",
    categories: [],
  },
  {
    id: 'ho-neg-57',
    text: 'Grace asked if we can move standup to 9:30, can you draft a quick reply saying yes?',
    categories: [],
  },
  {
    id: 'ho-neg-58',
    text: 'Hope from the design team sent over the new mockups, list what changed against v2.',
    categories: [],
  },
  {
    id: 'ho-neg-59',
    text: 'Faith and Mercy are joining the sales team next week, write a warm welcome message for Slack.',
    categories: [],
  },
  {
    id: 'ho-neg-60',
    text: "Draft an out-of-office: I'm on annual leave from 22 December to 2 January.",
    categories: [],
  },
  {
    id: 'ho-neg-61',
    text: 'Draft a reminder that the fire drill is on Wednesday at 11.',
    categories: [],
  },
  {
    id: 'ho-neg-62',
    text: 'Help me write a cover letter for a paralegal role at a commercial litigation firm.',
    categories: [],
  },
  {
    id: 'ho-neg-63',
    text: 'Write a polite but firm email template for chasing overdue customer invoices.',
    categories: [],
  },
  {
    id: 'ho-neg-64',
    text: "What's the best way to structure a funding application to the Arts Council for our community theatre?",
    categories: [],
  },
  {
    id: 'ho-neg-65',
    text: 'Xero or QuickBooks for a ten-person startup?',
    categories: [],
  },
  {
    id: 'ho-neg-66',
    text: "Rewrite this to sound less aggressive: 'Please action the attached ASAP.'",
    categories: [],
  },
  {
    id: 'ho-neg-67',
    text: 'Can you tidy up our org chart layout? Just make the boxes line up and the names a consistent font.',
    categories: [],
  },
  {
    id: 'ho-neg-68',
    text: 'Give me a five-minute icebreaker for a team of twelve.',
    categories: [],
  },
];
