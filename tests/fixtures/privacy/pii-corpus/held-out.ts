/**
 * Held-out cases for the personal-data detector corpus (§127).
 *
 * Written without sight of the detector or the tuning corpus, so a score on
 * these is a measure, not a target. Do not tune the detector against this
 * file: if a case here fails, fix the detector on the tuning corpus and let
 * this one report whether the fix generalised.
 *
 * Every value is invented: phones from Ofcom's drama ranges, emails on
 * reserved example domains, IPs from documentation ranges, and identifiers
 * with a check digit taken from a list generated to pass it.
 */
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';
import { FAKE_SECRETS } from '@/tests/fixtures/privacy/pii-corpus/fake-secrets';

export const HELD_OUT_CASES: CorpusCase[] = [
  // -------------------------------------------------------------------------
  // support
  // -------------------------------------------------------------------------
  {
    id: 'held-support-parcel-chat',
    domain: 'support',
    text: 'hi my parcel never turned up?? order UK-448213. its for chidi okonkwo at flat 3, 27 wellington road, leeds LS12 1DW. tracking says delivered but it wasnt. my mob is 07700900412',
    labels: [
      { type: 'PERSON', value: 'chidi okonkwo' },
      { type: 'ADDRESS', value: '27 wellington road' },
      { type: 'POSTCODE', value: 'LS12 1DW' },
      { type: 'PHONE', value: '07700900412' },
    ],
  },
  {
    id: 'held-support-locked-out-email',
    domain: 'support',
    text: "Hello,\n\nI've been locked out of my account since yesterday evening. The login email is siobhan.oreilly@example.co.uk, but I may have registered with my work address, s.oreilly@mail.example.com. Could someone ring me on +44 7700 900 731? I'm free after 5.\n\nThanks,\nSiobhan O'Reilly",
    labels: [
      { type: 'EMAIL', value: 'siobhan.oreilly@example.co.uk' },
      { type: 'EMAIL', value: 's.oreilly@mail.example.com' },
      { type: 'PHONE', value: '+44 7700 900 731' },
      { type: 'PERSON', value: "Siobhan O'Reilly" },
    ],
  },
  {
    id: 'held-support-phone-change-known-user',
    domain: 'support',
    text: "Hi there, Mr Rhys Davies here (the account's under GWILYM RHYS-DAVIES, email gwilym.rhysdavies@example.net). Can you swap my number from 07700 900 288 to 07700 900 615 please, the old phone got nicked. Ta, Gwil",
    labels: [
      { type: 'PERSON', value: 'Rhys Davies' },
      { type: 'PERSON', value: 'GWILYM RHYS-DAVIES' },
      { type: 'EMAIL', value: 'gwilym.rhysdavies@example.net' },
      { type: 'PHONE', value: '07700 900 288' },
      { type: 'PHONE', value: '07700 900 615' },
      { type: 'PERSON', value: 'Gwil' },
    ],
    knownValues: [
      { type: 'PERSON', value: 'Gwilym Rhys-Davies' },
      { type: 'EMAIL', value: 'gwilym.rhysdavies@example.net' },
      { type: 'PHONE', value: '07700900288' },
    ],
  },
  {
    id: 'held-support-refund-ticket',
    domain: 'support',
    text: 'REFUND – Mrs F. Begum, acct email farida.begum77@example.com. Charged twice for order 88213-B (£34.99 x2). Card ending 1881. Pls refund 1 to original payment method. Cust asked for callback on 0161 496 0723 after 3pm.',
    labels: [
      { type: 'PERSON', value: 'F. Begum' },
      { type: 'EMAIL', value: 'farida.begum77@example.com' },
      { type: 'PHONE', value: '0161 496 0723' },
    ],
  },
  {
    id: 'held-support-broadband-call-notes',
    domain: 'support',
    text: "Call notes 10/11 – spoke to Tomasz Wiśniewski re: broadband outage at 9 Corporation Street, Coventry CV1 1GF. Line test fails at the cabinet, router public IP 203.0.113.47 not responding. Engineer booked Thu 14 Nov AM slot. Tomasz's wife Ewa will be in to let them in.",
    labels: [
      { type: 'PERSON', value: 'Tomasz Wiśniewski' },
      { type: 'PERSON', value: 'Tomasz', occurrence: 2 },
      { type: 'PERSON', value: 'Ewa' },
      { type: 'ADDRESS', value: '9 Corporation Street' },
      { type: 'POSTCODE', value: 'CV1 1GF' },
      { type: 'IP_ADDRESS', value: '203.0.113.47' },
    ],
  },
  {
    id: 'held-support-app-logout-sloppy',
    domain: 'support',
    text: 'hey its kwame again lol, the app keeps logging me out every 5 mins. email on the account is kmensah@example.org. also my sister abena set up an account using my card 4012888888881881 without asking, can u take it off hers',
    labels: [
      { type: 'PERSON', value: 'kwame' },
      { type: 'EMAIL', value: 'kmensah@example.org' },
      { type: 'PERSON', value: 'abena' },
      { type: 'CARD_NUMBER', value: '4012888888881881' },
    ],
  },
  {
    id: 'held-support-contact-form-paste',
    domain: 'support',
    text: "Name: Aoife Ní Bhriain\nDate of birth: 03/07/1994\nAddress: 112 Malone Road, Belfast\nPostcode: BT9 6BU\nPhone: 028 9649 6213\nEmail: aoife.nibhriain@example.co.uk\nMessage: I'm trying to add a second delivery address (my mum's, 5 Lisburn Road) but the form keeps saying the postcode is invalid.",
    labels: [
      { type: 'PERSON', value: 'Aoife Ní Bhriain' },
      { type: 'DATE_OF_BIRTH', value: '03/07/1994' },
      { type: 'ADDRESS', value: '112 Malone Road' },
      { type: 'POSTCODE', value: 'BT9 6BU' },
      { type: 'PHONE', value: '028 9649 6213' },
      { type: 'EMAIL', value: 'aoife.nibhriain@example.co.uk' },
      { type: 'ADDRESS', value: '5 Lisburn Road' },
    ],
  },

  // -------------------------------------------------------------------------
  // hr
  // -------------------------------------------------------------------------
  {
    id: 'held-hr-sickness-email',
    domain: 'hr',
    text: 'Hi Rachel,\n\nJust to let you know Imran Qureshi has been signed off for two weeks by his GP (fit note attached). His NI number is WA 58 12 26 D for the SSP paperwork – can you make sure payroll have it before the 20th?\n\nCheers,\nDev',
    labels: [
      { type: 'PERSON', value: 'Rachel' },
      { type: 'PERSON', value: 'Imran Qureshi' },
      { type: 'UK_NINO', value: 'WA 58 12 26 D' },
      { type: 'PERSON', value: 'Dev' },
    ],
  },
  {
    id: 'held-hr-new-starter-form',
    domain: 'hr',
    text: 'New starter details\nFull name: Olumide Adeyemi-Clarke\nPreferred name: Olu\nDate of birth: 22 September 1990\nNI number: ZG783011B\nHome address: 48 Thornbury Close, Bristol BS16 3RT\nPersonal email: o.adeyemiclarke@example.com\nMobile: (07700) 900184\nBank: sort code 20-45-77, account 41738892\nStart date: 2 December 2026\nLine manager: Hannah Kerr',
    labels: [
      { type: 'PERSON', value: 'Olumide Adeyemi-Clarke' },
      { type: 'PERSON', value: 'Olu' },
      { type: 'DATE_OF_BIRTH', value: '22 September 1990' },
      { type: 'UK_NINO', value: 'ZG783011B' },
      { type: 'ADDRESS', value: '48 Thornbury Close' },
      { type: 'POSTCODE', value: 'BS16 3RT' },
      { type: 'EMAIL', value: 'o.adeyemiclarke@example.com' },
      { type: 'PHONE', value: '(07700) 900184' },
      { type: 'SORT_CODE', value: '20-45-77' },
      { type: 'BANK_ACCOUNT', value: '41738892' },
      { type: 'PERSON', value: 'Hannah Kerr' },
    ],
  },
  {
    id: 'held-hr-grievance-notes',
    domain: 'hr',
    text: 'Grievance hearing – 6 Nov\nPresent: Joanna Nowak (employee), Desmond Achebe (union rep), Bethan Pritchard (HR, chair)\n\nMs Nowak stated that her shift supervisor, Craig Doherty, had repeatedly changed her rota at short notice after she raised a complaint in August. Craig has been invited to a separate meeting. Mr Achebe asked for the rota history to be shared before the outcome. Bethan to send the outcome letter by 13 Nov.',
    labels: [
      { type: 'PERSON', value: 'Joanna Nowak' },
      { type: 'PERSON', value: 'Nowak', occurrence: 2 },
      { type: 'PERSON', value: 'Desmond Achebe' },
      { type: 'PERSON', value: 'Achebe', occurrence: 2 },
      { type: 'PERSON', value: 'Bethan Pritchard' },
      { type: 'PERSON', value: 'Bethan', occurrence: 2 },
      { type: 'PERSON', value: 'Craig Doherty' },
      { type: 'PERSON', value: 'Craig', occurrence: 2 },
    ],
  },
  {
    id: 'held-hr-payslip-chat-known-name',
    domain: 'hr',
    text: "@priya can u send me last month's payslip for Zhang Wei? he reckons his tax code is wrong. his UTR is 4829173605 if HMRC ask. thx",
    labels: [
      { type: 'PERSON', value: 'priya' },
      { type: 'PERSON', value: 'Zhang Wei' },
      { type: 'UK_UTR', value: '4829173605' },
    ],
    knownValues: [{ type: 'PERSON', value: 'Wei Zhang' }],
  },
  {
    id: 'held-hr-reference-request',
    domain: 'hr',
    text: 'Dear Mr Hughes,\n\nWe have received an application from Mariam El-Sayed, who has given your name as a referee for her employment at Brackenfield Care Homes Ltd between 2019 and 2023. We would be grateful if you could confirm her dates of employment and job title, and comment on her suitability for a senior carer role.\n\nKind regards,\n\nOwen Llewellyn\nPeople Team, Tyrrell & Moss Recruitment\nowen.llewellyn@tyrrellmoss.example.co.uk | 0121 496 0915',
    labels: [
      { type: 'PERSON', value: 'Hughes' },
      { type: 'PERSON', value: 'Mariam El-Sayed' },
      { type: 'ORG', value: 'Brackenfield Care Homes Ltd' },
      { type: 'PERSON', value: 'Owen Llewellyn' },
      { type: 'ORG', value: 'Tyrrell & Moss Recruitment' },
      { type: 'EMAIL', value: 'owen.llewellyn@tyrrellmoss.example.co.uk' },
      { type: 'PHONE', value: '0121 496 0915' },
    ],
  },
  {
    id: 'held-hr-right-to-work-check',
    domain: 'hr',
    text: 'RTW check – Sandeep Gill\nUK passport 503826197 seen (original), expires 08/2031.\nAlso saw photocard driving licence GILL9805226SK9QW, DOB 22/05/1986 matches both.\nShare code not needed for British citizens.\nChecked by Fiona (HR), 11/11/2026.',
    labels: [
      { type: 'PERSON', value: 'Sandeep Gill' },
      { type: 'UK_PASSPORT', value: '503826197' },
      { type: 'UK_DRIVING_LICENCE', value: 'GILL9805226SK9QW' },
      { type: 'DATE_OF_BIRTH', value: '22/05/1986' },
      { type: 'PERSON', value: 'Fiona' },
    ],
  },
  {
    id: 'held-hr-leavers-list',
    domain: 'hr',
    text: 'Leavers – November\n- Ciarán Ó Súilleabháin, last day 15/11. P45 to home address: 7 Mill Lane, Hebden Bridge HX7 8AD\n- Agnieszka Zielińska, last day 22/11, relocating. Send P45 to a.zielinska@example.net\n- J. Mwangi – on garden leave until 30/11, no action\n- Kev (warehouse, agency) – check with the agency',
    labels: [
      { type: 'PERSON', value: 'Ciarán Ó Súilleabháin' },
      { type: 'ADDRESS', value: '7 Mill Lane' },
      { type: 'POSTCODE', value: 'HX7 8AD' },
      { type: 'PERSON', value: 'Agnieszka Zielińska' },
      { type: 'EMAIL', value: 'a.zielinska@example.net' },
      { type: 'PERSON', value: 'J. Mwangi' },
      { type: 'PERSON', value: 'Kev' },
    ],
  },

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------
  {
    id: 'held-health-gp-referral-letter',
    domain: 'health',
    text: 'Dear Dr Chaudhry,\n\nRe: Mr Babatunde Oyelaran, DOB 14.03.1987, NHS No. 780 436 4636\n61 Granby Street, Leicester LE1 6EJ. Tel: 0116 496 0382\n\nThank you for seeing this 39-year-old man with a six-month history of joint pain and morning stiffness affecting both hands. Bloods show a raised CRP. I would be grateful for your opinion on whether Mr Oyelaran would benefit from a DMARD.\n\nYours sincerely,\nDr Sarah Whitlock',
    labels: [
      { type: 'PERSON', value: 'Chaudhry' },
      { type: 'PERSON', value: 'Babatunde Oyelaran' },
      { type: 'PERSON', value: 'Oyelaran', occurrence: 2 },
      { type: 'DATE_OF_BIRTH', value: '14.03.1987' },
      { type: 'NHS_NUMBER', value: '780 436 4636' },
      { type: 'ADDRESS', value: '61 Granby Street' },
      { type: 'POSTCODE', value: 'LE1 6EJ' },
      { type: 'PHONE', value: '0116 496 0382' },
      { type: 'PERSON', value: 'Sarah Whitlock' },
    ],
  },
  {
    id: 'held-health-move-mums-appointment',
    domain: 'health',
    text: "hi i need to move my mums appointment, she's called Gwen Morgan, NHS number 6429933733, born 2/4/1948. its the one on thursday at 10.30 with dr patel. you can call me on 01632 960 417, I'm her daughter Carys",
    labels: [
      { type: 'PERSON', value: 'Gwen Morgan' },
      { type: 'NHS_NUMBER', value: '6429933733' },
      { type: 'DATE_OF_BIRTH', value: '2/4/1948' },
      { type: 'PERSON', value: 'patel' },
      { type: 'PHONE', value: '01632 960 417' },
      { type: 'PERSON', value: 'Carys' },
    ],
  },
  {
    id: 'held-health-pharmacy-new-address',
    domain: 'health',
    text: 'Dear Pharmacy team,\n\nPlease could my repeat prescription be delivered to my new address, 3A Harcourt Terrace, Edinburgh EH3 9LT, rather than the old one at 19 Leith Walk. My NHS number is 617 831 4930 and my date of birth is 25 December 1961 in case you need it. You can reach me on 0131 496 0558.\n\nMany thanks,\nMohammed Al-Rashid',
    labels: [
      { type: 'ADDRESS', value: '3A Harcourt Terrace' },
      { type: 'POSTCODE', value: 'EH3 9LT' },
      { type: 'ADDRESS', value: '19 Leith Walk' },
      { type: 'NHS_NUMBER', value: '617 831 4930' },
      { type: 'DATE_OF_BIRTH', value: '25 December 1961' },
      { type: 'PHONE', value: '0131 496 0558' },
      { type: 'PERSON', value: 'Mohammed Al-Rashid' },
    ],
  },
  {
    id: 'held-health-clinic-note',
    domain: 'health',
    text: 'Clinic note 11/11: Ms Ngozi Eze, 34, attended with her partner Kofi. BP 142/91, repeat in 2/52. Discussed lifestyle changes and home monitoring. Pt mobile +447700900903 – happy to receive texts. Letter to GP (Dr Fitzgerald), cc pt.',
    labels: [
      { type: 'PERSON', value: 'Ngozi Eze' },
      { type: 'PERSON', value: 'Kofi' },
      { type: 'PHONE', value: '+447700900903' },
      { type: 'PERSON', value: 'Fitzgerald' },
    ],
  },
  {
    id: 'held-health-insurer-claim-form',
    domain: 'health',
    text: 'Claim form – outpatient treatment\nPolicyholder: Li Na Chen\nDate of birth: 1979-11-30\nMembership no: BPH-5530912\nTreating consultant: Mr Ashok Raman\nHospital: Castlegate Private Clinic\nNHS number (if known): 461 989 6071\nPay benefit to: GB34 NWBK 2738 1777 7522 02',
    labels: [
      { type: 'PERSON', value: 'Li Na Chen' },
      { type: 'DATE_OF_BIRTH', value: '1979-11-30' },
      { type: 'PERSON', value: 'Ashok Raman' },
      { type: 'ORG', value: 'Castlegate Private Clinic' },
      { type: 'NHS_NUMBER', value: '461 989 6071' },
      { type: 'IBAN', value: 'GB34 NWBK 2738 1777 7522 02' },
    ],
  },
  {
    id: 'held-health-child-111-sloppy',
    domain: 'health',
    text: 'rang 111 last nite about my son jayden hes 4 (dob 18/06/2022) and they said take him to a&e. can i get a note for work for tues & weds? my name is shanice campbell, nhs no 699 246 9444, im registered with dr hussain',
    labels: [
      { type: 'PERSON', value: 'jayden' },
      { type: 'DATE_OF_BIRTH', value: '18/06/2022' },
      { type: 'PERSON', value: 'shanice campbell' },
      { type: 'NHS_NUMBER', value: '699 246 9444' },
      { type: 'PERSON', value: 'hussain' },
    ],
  },
  {
    id: 'held-health-physio-known-patient',
    domain: 'health',
    text: 'Patient: VAUGHAN-JONES, Eleri\nNHS: 468 702 0836   DOB: 09/01/1985\nSeen in physio clinic for L knee. Eleri reports pain improved since last visit; continue exercises, review in 6/52.',
    labels: [
      { type: 'PERSON', value: 'VAUGHAN-JONES' },
      { type: 'PERSON', value: 'Eleri' },
      { type: 'NHS_NUMBER', value: '468 702 0836' },
      { type: 'DATE_OF_BIRTH', value: '09/01/1985' },
    ],
    knownValues: [
      { type: 'PERSON', value: 'Eleri Vaughan-Jones' },
      { type: 'NHS_NUMBER', value: '4687020836' },
      { type: 'DATE_OF_BIRTH', value: '1985-01-09' },
    ],
  },

  // -------------------------------------------------------------------------
  // finance
  // -------------------------------------------------------------------------
  {
    id: 'held-finance-deposit-return-chat',
    domain: 'finance',
    text: "hiya, can you send the deposit back to my account pls - name on the account is Mr P Szymański, sort code 30-96-26, acc no 00418827. or use IBAN GB50 HBUK 1433 5510 9267 84 if that's easier for you",
    labels: [
      { type: 'PERSON', value: 'P Szymański' },
      { type: 'SORT_CODE', value: '30-96-26' },
      { type: 'BANK_ACCOUNT', value: '00418827' },
      { type: 'IBAN', value: 'GB50 HBUK 1433 5510 9267 84' },
    ],
  },
  {
    id: 'held-finance-invoice-email',
    domain: 'finance',
    text: 'Hi Adebola,\n\nPlease find attached invoice INV-20931 for £4,250.00 + VAT, due 30 November. Our VAT number is GB 589 1864 23.\n\nBank details: Kestrel Joinery Ltd, sort code 04-00-75, account 19284756.\n\nThanks,\nMarcus Bell\nKestrel Joinery',
    labels: [
      { type: 'PERSON', value: 'Adebola' },
      { type: 'UK_VAT', value: 'GB 589 1864 23' },
      { type: 'ORG', value: 'Kestrel Joinery Ltd' },
      { type: 'SORT_CODE', value: '04-00-75' },
      { type: 'BANK_ACCOUNT', value: '19284756' },
      { type: 'PERSON', value: 'Marcus Bell' },
      { type: 'ORG', value: 'Kestrel Joinery', occurrence: 2 },
    ],
  },
  {
    id: 'held-finance-self-assessment-known-user',
    domain: 'finance',
    text: "Hi Sam,\n\nAttached is my P60 for the self-assessment. My UTR is 7391046628 and NI number KE807020C. Niamh will send hers separately as she's filing on her own this year.\n\nI moved in July so please update my address to 22 Beech Grove, Harrogate HG2 0EZ, and reply to Rob.Lindqvist@example.com rather than my work email.\n\nThanks,\nRobert",
    labels: [
      { type: 'PERSON', value: 'Sam' },
      { type: 'UK_UTR', value: '7391046628' },
      { type: 'UK_NINO', value: 'KE807020C' },
      { type: 'PERSON', value: 'Niamh' },
      { type: 'ADDRESS', value: '22 Beech Grove' },
      { type: 'POSTCODE', value: 'HG2 0EZ' },
      { type: 'EMAIL', value: 'Rob.Lindqvist@example.com' },
      { type: 'PERSON', value: 'Robert' },
    ],
    knownValues: [
      { type: 'PERSON', value: 'Robert Lindqvist' },
      { type: 'EMAIL', value: 'rob.lindqvist@example.com' },
    ],
  },
  {
    id: 'held-finance-card-dispute-call',
    domain: 'finance',
    text: 'Call 11:42 – Mrs Halima Yusuf disputing £79.99 charged to card 5105 1051 0510 5100 on 2 Nov for a gym membership she cancelled in September. ID&V passed (DOB 07/08/1972, postcode M14 5RL). Last online login from 198.51.100.23. Raised chargeback, ref CB-77120. Told cust 10 working days.',
    labels: [
      { type: 'PERSON', value: 'Halima Yusuf' },
      { type: 'CARD_NUMBER', value: '5105 1051 0510 5100' },
      { type: 'DATE_OF_BIRTH', value: '07/08/1972' },
      { type: 'POSTCODE', value: 'M14 5RL' },
      { type: 'IP_ADDRESS', value: '198.51.100.23' },
    ],
  },
  {
    id: 'held-finance-mortgage-application',
    domain: 'finance',
    text: 'Applicant 1: Darragh Byrne – DOB 1988-04-12\nApplicant 2: Precious Byrne (née Okafor) – DOB 1990-10-03\nCurrent address: Flat 7, 15 Canal Street, Manchester M1 3HE (3 yrs 2 mths)\nEmployer (A1): Ferncliff Analytics Ltd – Senior Data Engineer\nGross basic (A1): £58,000\nID (A2): UK passport 120938475\nDeposit: £42,500 from savings',
    labels: [
      { type: 'PERSON', value: 'Darragh Byrne' },
      { type: 'DATE_OF_BIRTH', value: '1988-04-12' },
      { type: 'PERSON', value: 'Precious Byrne' },
      { type: 'PERSON', value: 'Okafor' },
      { type: 'DATE_OF_BIRTH', value: '1990-10-03' },
      { type: 'ADDRESS', value: '15 Canal Street' },
      { type: 'POSTCODE', value: 'M1 3HE' },
      { type: 'ORG', value: 'Ferncliff Analytics Ltd' },
      { type: 'UK_PASSPORT', value: '120938475' },
    ],
  },
  {
    id: 'held-finance-failed-overseas-payment',
    domain: 'finance',
    text: 'Our payment to the Lyon supplier bounced this morning. Beneficiary: Atelier Rousseau SARL, IBAN FR14 2004 1010 0505 0001 3M02 606. Requested by Gareth Price (4 Nov), approved by Shabnam. Can someone check whether the BIC we used was wrong?',
    labels: [
      { type: 'ORG', value: 'Atelier Rousseau SARL' },
      { type: 'IBAN', value: 'FR14 2004 1010 0505 0001 3M02 606' },
      { type: 'PERSON', value: 'Gareth Price' },
      { type: 'PERSON', value: 'Shabnam' },
    ],
  },
  {
    id: 'held-finance-leaked-keys-ticket',
    domain: 'finance',
    text: `Our Xero sync broke again. This is what Jamal pasted into the ticket:\n\nSTRIPE_SECRET_KEY=${FAKE_SECRETS.stripe}\n\nCan someone rotate it today? Also, the shared accounts login (accounts@example.co.uk) is still using the password ${FAKE_SECRETS.password} – that needs changing too.`,
    labels: [
      { type: 'PERSON', value: 'Jamal' },
      { type: 'SECRET', value: FAKE_SECRETS.stripe },
      { type: 'EMAIL', value: 'accounts@example.co.uk' },
      { type: 'SECRET', value: FAKE_SECRETS.password },
    ],
  },

  // -------------------------------------------------------------------------
  // b2b
  // -------------------------------------------------------------------------
  {
    id: 'held-b2b-account-update-known-client',
    domain: 'b2b',
    text: 'Quick update on the Halden account: they want Kittiwake phase 2 scoped by January. Their ops director, Nkechi Obi, is our main contact (n.obi@example.com, 0113 496 0274). Legal have asked that HALDEN LOGISTICS LTD is named as the contracting entity on the SOW.',
    labels: [
      { type: 'ORG', value: 'Halden', occurrence: 1 },
      { type: 'ORG', value: 'Kittiwake' },
      { type: 'PERSON', value: 'Nkechi Obi' },
      { type: 'EMAIL', value: 'n.obi@example.com' },
      { type: 'PHONE', value: '0113 496 0274' },
      { type: 'ORG', value: 'HALDEN LOGISTICS LTD' },
    ],
    knownValues: [
      { type: 'ORG', value: 'Halden Logistics Ltd' },
      { type: 'ORG', value: 'Project Kittiwake' },
    ],
  },
  {
    id: 'held-b2b-sales-follow-up-email',
    domain: 'b2b',
    text: "Hi Ms Kaur,\n\nThanks for your time on the call this morning. As promised, I've attached our proposal for Brightwater Dental Group, including the multi-site pricing we discussed. I'd be happy to come in and walk Dr Lewis and Dr Mbeki through it – would the week of the 24th work?\n\nBest wishes,\n\nTom Ashworth\nAccount Executive | Lumen Field Software Ltd\n020 7946 0851 | tom.ashworth@lumenfield.example.com",
    labels: [
      { type: 'PERSON', value: 'Kaur' },
      { type: 'ORG', value: 'Brightwater Dental Group' },
      { type: 'PERSON', value: 'Lewis' },
      { type: 'PERSON', value: 'Mbeki' },
      { type: 'PERSON', value: 'Tom Ashworth' },
      { type: 'ORG', value: 'Lumen Field Software Ltd' },
      { type: 'PHONE', value: '020 7946 0851' },
      { type: 'EMAIL', value: 'tom.ashworth@lumenfield.example.com' },
    ],
  },
  {
    id: 'held-b2b-api-401-ticket',
    domain: 'b2b',
    text: `Subject: 401 errors since 09:00\n\nHi, our integration started returning 401 Unauthorized this morning. Org: Pennant & Hale Solicitors LLP. The key we're sending is ${FAKE_SECRETS.openai}. Requests come from 198.51.100.140 and 2001:db8:4a1::17. Contact Rajesh Iyer in IT (raj@pennanthale.example.co.uk) if you need more.`,
    labels: [
      { type: 'ORG', value: 'Pennant & Hale Solicitors LLP' },
      { type: 'SECRET', value: FAKE_SECRETS.openai },
      { type: 'IP_ADDRESS', value: '198.51.100.140' },
      { type: 'IP_ADDRESS', value: '2001:db8:4a1::17' },
      { type: 'PERSON', value: 'Rajesh Iyer' },
      { type: 'EMAIL', value: 'raj@pennanthale.example.co.uk' },
    ],
  },
  {
    id: 'held-b2b-supplier-onboarding-form',
    domain: 'b2b',
    text: 'Supplier name: Moorfoot Packaging Ltd\nCompany no: 08812345\nVAT reg: GB594974024\nRemittance contact: Ffion Evans, accounts@moorfoot.example.com\nTel: 029 2018 0466\nRegistered office: Unit 4, 210 Penarth Road, Cardiff CF11 8NR\nBank: sort code 40-11-62, acct 73021958',
    labels: [
      { type: 'ORG', value: 'Moorfoot Packaging Ltd' },
      { type: 'UK_VAT', value: 'GB594974024' },
      { type: 'PERSON', value: 'Ffion Evans' },
      { type: 'EMAIL', value: 'accounts@moorfoot.example.com' },
      { type: 'PHONE', value: '029 2018 0466' },
      { type: 'ADDRESS', value: '210 Penarth Road' },
      { type: 'POSTCODE', value: 'CF11 8NR' },
      { type: 'SORT_CODE', value: '40-11-62' },
      { type: 'BANK_ACCOUNT', value: '73021958' },
    ],
  },
  {
    id: 'held-b2b-kickoff-notes',
    domain: 'b2b',
    text: 'Kick-off – Corrigan Brothers Construction\nAttendees: Seamus Corrigan (MD), Yetunde Bakare (QS); ours: Chloe, Arjun\nActions:\n- Arjun to send RAMS by Fri\n- Seamus to confirm site access at 1 Dock Road, Grimsby\n- Chloe to set up shared folder on Google Drive\nNext meeting 20/11, 10am',
    labels: [
      { type: 'ORG', value: 'Corrigan Brothers Construction' },
      { type: 'PERSON', value: 'Seamus Corrigan' },
      { type: 'PERSON', value: 'Seamus', occurrence: 2 },
      { type: 'PERSON', value: 'Yetunde Bakare' },
      { type: 'PERSON', value: 'Chloe' },
      { type: 'PERSON', value: 'Arjun' },
      { type: 'ADDRESS', value: '1 Dock Road' },
    ],
  },
  {
    id: 'held-b2b-terms-chat',
    domain: 'b2b',
    text: "fyi the guys at Ashby Tile Co (Darius and Leon) want net-60 instead of net-30. Leon's mobile is 07700 900052 if u need him. dont cc Sharon on this, she's off til monday",
    labels: [
      { type: 'ORG', value: 'Ashby Tile Co' },
      { type: 'PERSON', value: 'Darius' },
      { type: 'PERSON', value: 'Leon' },
      { type: 'PHONE', value: '07700 900052' },
      { type: 'PERSON', value: 'Sharon' },
    ],
  },
  {
    id: 'held-b2b-contract-recital',
    domain: 'b2b',
    text: 'This Agreement is made on 1 October 2026 between Saltmarsh Digital Limited (company number 11223344), whose registered office is at 5 Quayside, Newcastle upon Tyne NE1 3DX, and Okoro & Partners LLP. Signed for and on behalf of Saltmarsh by Imogen Fairweather-Clarke, Director.',
    labels: [
      { type: 'ORG', value: 'Saltmarsh Digital Limited' },
      { type: 'ORG', value: 'Saltmarsh', occurrence: 2 },
      { type: 'ADDRESS', value: '5 Quayside' },
      { type: 'POSTCODE', value: 'NE1 3DX' },
      { type: 'ORG', value: 'Okoro & Partners LLP' },
      { type: 'PERSON', value: 'Imogen Fairweather-Clarke' },
    ],
  },

  // -------------------------------------------------------------------------
  // adversarial
  // -------------------------------------------------------------------------
  {
    id: 'held-adv-invalid-checksums',
    domain: 'adversarial',
    text: 'QA: these should all FAIL validation on the sign-up form – NHS 780 436 4637, card 4111 1111 1111 1113, IBAN GB51 HBUK 1433 5510 9267 84, NINO BG 12 34 56 A.',
    labels: [],
  },
  {
    id: 'held-adv-versions-and-codes',
    domain: 'adversarial',
    text: 'Upgraded the API gateway from v2.14.3 to v2.15.0 last night; build 20261104.2 went out at 02:17:44 UTC. Firmware on the scanners is 4.10.2.17. Replacement part no. 4410-2281-0093, SKU AB-1029-77, total £1,234.56 inc VAT.',
    labels: [],
  },
  {
    id: 'held-adv-place-names',
    domain: 'adversarial',
    text: 'Flights from Florence to Paris were cancelled, so we drove back through Chester and Lincoln instead, stopped at Victoria for a coffee, and got home to Reading just after midnight.',
    labels: [],
  },
  {
    id: 'held-adv-sentence-initial-words',
    domain: 'adversarial',
    text: 'Will this work on Safari? Mark the ticket as resolved if so. Grace period for the trial is 14 days. Bill monthly, not annually. Rose 3% last quarter, which finance were pleased with.',
    labels: [],
  },
  {
    id: 'held-adv-brands-and-public-bodies',
    domain: 'adversarial',
    text: "I tried paying through PayPal and then Barclays but both failed. HMRC say my tax return is fine and the DVLA still haven't replied. Have you raised it with Microsoft support or asked in the Slack channel? Tesco and Amazon deliver here with no problems.",
    labels: [],
  },
  {
    id: 'held-adv-code-snippet',
    domain: 'adversarial',
    text: "const user = await prisma.user.findUnique({ where: { id: 'clx9z2k0000' } });\nif (!user) throw new Error('User not found');\nlogger.warn('retrying', { attempt: 3, delayMs: 2500 });",
    labels: [],
  },
  {
    id: 'held-adv-team-sign-off',
    domain: 'adversarial',
    text: 'Thanks for getting in touch! Your request has been logged and someone will reply within 2 working days.\n\nKind regards,\nThe Customer Experience Team\nReference: CX-552019 | Opening hours Mon–Fri 9am–5pm',
    labels: [],
  },
  {
    id: 'held-adv-non-birth-dates-and-money',
    domain: 'adversarial',
    text: 'The lease started on 01/04/2019 and renews on 31/03/2027. Rent is £1,150 pcm and the deposit of £1,326.92 was paid on 15.05.2019. The building itself dates from 1987.',
    labels: [],
  },
  {
    id: 'held-adv-tracking-number',
    domain: 'adversarial',
    text: 'Your tracking number is 7700900123 and your parcel weighs 2.4 kg. It will be held at locker 14B for 72 hours.',
    labels: [],
  },
  {
    id: 'held-adv-mixed-one-valid-nhs',
    domain: 'adversarial',
    text: 'Can you check these two NHS numbers for Mr Desai? The first is from the referral letter dated 03-11-26, the second from our system: 744 008 3016 and 744 008 3017.',
    labels: [
      { type: 'PERSON', value: 'Desai' },
      { type: 'NHS_NUMBER', value: '744 008 3016' },
    ],
  },
  {
    id: 'held-adv-mixed-names-that-are-places',
    domain: 'adversarial',
    text: 'Florence from accounts says the Paris office is closing in March, so Chester Okafor-Hughes will cover the Reading and Lincoln clients from the Leeds hub.',
    labels: [
      { type: 'PERSON', value: 'Florence' },
      { type: 'PERSON', value: 'Chester Okafor-Hughes' },
    ],
  },
];
