# Business Applications for Agentic AI

Real-world opportunities for the Sunrise agentic orchestration platform, framed for a venture studio exploring where to deploy this technology to create commercial value and genuine positive impact.

**Last updated:** 2026-04-29

## How This Document Works

**Who is this for?** A small team of engineers who can partner with domain experts or existing organisations to build agentic AI products on Sunrise.

**Framing:** Every opportunity is described as something a small team can realistically start. The worked examples follow a trojan horse pattern: begin with a narrow, high-value wedge that earns trust and revenue, then expand from that foothold. We are not interested in automating the crappy world of the past faster. We are interested in structural shifts — things that become possible for the first time, or that transform the experience so fundamentally that the old way looks absurd in hindsight.

**What makes agentic AI different from chatbots or automation?** Three things that matter for business applications:

1. **Agency** — the system can use tools, query databases, call APIs, and take actions on behalf of users, not just generate text
2. **Orchestration** — multi-step workflows with branching logic, error recovery, human approval gates, and cost controls
3. **Knowledge** — grounded in domain-specific documents, not just general training data

These three properties together mean a Sunrise deployment can act as a knowledgeable, capable junior colleague in any domain — not a search engine, not a form-filler, but something that can actually do work.

**Sunrise-specific advantages for venture studio plays:**

- Embeddable chat widget means you can deploy into a partner's existing site without rebuilding anything
- Multi-provider LLM support with cost tracking means you can start cheap (Ollama/local) and scale to production (Anthropic/OpenAI) without re-architecture
- Knowledge base with document ingestion means domain expertise can be loaded, not coded
- Workflow engine with approval gates and a dedicated admin approval queue means human oversight is built in — critical for regulated domains
- Budget controls and cost tracking mean you can offer predictable pricing from day one
- Admin UI means non-technical partners can manage agents, update knowledge, and monitor costs

**For each category below:**

- **Paradigm shift** — what's structurally different, not just incrementally better
- **Subcategories** — the range of applications within this pattern
- **Worked example** — one specific opportunity with problem, solution, go-to-market, and realistic starting point

---

## 1. Conversational Experiences Replacing Linear Processes

### Paradigm shift

Forms, surveys, and intake processes were designed for databases, not humans. They force people into a structure that suits the system. Agentic AI inverts this: the user talks naturally, the agent handles the structure behind the scenes. The experience shifts from "fill in box 47" to "tell me about your situation." This isn't cosmetic — it changes completion rates, data quality, and who can access the process (language barriers, literacy, neurodivergence).

### Subcategories

#### Intake and applications

_planning permission, benefits claims, insurance, grant applications_

A small housing association could deploy an agent that walks tenants through repair request submissions conversationally — "describe what's happening and where" — instead of forcing them through a dropdown menu of categories that never quite fit. The agent captures photos, classifies urgency, and generates a structured work order. Starting with one housing association, this could expand to other form-heavy intake processes across local government and social housing.

##### Getting started

Approach a housing association's operations director directly — they're usually drowning in repair admin and would likely trial something low-risk on one estate.

#### Surveys and feedback

_customer research, employee engagement, community consultation_

A market research firm could offer conversational surveys as a premium service — instead of "rate 1-5", the agent asks "tell me about your last experience with this product" and follows up on interesting threads. The output is both structured data (for quantitative analysis) and rich qualitative insight. This could start as a bolt-on service for existing research agencies, with the differentiation being depth of insight per respondent rather than volume.

##### Getting started

Build a working demo with a sample survey and cold-approach 3-4 boutique research agencies on LinkedIn — the founders of small agencies tend to be accessible and always looking for differentiation.

#### Onboarding and setup

_software configuration, account setup, new employee orientation_

A B2B SaaS company with a complex setup process (say, accounting software for small businesses) could embed a Sunrise agent as their onboarding assistant. Instead of a 15-step wizard with help text nobody reads, the agent asks about the business and configures the software accordingly. "Do you handle VAT? Do you have employees or is it just you? Do you invoice internationally?" This could be offered to SaaS companies as a white-label onboarding service.

##### Getting started

Identify a SaaS product we already use that has painful onboarding, build a prototype against their public docs, and approach their head of customer success with a demo.

#### Assessments and diagnostics

_health screening, skills assessment, needs analysis_

A corporate training company could deploy an agent that assesses employee skill levels conversationally before assigning courses — rather than a generic multiple-choice test. "Tell me about a recent project where you had to use data analysis" reveals more about actual competence than "which function calculates the mean in Excel?" Partner with one L&D team, measure whether course assignment accuracy improves.

##### Getting started

Reach out to L&D managers at mid-size companies via LinkedIn — they frequently post about training challenges and are usually receptive to pilots that make their budget more effective.

#### Configuration and product selection

_complex product choices (insurance, IT systems, financial products)_

An independent insurance broker could embed an agent that helps customers navigate product selection: "I'm a freelance graphic designer working from home, I need professional indemnity and probably public liability, but I'm not sure what else." The agent asks about their specific situation and recommends coverage, rather than presenting a comparison table of 30 products with incomprehensible feature matrices. Revenue via referral commission from underwriters.

##### Getting started

Find a local independent broker through personal network or BNI group — insurance brokers are always looking for lead generation tools and the commission model means low risk for them.

#### Complaints and dispute resolution

_structured complaint capture with empathy and follow-through_

A mid-size retailer could deploy an agent that handles complaints with genuine understanding rather than the typical chatbot deflection. The agent captures the issue conversationally, cross-references order history via a capability, and proposes a resolution within defined parameters. The interesting part: the conversational capture produces much richer data about what's actually going wrong than a dropdown-driven complaint form, potentially feeding back into product or service improvements.

##### Getting started

Build a prototype using a fictional retailer scenario and demo it at a DTC (direct-to-consumer) brand meetup or e-commerce networking event — founders of growing brands feel the complaints problem acutely.

### Worked example: Council planning application pre-screening

**The opportunity:** Anyone who's applied for planning permission knows the experience: a dense PDF guide, a rigid online form, and a good chance of rejection because you filled something in wrong or missed a requirement. Planning officers likely spend a significant chunk of their time on back-and-forth clarification rather than actual planning assessment. There might be an interesting opportunity in making this process conversational — particularly for homeowners and small builders who don't have an architect handling the paperwork.

**How Sunrise addresses it:** Deploy an agent with the council's planning policy documents loaded into the knowledge base. The agent conducts a conversational pre-screening: "Tell me about your property and what you'd like to build." It asks follow-up questions based on what it learns (is the property listed? conservation area? party wall implications?), flags likely issues ("your extension exceeds the permitted development height — you'll need full planning permission, not a certificate of lawfulness"), and generates a pre-populated application with the correct forms attached. A workflow with an approval gate lets a planning officer review the AI's assessment before it goes to the applicant.

**Venture studio path:** Partner with one council. Offer a 3-month pilot at cost, measured by reduction in incomplete submissions. Revenue model: per-application fee (paid by council from savings on officer time) or SaaS subscription. Trojan horse: once the planning team trusts the system, expand to building control, licensing, and other council services that suffer the same problem. Longer term: white-label for local government SaaS providers who serve hundreds of councils.

**Value-based sales message:** "What if residents could describe their project in plain English and get told exactly what they need to submit — before they waste time on the wrong form?"

**Starting point:** One agent, loaded with one council's planning policy documents. Embed widget on the council's planning page. No integrations needed for the pilot — it generates a PDF the applicant submits normally. Validate with 50 applications over 8 weeks.

---

## 2. Democratising Expert Knowledge

### Paradigm shift

Expert knowledge has always been locked behind expensive professionals or years of personal experience. Pre-AI, the options were: hire someone (expensive), read a book (time-consuming and context-free), or ask a forum (unreliable). Agentic AI can deliver contextualised, grounded expert guidance — not medical diagnosis or legal advice, but the kind of knowledgeable conversation you'd have with a friend who happens to be an expert. The shift is from "access to information" to "access to applied judgment."

### Subcategories

#### Health and wellness guidance

_nutrition, exercise programming, symptom triage, chronic condition management_

A sports nutritionist could partner with us to build an agent that creates personalised meal plans for amateur athletes — "I'm training for a marathon, I'm vegetarian, and I have a modest weekly food budget." The agent asks about training schedule, dietary preferences, cooking ability, and builds week-by-week nutrition guidance grounded in the nutritionist's methodology. Start with one sport (endurance running has a large, engaged amateur community), validate with a running club, then expand to other disciplines.

##### Getting started

Post in running forums or Strava clubs asking if anyone would beta-test a nutrition advisor — the endurance community is vocal and loves new tools.

#### Legal rights and obligations

_tenancy, employment, consumer rights, small business compliance_

An employment law specialist could build an agent that helps employees understand their rights in workplace disputes — redundancy, disciplinary proceedings, discrimination concerns. "My employer has put me on a PIP and I think it's retaliatory." The agent identifies the relevant employment law, suggests next steps, and generates template letters (grievance, subject access request). Revenue via referral to employment solicitors for cases that need professional representation, or subscription from trade unions wanting to augment their member advice services.

##### Getting started

Approach a high-street employment law solicitor who does free initial consultations — they already give away basic guidance and would benefit from a referral channel that pre-qualifies cases.

#### Financial planning and literacy

_budgeting, debt management, pension decisions, tax guidance_

An independent financial educator could deploy an agent that helps people understand their pension options — a topic where most people feel bewildered. "I'm 45, I have three old workplace pensions and a SIPP, and I have no idea whether I'm on track." The agent helps consolidate information, explains the implications of different retirement ages, and flags basic issues (fees, fund allocation). It's explicitly not financial advice — but it's the informed conversation most people have never had. Revenue via subscription or partnership with pension providers.

##### Getting started

Search for financial educators on YouTube or Instagram who already create pension content — they have the domain knowledge, the audience, and the frustration of not being able to personalise at scale.

#### Technical and trade skills

_home DIY, car maintenance, electronics repair, woodworking_

A retired master carpenter could partner to build a woodworking advisor. "I want to build a bookcase, I have basic tools, and I've never done joinery." The agent assesses skill level, recommends an appropriate project plan, explains techniques with reference to the carpenter's documented methods, suggests materials, and troubleshoots problems ("the joint is gapping on one side — what might I be doing wrong?"). Monetise via subscription plus affiliate relationships with timber merchants and tool suppliers.

##### Getting started

Visit a local Men's Shed or woodworking guild — retirees with deep craft knowledge who'd enjoy the project of documenting their expertise and seeing it used.

#### Creative and artistic practice

_photography technique, music theory, writing craft, design principles_

A photography school could extend their reach beyond in-person workshops with an agent that critiques and coaches. A learner describes or uploads their shot: "I was trying to capture golden hour on the coast but the sky is blown out." The agent provides technique advice grounded in the school's teaching methodology — exposure compensation, graduated filters, bracketing. Start with landscape photography (enthusiastic amateur market), expand to other genres. Revenue as a premium tier on the school's existing membership.

##### Getting started

Approach a photography workshop business that already sells online courses — they have the content and audience, we add the interactive layer they can't build themselves.

#### Agriculture and land management

_crop planning, soil health, pest management, smallholding guidance_

A smallholding advisor could build an agent for new smallholders — people who've bought a few acres and are figuring out what to do with it. "I've got 5 acres of rough pasture in Devon, I'm thinking about keeping a few pigs and planting an orchard." The agent helps plan realistically based on land type, climate, regulations (livestock registration, movement licences), and budget. The smallholding community is growing, well-networked online, and underserved by generic farming advice that assumes scale.

##### Getting started

The Smallholding & Countryside Festival and online communities like the Accidental Smallholder forum are where these people gather — post there, find a knowledgeable smallholder who'd co-create.

#### Parenting and caregiving

_child development, elder care navigation, special educational needs_

A SEND (Special Educational Needs and Disabilities) advocate could build an agent that helps parents navigate the EHCP (Education, Health and Care Plan) process — which is notoriously complex and adversarial. "My child has been assessed as needing speech therapy but the school says they don't have funding." The agent explains the process, identifies what the parent is entitled to request, helps draft letters, and suggests next steps. This is a space where knowledge asymmetry between parents and local authorities is acute, and professional SEND advocates are expensive.

##### Getting started

SEND parent Facebook groups are intensely active and full of experienced advocates — find one who's already helping other parents informally and offer to turn their knowledge into something scalable.

#### Mental health and wellbeing

_self-help techniques, CBT exercises, crisis signposting (not therapy)_

A clinical psychologist with expertise in evidence-based self-help could build an agent that guides users through structured CBT exercises and wellbeing practices. Explicitly not therapy — more like a well-informed workbook that can adapt to your responses and guide you through exercises interactively. "I'm struggling with sleep anxiety — I keep worrying about not sleeping, which keeps me awake." The agent walks through cognitive restructuring and sleep hygiene, adapted to the specific worry pattern described. Crisis situations always route to Samaritans or 111. Revenue via subscription, with potential B2B sales to employers as a wellbeing benefit.

##### Getting started

Approach a clinical psychologist who already publishes self-help books or workbooks — they've already packaged their methodology and understand the boundary between self-help and therapy.

### Worked example: Garden planning advisor for hobby gardeners

**The opportunity:** Gardening advice is highly contextual — it depends on soil type, aspect, climate zone, what's already planted, and what the gardener actually wants (food production? wildlife? low maintenance?). Online advice tends to be generic ("plant tomatoes in May"), books can't account for your specific garden, and hiring a garden designer can cost several hundred pounds for even a basic consultation. There's something appealing about the idea of a knowledgeable gardening companion that actually knows your specific plot — it's the kind of contextual, ongoing relationship that agentic AI is well suited to.

**How Sunrise addresses it:** An agent with horticultural knowledge loaded into the knowledge base (RHS guidance, soil science basics, companion planting data, regional climate data). The agent conducts an initial garden assessment conversationally: dimensions, aspect, soil type (with guidance on how to test it), existing plants, goals. It then acts as an ongoing advisor — the gardener can ask "I've got a shady 2m x 3m patch that's clay soil, what should I plant for pollinators?" and get grounded, specific recommendations. A workflow capability could generate seasonal task lists. The knowledge base can be expanded with local allotment society knowledge for hyper-local relevance.

**Venture studio path:** Partner with a horticultural expert (retired RHS advisor, experienced head gardener) who provides the domain knowledge and credibility. Start as a direct-to-consumer subscription (low — maybe a few pounds per month) via an app with the Sunrise embed widget. The trojan horse: once you have an engaged user base, you're potentially a channel for garden centres, seed suppliers, and tool manufacturers who pay for contextual recommendations ("based on your plan, you'll need 3kg of this specific seed — here's where to buy it"). The UK gardening market is substantial and dominated by generic content — worth exploring whether personalised, contextual guidance can carve out a niche.

**Value-based sales message:** "A knowledgeable gardening friend who knows your specific garden — not generic advice from the internet, but recommendations grounded in your soil, your aspect, and what you actually want to grow."

**Starting point:** One agent, knowledge base loaded with publicly available RHS guidance and companion planting data. Focus on UK kitchen gardens initially (narrow, high-intent audience). Test with a landing page and 100 beta users from gardening forums. Validate whether users return weekly (the key retention metric for a subscription model).

---

## 3. Micro-SaaS for Underserved Verticals

### Paradigm shift

Enterprise software serves big markets. Niche industries — independent tattoo studios, small letting agencies, mobile dog groomers — get spreadsheets, generic tools badly adapted, or nothing. Pre-AI, building vertical SaaS for a market of 10,000 businesses was economically marginal: development costs were too high relative to the addressable revenue. Agentic AI changes the economics: a knowledge-base-powered agent can handle the "long tail" of domain-specific logic that would otherwise require months of custom development. One engineer plus one domain expert can build what previously needed a team of ten.

### Subcategories

#### Creative trades

_tattoo studios, florists, bespoke furniture makers, jewellers, wedding photographers_

A high-end florist could use an agent to handle wedding flower consultations — "we're getting married in October, our venue is a converted barn, budget is around 2k, and I love peonies but not sure what's seasonal." The agent captures the brief conversationally, references the florist's portfolio and seasonal availability data, and produces a proposal draft with mood board suggestions. The florist reviews and refines rather than spending 90 minutes on a first consultation. Scale across independent florists who each get their own instance.

##### Getting started

Attend a wedding industry networking event or approach florists through the British Florist Association — wedding season pressure makes them receptive to anything that saves consultation time.

#### Professional services

_small solicitors, independent accountants, surveyors, architects_

A small accountancy practice could deploy an agent that handles initial client enquiries and tax questionnaires. Instead of emailing a spreadsheet to gather self-assessment information, the agent asks: "Did you have any income from property this year? Any capital gains? Did you make any pension contributions?" It builds a structured pre-engagement pack the accountant uses to prepare the return. Saves time per client and creates a more professional first impression. Revenue via monthly SaaS fee per practice.

##### Getting started

Our own accountant is the obvious first conversation — they know the pain firsthand and can introduce us to their peer network.

#### Hospitality and food

_independent restaurants, B&Bs, food trucks, catering companies_

An independent B&B could use an agent as a concierge — embedded on their website and available to guests during their stay. "We're here for three nights with two kids under 10 — what should we do tomorrow if it rains?" The agent knows the local area (loaded into the knowledge base by the owner), the B&B's own facilities, and can suggest restaurants with availability. It also handles pre-booking questions and dietary requirement capture. Start with a cluster of B&Bs in one tourist area, making the local knowledge base a shared asset.

##### Getting started

Pick a tourist area we know well, build a prototype with local knowledge pre-loaded, and offer it free to 3-4 B&Bs for a season — the shared local knowledge base is the hook.

#### Trades and fieldwork

_plumbers, electricians, landscapers, pest control, window cleaners_

A landscaping company could deploy an agent that handles initial site enquiries: "I've got a neglected garden, about 15m x 8m, mostly overgrown lawn and some old shrubs, and I want something low-maintenance." The agent captures photos, asks about access, budget, and preferences, and generates a scoping document the landscaper uses to prepare a quote — rather than spending an hour on a site visit before knowing if the job is viable. Could save a significant number of wasted site visits per month.

##### Getting started

Find a landscaper through Checkatrade or Bark who's getting more enquiries than they can handle — the pain of wasted site visits is immediate and quantifiable.

#### Health practitioners

_physiotherapists, osteopaths, counsellors, nutritionists, speech therapists_

A private counselling practice could use an agent to handle intake assessments. Rather than a clinical questionnaire form, the agent has a warm, conversational interaction that captures presenting issues, history, preferences (modality, session format), and practical details. The output is a structured intake summary for the therapist. This improves the client's first experience of the practice and gives the therapist better context before the first session. Revenue as part of a practice management SaaS.

##### Getting started

Approach the BACP (British Association for Counselling and Psychotherapy) local network or a group practice — group practices feel the intake admin burden more acutely than solo practitioners.

#### Education providers

_private tutors, small training companies, music teachers, driving schools_

A driving school could deploy an agent that handles learner intake and theory test preparation. "I've had 5 lessons before with another instructor, I'm OK with roundabouts but junctions terrify me." The agent captures experience level, builds a learning plan recommendation for the instructor, and between lessons acts as a theory test tutor — asking questions conversationally rather than through a multiple-choice app. Revenue per driving school, scaling through instructor networks.

##### Getting started

Driving instructors are prolific on TikTok and YouTube — find one with a following who'd see the theory test tutor angle as content marketing for their school.

### Worked example: Independent tattoo studio management

**The opportunity:** A typical independent tattoo studio (1-4 artists) manages bookings via Instagram DMs, deposits via bank transfer, consent forms on paper, design briefs through scattered WhatsApp messages, and aftercare instructions verbally. They probably lose bookings when they're slow to respond to DMs while tattooing. Design consultations are time-consuming because clients often can't articulate what they want. Existing booking software (Fresha, Booksy) handles appointments but none of the domain-specific workflow. This is a good example of a vertical where the real value isn't in scheduling — it's in the creative intake conversation that no generic tool handles.

**How Sunrise addresses it:** An agent embedded on the studio's website and linked from their Instagram bio handles initial enquiries conversationally: "What kind of tattoo are you thinking about? Where on your body? How big? Any reference images?" It captures the design brief, collects style preferences, checks the right artist's availability, takes a deposit (via a capability calling Stripe), sends consent forms, and follows up with aftercare instructions post-appointment. The knowledge base contains the studio's style portfolio, pricing guidelines, and aftercare protocols. A workflow handles the no-show policy automatically (reminder 48h before, forfeit deposit policy).

**Venture studio path:** Partner with 2-3 studio owners for a pilot. Charge a flat monthly fee that's less than what they lose to one no-show. Trojan horse: once the booking agent is trusted, expand to flash day management, guest artist coordination, and client portfolio management. Scale by templating the agent — each studio gets their own instance with their own knowledge base, but the underlying platform is shared. There are a significant number of independent studios across the UK, most paying nothing for anything domain-specific.

**Value-based sales message:** "Never lose a booking to a slow DM reply again. Your AI assistant handles enquiries, design briefs, deposits, and aftercare — while you focus on tattooing."

**Starting point:** One agent handling enquiry-to-booking for one studio. No Stripe integration needed initially — just capture the brief and generate a booking request the artist confirms manually. Measure: time saved per booking, reduction in no-shows, client satisfaction with the enquiry experience.

---

## 4. Domain Expert + Platform = Product

### Paradigm shift

Previously, a domain expert who wanted to productise their knowledge had three options: write a book (one-directional, no personalization), create a course (scalable but generic), or offer 1-to-1 consulting (personalised but unscalable). Agentic AI creates a fourth option: an interactive, knowledge-grounded product that delivers personalised guidance at scale. The domain expert provides the knowledge, judgment frameworks, and credibility. The platform provides the technology. Neither could build the product alone.

### Subcategories

#### Practitioner-turned-founder

_experienced professional building a product from their expertise_

A senior HR consultant who's spent 20 years advising SMEs on employment law compliance could build a product that does what she does in her first client meeting — assesses what policies are missing, flags risks, and drafts compliant documents. She provides the frameworks and templates, the agent delivers them conversationally and contextually. She becomes the product's clinical advisor and public face, we build and run the platform. Revenue split.

##### Getting started

Attend a CIPD event or HR leadership meetup and find consultants who are already frustrated that they can't scale beyond their personal capacity — they self-identify when you ask the right question.

#### Academic and researcher commercialisation

_turning research findings into practical tools_

A university sleep research group has published extensively on insomnia interventions but their findings sit in journals nobody reads. An agent built on their research could deliver a structured 6-week insomnia programme — personalised based on the user's sleep patterns, work schedule, and specific difficulties. The researchers get commercialisation income and real-world validation data. Start with one programme, expand to other sleep disorders. Potential NHS commissioning path if efficacy data is strong.

##### Getting started

Approach a university's Knowledge Exchange or Technology Transfer office — they're specifically incentivised to find commercial partners for research and can introduce you to relevant research groups.

#### Retired professional knowledge capture

_preserving decades of expertise before it's lost_

A retiring master brewer with 35 years of craft brewing experience could capture their knowledge of recipe formulation, ingredient sourcing, fermentation troubleshooting, and quality control into an agent that apprentice brewers and small brewery owners can consult. "My porter is coming out too thin — I'm using Maris Otter, roasted barley, and chocolate malt at these ratios." The agent draws on the brewer's documented experience to diagnose and advise. One-off capture fee plus ongoing subscription from brewery subscribers.

##### Getting started

SIBA (Society of Independent Brewers) events and local brewery tap rooms — the craft brewing community is tight-knit and retiring head brewers are often looking for ways to pass on their knowledge.

#### Hobbyist-expert productisation

_deep enthusiast knowledge turned into a niche product_

A competitive birdwatcher with decades of field experience and extensive knowledge of UK bird identification, habitats, and seasonal patterns could build a birding advisor. "I'm visiting the Norfolk coast next week — what should I look for and where?" The agent provides location-specific, seasonally-aware guidance that goes far beyond a field guide. Monetise via subscription from the large and passionate UK birding community, with potential partnerships with nature reserves and optics retailers.

##### Getting started

Build a prototype loaded with BTO (British Trust for Ornithology) public data and test it on the BirdForum community — if it generates excitement there, finding an expert partner becomes easy.

#### Coach and consultant scaling

_extending reach beyond 1-to-1 sessions_

A leadership coach who charges premium rates for 1-to-1 sessions could extend their reach with an agent that delivers their coaching methodology at scale — daily reflection prompts, situational advice ("I'm about to have a difficult conversation with an underperformer"), and accountability check-ins. The agent isn't a replacement for the live sessions but a between-sessions companion that makes the coaching more effective. The coach's existing client base is the beta group. Revenue via B2B licensing to organisations that want to offer coaching at scale without the per-head cost of live sessions.

##### Getting started

LinkedIn is full of leadership coaches posting daily content — find one with a strong methodology (not just platitudes), who already talks about scaling their impact, and propose a co-creation partnership.

### Worked example: Retired physiotherapist building a rehabilitation guidance app

**The opportunity:** After knee replacement surgery, patients typically get a generic exercise sheet and a follow-up appointment in several weeks. Adherence to rehab exercises is widely reported to be poor — likely because patients don't understand why each exercise matters, can't tell if they're progressing normally, and have no one to ask when something hurts differently than expected. Private physiotherapy can cost around 50 pounds per session. Meanwhile, an experienced physiotherapist carries decades of pattern recognition ("this kind of pain at week 3 is normal, that kind isn't") that no exercise sheet captures. There's a gap between a generic handout and a full course of private physio — and that gap is exactly where a knowledgeable, conversational agent could sit.

**How Sunrise addresses it:** A retired senior physiotherapist partners with us. Their clinical knowledge and rehabilitation protocols go into the knowledge base — not just exercises, but the decision frameworks: when to push through discomfort vs. when to stop, what normal recovery milestones look like week by week, when to seek medical attention. The agent conducts a daily check-in: "How did yesterday's exercises go? Any new pain? Show me your range of motion." It adapts the programme based on responses, explains the reasoning ("we're increasing reps this week because you've hit the flexion milestone"), and escalates to a human physiotherapist via an approval gate workflow when something falls outside normal parameters.

**Venture studio path:** The physiotherapist is the co-founder and clinical advisor. They provide credibility, clinical validation, and initial content. Start with post-knee-replacement only (narrow, well-understood protocol, large patient volume). Revenue: B2C subscription (fraction of one private physio session per month) and B2B to private hospitals/clinics as a patient support tool that reduces readmission and complaint rates. Trojan horse: once validated for knees, the same platform pattern works for hip replacement, rotator cuff, ACL reconstruction — expand the knowledge base, not the code. The physiotherapist's network provides warm introductions to clinical partners.

**Value-based sales message:** "Guided rehabilitation from an expert physiotherapist's 30 years of knowledge — available 24/7 for less than the cost of one private session."

**Starting point:** One agent, one protocol (post-total-knee-replacement, weeks 1-12). Knowledge base loaded with the physiotherapist's rehabilitation framework. Test with 20 post-surgical patients recruited through the physiotherapist's professional network. Key metric: exercise adherence rate compared to standard of care.

---

## 5. Customer Experience as Genuine Problem-Solving

### Paradigm shift

Most "customer support AI" is designed to deflect — reduce ticket volume, contain costs, push people toward FAQs. The result is widely disliked. The paradigm shift is support AI that has genuine agency: it can look up your account, understand your specific situation, take action (issue a refund, adjust a bill, escalate with context), and follow up. The goal isn't fewer tickets — it's fewer problems. This requires capabilities (tool access), knowledge (company policies, product details), and workflows (approval gates for actions above certain thresholds).

### Subcategories

#### Billing and account resolution

_understanding charges, correcting errors, applying credits_

A broadband provider could deploy an agent that explains bills line by line and fixes errors. "I was charged for a premium call I didn't make" — the agent checks the CDR data, identifies the charge, and either explains it or credits it immediately (within defined thresholds). The interesting angle: most billing queries probably have a straightforward resolution that doesn't need a human, but current chatbots can't actually look at the account data or take action. An agent with read access to billing and write access to credits (within limits) could resolve in minutes what currently takes days.

##### Getting started

Approach a challenger broadband provider's CTO via warm intro or tech meetup — smaller ISPs are more agile and more willing to expose APIs for a pilot than the big players.

#### Technical troubleshooting

_diagnostic workflows that actually solve the problem_

A smart home device manufacturer could deploy an agent that actually diagnoses and resolves connectivity issues rather than saying "have you tried turning it off and on again." The agent knows the product's firmware versions, common failure modes, and can walk through diagnostic steps conversationally — "is the LED blinking fast or slow? What colour?" — arriving at either a resolution or a genuinely informed escalation to engineering. The knowledge base contains the engineering team's internal troubleshooting guides, not the customer-facing FAQ.

##### Getting started

Build a prototype using a popular IoT device's public documentation (e.g., Hive, Tado) and approach their support team with a demo showing resolution of the top 10 support queries.

#### Complaints with authority to act

_agents that can offer resolution, not just log a ticket_

An e-commerce company could deploy an agent that handles complaints with actual authority — within defined parameters, it can offer a replacement, refund, discount on next order, or free express shipping. A workflow approval gate escalates to a human only when the proposed resolution exceeds a cost threshold. The shift: instead of "I've logged your complaint, someone will get back to you in 5 working days", it's "I can see the issue, here's what I can offer right now." The speed and agency of the response could meaningfully change customer perception.

##### Getting started

Partner with a Shopify-based DTC brand we admire — founders of growing e-commerce businesses are often reachable on Twitter/X and acutely feel the support scaling problem.

#### Proactive outreach

_reaching out before a problem becomes a complaint_

A subscription box company could deploy an agent that reaches out to customers showing signs of churn — delivery issues, skipped boxes, support tickets. Instead of a generic "we miss you" email, the agent initiates a conversation: "I noticed your last box had a delivery delay and you skipped this month — is everything OK? Can I adjust your preferences?" The scheduled workflow identifies at-risk subscribers, the agent personalises the outreach, and a capability adjusts the subscription if requested.

##### Getting started

The subscription box market has active founder communities on Facebook and Substack — post a case study about conversational churn reduction and see who responds.

#### Post-purchase guidance and ongoing support

_helping customers get value from what they bought_

A commercial espresso machine supplier could deploy an agent that helps customers get the best out of their purchase. "My shots are pulling too fast and the crema is thin." The agent knows the specific machine model, its settings, and common calibration issues. This transforms the post-purchase relationship from "call us if it breaks" to an ongoing advisory partnership — and the data on common issues feeds back to product development and training. Revenue model: included in the machine price or maintenance contract, justified by reduced warranty claims.

##### Getting started

Approach a UK-based equipment supplier (e.g., a commercial coffee machine distributor) — their after-sales team already fields these calls and would welcome something that handles the routine calibration questions.

### Worked example: Utility company billing dispute resolution

**The opportunity:** Energy billing disputes are one of the highest-friction consumer experiences. Bills are complex (unit rates, standing charges, estimated vs. actual reads, tariff changes, government levies), customer service agents often have limited system access, and resolution frequently takes multiple contacts over weeks. Customers feel powerless; companies lose goodwill and pay Ombudsman fees for complaints that escalate. A significant proportion of billing complaints appear to stem from the company's own errors — which means there's a category of dispute where an agent with account access could identify and resolve the issue in a single interaction.

**How Sunrise addresses it:** An agent with capabilities that can query the billing system (read-only API), access to company tariff and policy documentation in the knowledge base, and a workflow engine that handles the resolution process. The agent starts with: "I can see your account — tell me what looks wrong." It pulls the actual billing data, walks through each charge with the customer conversationally, identifies the discrepancy (estimated read vs. actual, tariff applied incorrectly, missing discount), and proposes a resolution. A workflow with approval gates means: adjustments under a set threshold the agent applies immediately; larger adjustments go to a supervisor for approval with a full audit trail. The customer gets a single interaction, not a multi-week runaround.

**Venture studio path:** Partner with one mid-tier energy supplier or water company (they're more approachable than the big six and more desperate to differentiate on service). Offer a pilot on billing disputes only — their most expensive complaint category. Revenue model: per-resolution fee that's less than their current cost-per-complaint, or SaaS subscription. Trojan horse: once billing works, extend to meter reading disputes, tariff switching advice, and move-in/move-out processes. Measurement the client cares about: Ombudsman escalation rate, average contacts to resolution, CSAT.

**Value-based sales message:** "Resolve billing disputes in one conversation, not four. Your AI agent has account access, understands your tariffs, and can fix problems on the spot — within the limits you set."

**Starting point:** One agent, read-only billing API access, knowledge base with tariff documentation and complaint resolution policies. No write access to billing systems initially — the agent generates a recommended adjustment that a human applies. Test with 200 billing disputes over 12 weeks. Measure: first-contact resolution rate, customer satisfaction, time to resolution.

---

## 6. Small Team / Solo Operator Multiplier

### Paradigm shift

A solo consultant, freelancer, or micro-business owner currently operates with the capacity of one person. They can't have someone screening enquiries while they're doing client work, can't have a researcher pulling market data while they're writing proposals, can't have an admin following up invoices while they're on site. Agentic AI doesn't replace the human — it gives them the operational capacity of a small team. The shift is from "I can't afford an assistant" to "I have an always-available junior colleague who knows my business."

### Subcategories

#### Client communication and follow-up

_responding to enquiries, scheduling, post-meeting summaries_

A freelance management consultant could deploy an agent on their website that handles initial enquiries while they're in client meetings. "We're a 30-person fintech looking for help with our go-to-market strategy." The agent captures the brief, asks qualifying questions, and schedules a discovery call — sending the consultant a structured summary before the call. Between meetings, it drafts follow-up emails from the consultant's notes. The consultant appears responsive and organised without being chained to their inbox.

##### Getting started

We probably know freelance consultants personally — offer to build one a free prototype in exchange for detailed feedback, then use their testimonial to reach others.

#### Proposal and document generation

_tailored proposals, reports, case studies from templates plus context_

An independent architect could use an agent to draft project proposals from their library of past work and standard terms. "New enquiry: Victorian terrace rear extension, conservation area, budget around 80k." The agent pulls relevant case studies, adapts the scope template, includes conservation-specific considerations from the knowledge base, and generates a first-draft proposal the architect reviews and personalises. What currently takes an evening could take 20 minutes of review.

##### Getting started

Approach a local RIBA-registered practice with 2-5 architects — small enough to be agile, big enough to feel the proposal bottleneck.

#### Scheduling and coordination

_multi-party availability, project timeline management_

A wedding planner operating solo could use an agent to coordinate between venue, caterer, photographer, florist, and clients. "The venue is only available on the 14th or 21st of September — check with the photographer and caterer." The agent tracks availability across suppliers (via email capabilities or structured updates), identifies conflicts, and proposes solutions. The coordination overhead of multi-vendor events is exactly the kind of tedious, high-stakes work an agent can handle well.

##### Getting started

Wedding planner Facebook groups and the UK Alliance of Wedding Planners — planners are active in sharing tools and recommendations with each other.

#### Research and competitive intelligence

_market analysis, tender preparation, due diligence_

A small PR agency could use an agent to prepare client briefings and competitive analyses. "I need a media landscape briefing for a new fintech client launching a pension product — who are the key journalists, what have competitors been saying, what angles might work?" The agent searches the knowledge base (loaded with media contact databases, recent coverage, and sector analysis) and produces a structured briefing. Currently this is junior account executive work — an agent could produce a first draft faster and more consistently.

##### Getting started

Build a prototype using publicly available media data for one sector, and demo it to the founder of a boutique PR agency at a PRCA networking event.

#### Bookkeeping and admin triage

_receipt categorisation, invoice chasing, expense management_

A freelance photographer could use an agent to handle the admin they hate — categorising receipts ("was this a business meal or personal?"), chasing overdue invoices ("your invoice to Client X is 14 days overdue — shall I send a reminder?"), and flagging upcoming deadlines ("your self-assessment is due in 6 weeks — here's what you need to gather"). The agent doesn't replace an accountant but handles the daily admin that freelancers typically neglect until tax season.

##### Getting started

This one we could dogfood ourselves — build it for our own freelance admin first, then offer it to other freelancers in our coworking space or network.

#### Sales and lead qualification

_initial screening, needs assessment, pipeline management_

An independent IT consultancy could deploy an agent that qualifies inbound leads: "Tell me about your IT setup — how many staff, what systems, any current pain points?" The agent captures the information, scores the lead against the consultancy's ideal client profile, and either schedules a call (qualified) or politely suggests a more appropriate provider (not a fit). The consultant spends their time on genuine prospects rather than discovery calls that go nowhere.

##### Getting started

IT consultancies often attend local business networking groups (BNI, Chamber of Commerce) — pitch it as a tool that makes their networking follow-up actually work.

### Worked example: Independent mortgage broker with AI-assisted case preparation

**The opportunity:** An independent mortgage broker spends a substantial portion of their time on case preparation — gathering client documents, checking eligibility against multiple lenders' criteria, calculating affordability, and writing the suitability report that regulators require. This is skilled work (you need to know the criteria) but also tedious and repetitive. For many brokers, the bottleneck isn't finding clients — it's processing them. There's an interesting question about whether an agent that knows lender criteria could meaningfully increase a broker's throughput.

**How Sunrise addresses it:** An agent with lender criteria loaded into the knowledge base (publicly available criteria from lender websites, updated regularly). The agent conducts the initial fact-find conversationally with the client (income, employment, deposit, property type, credit history), then matches against lender criteria, flags issues ("this lender won't accept your income type — here are the ones that will"), and drafts the suitability report framework. The broker reviews and finalises. A scheduled workflow checks for criteria changes from key lenders weekly and alerts the broker.

**Venture studio path:** Partner with 3-5 independent brokers from a mortgage network. Charge a flat monthly fee that the broker could recoup by handling a few extra cases per month. Trojan horse: once brokers trust the case prep, extend to client-facing features (embed widget on the broker's site for initial enquiries) and compliance documentation. Scale through mortgage networks (which have hundreds of member brokers and are always looking for tools that improve productivity and compliance). Longer term: the lender criteria knowledge base itself becomes a valuable data asset.

**Value-based sales message:** "What if your case prep took half the time? An AI assistant that knows lender criteria, drafts your suitability reports, and catches eligibility issues before you waste time on dead-end applications."

**Starting point:** One agent, knowledge base loaded with criteria from the most common high-street and specialist lenders. No integrations — the agent produces a document the broker copies into their existing CRM. Test with 5 brokers over 3 months. Key metric: cases processed per month before and after.

---

## 7. Community and Civic Infrastructure

### Paradigm shift

Community infrastructure — the coordination that makes local life work — has always depended on either well-funded institutions (councils, charities) or unpaid volunteer labour. Digital tools for communities are either designed for businesses (Slack, WhatsApp groups that become unmanageable) or for big organisations (CRM systems no volunteer can operate). Agentic AI changes this by providing a capable coordinator that doesn't need training, doesn't burn out, and can operate 24/7. It can hold the institutional knowledge that currently lives in one committee member's head.

### Subcategories

#### Mutual aid and resource sharing

_matching needs to offers, tracking commitments, following up_

A community fridge network (surplus food redistribution) could use an agent to coordinate donations and collections. Shops and restaurants notify the agent when they have surplus ("we've got 20 sandwiches end of day"), the agent matches to nearby fridges with capacity, coordinates volunteer collection, and tracks food safety compliance (use-by times, temperature). The coordination burden is currently what limits these networks from scaling — each fridge typically depends on one heroic volunteer.

##### Getting started

Contact Hubbub or the Community Fridge Network directly — they coordinate the UK-wide network and would be a natural pilot partner if the coordination tool works.

#### Local democracy and consultation

_making council consultations accessible, summarising planning applications_

A neighbourhood forum could deploy an agent that makes council planning consultations accessible. "There are 12 new planning applications in our area this month — which ones might affect me?" The agent summarises each application in plain language, identifies the ones relevant to the user's location, explains what the implications might be, and helps draft a consultation response if they want to comment. Currently, most residents don't engage because the documents are impenetrable.

##### Getting started

Scrape one council's planning portal, build a prototype that summarises applications for a specific ward, and offer it to the local neighbourhood forum or civic society — they'll likely promote it themselves.

#### Neighbourhood coordination

_event planning, shared resource management, community noticeboard_

A residents' association could use an agent as a community coordinator — "I'd like to borrow a pressure washer this weekend, does anyone on the street have one?" or "we're thinking about organising a street party for the bank holiday — who's interested?" The agent maintains an inventory of shared resources, coordinates events, and acts as the community's institutional memory ("we did a litter pick in March, here's what we found and which issues we reported to the council").

##### Getting started

Deploy on our own street or building first — the best community tools are built by people who live in the community and use them personally.

#### Volunteer management

_matching volunteers to tasks, scheduling, recognition_

A local Parkrun organising team could use an agent to manage volunteer rosters. "I can marshal this Saturday but not next week." The agent tracks availability across the volunteer pool, identifies gaps, sends reminders, and ensures no single volunteer is over-relied on. The same pattern works for any regular volunteer-dependent activity — food banks, charity shops, community gardens. Start with one organisation, template the solution.

##### Getting started

Volunteer at a local Parkrun and talk to the event director about their roster headaches — if it works for one Parkrun, the 900+ UK events are reachable through the national network.

#### Community knowledge bases

_local history, neighbourhood guides, "who to contact for what"_

A parish council could build a community knowledge base agent — "who do I contact about the broken streetlight on Mill Lane?" or "when was the old mill converted into flats?" The agent draws on local knowledge contributed by residents, council information, and historical records. This preserves institutional knowledge that currently lives in the heads of long-standing residents and parish councillors. Interesting as a digital heritage project with potential grant funding.

##### Getting started

Apply for a Heritage Lottery Fund grant — digital heritage preservation is within their remit, and a parish council partnership gives the application local credibility.

#### Civic monitoring and accountability

_tracking council commitments, FOI request assistance, spending analysis_

A local campaign group could deploy an agent that tracks council commitments and holds them to account. "The council promised to repair the playground by September — have they started?" The agent maintains a register of public commitments (from council minutes, press releases, consultation responses), tracks progress, and helps draft FOI requests when information isn't forthcoming. This shifts the burden of accountability from volunteer campaigners to a system that doesn't forget or get tired.

##### Getting started

Partner with a local civic tech group or mySociety (who run WhatDoTheyKnow and TheyWorkForYou) — they have the community, we have the tech.

### Worked example: Neighbourhood mutual aid coordination

**The opportunity:** During COVID, thousands of mutual aid groups formed on WhatsApp. Many collapsed within months because coordination was unsustainable: one person tracking who needs shopping, who can help, matching availability, following up. The need didn't go away — elderly and isolated people still need support — but the volunteer infrastructure couldn't sustain itself. It's worth exploring whether agentic AI could be the missing coordination layer — the thing that makes volunteer networks sustainable by handling the tedious matching, confirming, and following up that burns out human coordinators.

**How Sunrise addresses it:** An agent acts as the mutual aid coordinator. Residents can message it (via embed widget on a community website, or via a linked WhatsApp number through a capability): "I need someone to collect a prescription from Boots on the high street" or "I can help with shopping on Tuesday afternoons." The agent matches needs to offers, confirms with both parties, and follows up. The knowledge base contains local information (pharmacy locations, bus timetables, council services for escalation). A scheduled workflow sends a weekly digest to the coordinator (a human volunteer) with a summary of activity and any unmatched needs.

**Venture studio path:** This isn't a direct revenue play initially — it's a reputation and learning opportunity. Partner with a housing association or community foundation who fund it as a social impact project (grants, CSR budgets). Trojan horse: the same coordination pattern (match need to capacity, confirm, follow up) is the core of home care scheduling, volunteer-driven charity logistics, and community health — all of which have paying customers. The community deployment is the proof-of-concept. Revenue comes when a housing association or local authority wants the same tool across 50 estates.

**Value-based sales message:** "Keep your mutual aid group running without burning out your coordinator. The AI handles matching, scheduling, and follow-up — your volunteers just show up and help."

**Starting point:** One agent on one estate or street, partnered with an existing community group. No budget needed from residents — fund via a small community grant or housing association. Measure: requests fulfilled per week, volunteer retention, coordinator time saved. Validate the coordination pattern before scaling.

---

## 8. Accessible Services for the Underserved

### Paradigm shift

Professional services — legal advice, financial guidance, healthcare navigation — are priced for the middle class and above. For everyone else, the options are: generic websites, overstretched free services with weeks-long waiting lists, or going without. The result is that the people who most need expert guidance (tenants facing eviction, people navigating the benefits system, patients with complex conditions) are least likely to get it. Agentic AI can't replace a solicitor, but it can do what a solicitor's junior paralegal does: understand the situation, identify the relevant law or regulation, prepare the paperwork, and flag when professional intervention is genuinely needed.

### Subcategories

#### Legal aid and rights navigation

_employment rights, consumer disputes, small claims guidance_

An agent that helps people navigate the small claims process — "my builder did a terrible job and won't come back to fix it, I paid 3,000 pounds." The agent walks through whether small claims is appropriate, helps gather evidence, drafts the claim form, and explains what to expect at a hearing. Partner with a consumer rights charity for credibility. Revenue via a nominal per-claim fee or grant funding, with a commercial path through partnerships with legal expense insurers.

##### Getting started

Build a prototype using the publicly available MoneyClaims online guidance and test it with people from consumer rights forums who are actively going through the process — they'll give brutally honest feedback.

#### Benefits and entitlements

_eligibility checking, application assistance, appeal support_

An agent that helps people identify benefits they're entitled to and assists with applications. "I've just been diagnosed with MS and I'm struggling to work full-time." The agent understands the relationship between PIP, ESA, Universal Credit, and Access to Work — a landscape that confuses even advisors. It walks through eligibility conversationally, helps prepare application narratives that focus on the right descriptors, and assists with mandatory reconsideration if claims are rejected. Partner with a disability charity for content validation and referrals.

##### Getting started

Approach the MS Society, Scope, or a local disability rights organisation — they're overwhelmed with advice requests and may welcome a tool that handles the initial guidance.

#### Housing and tenancy

_tenant rights, disrepair claims, eviction defence, deposit disputes_

Beyond the worked example above (tenant rights), there's an opportunity around disrepair claims specifically. "My landlord won't fix the damp — I've been asking for months." The agent documents the timeline, identifies the landlord's obligations under the Homes (Fitness for Human Habitation) Act, helps the tenant draft a formal complaint using the pre-action protocol, and escalates to environmental health or a housing disrepair solicitor when appropriate. Partner with a law firm that does no-win-no-fee disrepair claims.

##### Getting started

Housing disrepair solicitors already spend heavily on Google Ads — approach one with a proposal where the agent pre-qualifies leads, saving them ad spend on cases that don't meet their criteria.

#### Healthcare navigation

_understanding diagnoses, preparing for consultations, navigating referrals_

An agent that helps patients prepare for consultant appointments — "I've been referred to a rheumatologist and I don't know what to expect or what to ask." The agent explains the likely process, helps the patient prepare a symptom timeline, suggests questions to ask, and afterwards helps make sense of the outcome ("they mentioned methotrexate — here's what that is, how it works, and what side effects to watch for"). Grounded in patient information from NHS sources, not clinical data. Partner with a patient advocacy organisation.

##### Getting started

Approach Healthwatch (the independent consumer champion for health and care) — they exist in every local authority area and are specifically tasked with improving patient experience.

#### Education access

_SEND provision, school admissions, university applications for first-generation students_

An agent that helps first-generation university applicants navigate the process — "I want to study engineering but no one in my family has been to uni and I don't know where to start." The agent covers UCAS timelines, personal statement guidance, student finance, bursary identification, and the cultural aspects of university that applicants from non-university backgrounds often find bewildering. Partner with a widening participation charity or a university's outreach department. Grant-funded initially, potentially adopted by schools or multi-academy trusts.

##### Getting started

Contact a university's widening participation team — they have budgets for outreach tools and would value something that extends their reach beyond the schools they can physically visit.

#### Immigration and asylum support

_form completion, document gathering, status tracking_

An agent that helps people navigate immigration applications — one of the most complex, high-stakes bureaucratic processes most people ever encounter. "I'm on a Skilled Worker visa and I want to apply for ILR — what do I need?" The agent walks through eligibility, document requirements, the Life in the UK test, and application timing. It doesn't replace an immigration solicitor for complex cases but handles the straightforward information-gathering and preparation that currently costs hundreds of pounds in legal fees. Partner with an immigration advice charity (OISC-regulated) for content review.

##### Getting started

Reach out to a local Citizens Advice branch that offers immigration advice — they see the demand firsthand and can validate whether an agent would genuinely help or create risks.

#### Debt and financial distress

_debt prioritisation, creditor communication, breathing space applications_

An agent that helps people in debt understand their options and take the first steps. "I've got three credit cards, a catalogue debt, and I'm behind on council tax — I don't know what to pay first." The agent explains priority vs. non-priority debts (council tax and rent before credit cards), helps draft creditor letters, and guides through the Breathing Space application process. Partner with a debt advice charity (StepChange, National Debtline) for content and referral pathways. This is a space where people often avoid seeking help due to shame — a non-judgmental agent may lower that barrier.

##### Getting started

StepChange has a well-documented public API and methodology — build a prototype using their published guidance and approach their innovation team with a working demo rather than a pitch deck.

### Worked example: Tenant rights advisor for private renters

**The opportunity:** Private renters in England have extensive legal protections (Renters' Reform Act, deposit protection, disrepair obligations, retaliatory eviction defence) but most don't know they exist, can't afford a solicitor, and may struggle to get timely advice from overstretched services like Shelter or Citizens Advice. There's a significant knowledge asymmetry between landlords (who often have letting agents and solicitors) and tenants (who have Google). The information exists — it's the personalised application to someone's specific situation that's missing. An agent that understands housing law well enough to say "your landlord hasn't protected your deposit — here's what that means and what you can do" could be genuinely transformative for people in vulnerable situations.

**How Sunrise addresses it:** An agent with housing law guidance, Shelter resources, and template letters loaded into the knowledge base. The agent asks about the tenant's situation conversationally: "What's happening with your tenancy? Tell me about the issue." Based on responses, it identifies the relevant law ("your landlord hasn't protected your deposit — this means they can't serve a valid Section 21 notice"), generates a template letter, explains the next steps, and escalates to a referral (Shelter, local law centre, duty solicitor) when the situation is beyond guidance-level support. An output guard ensures it never presents guidance as legal advice.

**Venture studio path:** Partner with a housing charity or law centre for credibility and content review. Initial deployment: free, funded by a grant (plenty available for access-to-justice projects from legal foundations). Trojan horse: the same pattern (rights identification, template generation, escalation) works for employment disputes, consumer complaints, and benefits appeals — and those have commercial models. A letting agent or tenant insurance company might pay for a white-labelled version that reduces their complaint handling costs. Also: the data on common issues is valuable for policy advocacy organisations.

**Value-based sales message:** "Know your rights as a renter — in plain English, specific to your situation. Not generic FAQ answers, but guidance that understands your tenancy and tells you exactly what to do next."

**Starting point:** One agent, knowledge base loaded with Shelter's publicly available guidance and key legislation summaries. Embed on a partner charity's website. Test with 100 users over 8 weeks. Measure: issue identification accuracy (reviewed by a housing lawyer), user confidence before/after, referral appropriateness.

---

## 9. Research, Investigation and Sensemaking

### Paradigm shift

Research and investigation have always required two things: access to information and the skill to synthesise it. The internet solved access; agentic AI solves synthesis. A journalist investigating council spending, a community group analysing air quality data, a small business doing competitor research — all of these were previously limited by the time and expertise needed to process large amounts of information and extract meaning. The shift is from "access to data" to "access to analysis."

### Subcategories

#### Journalism and accountability

_public spending analysis, FOI request analysis, pattern detection_

See worked example below. Beyond council spending, the same pattern applies to NHS trust board papers, police force spending, academy trust accounts, and any public body that publishes data that nobody has time to analyse. Each dataset is a potential partnership with a journalist or campaign group.

##### Getting started

Download one council's transparency data (it's published quarterly), load it into a prototype, and tweet a few interesting findings — journalists will come to you.

#### Policy analysis

_impact assessment, consultation response drafting, legislative tracking_

A small policy think tank could deploy an agent that tracks legislation through Parliament — "what's the current status of the Renters Reform Bill and what amendments have been proposed?" The agent monitors Hansard and parliamentary publications, summarises relevant debates, and helps draft consultation responses. Interesting for organisations that need to track policy across multiple areas but don't have the staff to read every Hansard transcript. Revenue via subscription to think tanks, charities, and trade bodies.

##### Getting started

Approach a mid-size charity that does policy work (housing, health, education) — their policy officer is probably one person trying to track too many things at once.

#### Market and competitor research

_landscape mapping, trend analysis, opportunity identification_

A boutique strategy consultancy could use an agent to accelerate market research for client engagements. "Map the UK insurtech landscape — who are the key players, what's their positioning, who's funded, what gaps exist?" The agent synthesises information from the knowledge base (loaded with industry reports, Companies House data, Crunchbase profiles) and produces a structured landscape analysis. Currently this is junior analyst work that takes days — an agent could produce a solid first draft in hours. Revenue by licensing the tool to other small consultancies.

##### Getting started

Build a prototype for our own market research needs (e.g., mapping the agentic AI landscape itself), then use it as a live demo when approaching strategy firms.

#### Academic literature review

_systematic reviews, cross-paper synthesis, methodology comparison_

A research consultancy that does systematic reviews for healthcare organisations could use an agent to accelerate the screening and synthesis phases. Load a corpus of papers into the knowledge base, then ask: "which of these papers report randomised controlled trials of CBT for adolescent anxiety?" or "what are the common methodological limitations across this set?" This doesn't replace the researcher's judgment but dramatically speeds up the initial sifting and cross-referencing. Revenue via the consultancy's existing client base.

##### Getting started

Approach a health research consultancy via LinkedIn — the ones that do NICE evidence reviews are time-constrained and would trial anything that speeds up screening.

#### Due diligence

_company research, background checks, risk assessment_

A small venture capital firm could deploy an agent that assists with investment due diligence. "Pull together everything available on this company — Companies House filings, key personnel, funding history, any adverse media." The agent aggregates public data, flags inconsistencies, and produces a structured due diligence pack. Currently this is outsourced to expensive due diligence firms or done manually by associates. An agent could handle the data aggregation, letting the human focus on judgment calls.

##### Getting started

Build a prototype using Companies House API and public data sources, run it on a few real companies, and demo it at an angel investor network meeting.

#### Community and grassroots research

_neighbourhood surveys, impact measurement, evidence gathering for campaigns_

A community group fighting a proposed development could deploy an agent to gather and organise evidence — conducting structured interviews with affected residents ("how would the proposed road affect your daily routine?"), synthesising responses into thematic findings, and drafting formal objections that reference planning policy. This levels the playing field between communities (who rely on volunteers) and developers (who have professional planning consultants). Grant-funded initially, potentially offered as a service to community advocacy organisations.

##### Getting started

Find a live planning dispute in the local area and offer the tool to the campaign group for free — the results become a case study.

### Worked example: Local journalist investigating council spending data

**The opportunity:** Local journalism in the UK has contracted significantly — many areas no longer have dedicated investigative reporters. The journalists and hyperlocal bloggers who remain rarely have time for deep investigation. Meanwhile, council spending data is theoretically public (transparency returns, FOI) but practically inaccessible: thousands of line items in CSV files, inconsistent naming, spread across multiple financial years. A single council's annual spending can run to tens of thousands of transactions. Patterns (unusually large contracts, repeated payments to connected parties, spending spikes) are invisible without systematic analysis. This feels like a natural fit for agentic AI — turning a data swamp into something a non-specialist can actually interrogate.

**How Sunrise addresses it:** An agent with council spending data loaded into the knowledge base (CSV imports via document ingestion). The journalist asks questions conversationally: "Show me all payments over 50k to companies registered in the last two years" or "Compare parks maintenance spending this year vs. last three years" or "Flag any suppliers who received payments from multiple departments." The agent uses capabilities to query and cross-reference the data, presents findings with source references, and helps the journalist draft FOI requests for follow-up. A workflow can automate ongoing monitoring: ingest new quarterly spending data, compare against baselines, flag anomalies.

**Venture studio path:** This is a social-impact-first play with multiple revenue paths. Start free for local journalists (there aren't many — the reputation value is high). Trojan horse: the same analytical capability sells to councils themselves (internal audit), to opposition councillors (scrutiny), to campaign groups (evidence), and to procurement consultants (contract analysis). Also: a funded project from a journalism foundation or democracy charity (Nesta, Joseph Rowntree, Google News Initiative have all funded local accountability tools). Revenue emerges from the B2B applications that the journalism use case validates.

**Value-based sales message:** "Turn 50,000 lines of council spending data into stories. Ask questions in plain English, get answers with source references — investigation at the speed of curiosity."

**Starting point:** One agent, one council's last three years of spending data (publicly available). Partner with one local journalist or hyperlocal blog. Measure: stories published from AI-assisted investigation, time saved per investigation, FOI requests generated. The output is publicly visible — each story is marketing.

---

## 10. Operations and Workflow Automation for Small Organisations

### Paradigm shift

Enterprise operations tools (Salesforce, SAP, ServiceNow) are designed for organisations with dedicated ops teams. Small organisations (5-50 people) get by with spreadsheets, email folders, and institutional knowledge in people's heads. When someone leaves, the knowledge goes with them. The shift isn't "small company gets enterprise software" — it's that the agent becomes the institutional memory and process coordinator that small organisations could never afford to build. It knows the processes, remembers the exceptions, and doesn't leave.

### Subcategories

#### HR and recruitment

_candidate screening, interview scheduling, onboarding checklists_

A 20-person professional services firm could deploy an agent that handles new employee onboarding — "welcome to the team, let's get you set up." The agent walks through IT setup, policy acknowledgements, introductions to key people, and first-week tasks conversationally rather than via a 30-page onboarding pack. It answers questions the new joiner is too embarrassed to ask a colleague ("what's the dress code for client meetings?" "how do I book a meeting room?"). The knowledge base holds the company handbook, IT guides, and org chart.

##### Getting started

Build it for our own team first — we'll learn what works and what doesn't, and have a genuine case study for approaching other small firms.

#### Compliance and reporting

_regulatory submissions, audit preparation, policy tracking_

A small care home (20-30 beds) could use an agent to help prepare for CQC inspections. The agent knows the inspection framework, tracks which policies are due for review, and helps staff document incidents and actions in the format CQC expects. "We had a medication error yesterday — walk me through what I need to record." The agent ensures the right forms are completed and the right people notified. Revenue via subscription to care home operators, scaling through care home groups and sector associations.

##### Getting started

Approach a small independent care home owner (not a chain) — they're often managing compliance single-handedly and are reachable through local care sector forums or the National Care Association.

#### Inventory and procurement

_stock monitoring, reorder workflows, supplier management_

A small brewery taproom could use an agent to manage stock and reordering. "We're running low on Citra hops and we've got a pale ale brew scheduled for Thursday." The agent knows current stock levels (updated via simple check-ins), lead times from suppliers, and the brew schedule, and triggers reorder suggestions. It also tracks supplier performance ("last order from Supplier X was two days late — flag next time?"). The pattern works for any small business with perishable or time-sensitive inventory.

##### Getting started

Visit a local craft brewery taproom and buy the head brewer a pint — brewery owners tend to be approachable and curious about tech, especially if it saves them from spreadsheet hell.

#### Internal knowledge management

_process documentation, FAQ, tribal knowledge capture_

A small law firm could deploy an agent as their institutional memory. "How do we handle a conflict of interest check?" or "what's our process for onboarding a new client in the corporate team?" Instead of process documents that nobody reads or updates, the agent holds the current knowledge and learns from corrections. When a team member leaves, their process knowledge has already been captured through the agent's interactions. Revenue via subscription to professional services firms.

##### Getting started

Approach a small law firm's office manager or practice manager — they're the ones who actually maintain the process documents and know how painful it is when someone leaves.

#### Client and case management

_tracking engagements, progress notes, handover summaries_

A small charity providing mentoring services could use an agent to help mentors track their cases. "I had a session with James today — he's making progress on his CV but is anxious about interviews." The agent captures the update, flags if it's been too long since the last session, and generates handover summaries if a mentor is away. This replaces the spreadsheet-and-email approach that most small charities use for case management, without requiring them to learn a complex CRM system.

##### Getting started

Volunteer with a local mentoring charity (Prince's Trust, a youth mentoring programme) — you'll see the case management problem firsthand and build relationships with the people who'd use the tool.

#### Quality assurance and auditing

_inspection checklists, non-conformance tracking, corrective actions_

A small food manufacturer could use an agent to manage their HACCP compliance. "Daily check: cold store temperature was 5.2 degrees at 8am — is that within spec?" The agent knows the control points, acceptable ranges, and corrective actions. When something is out of spec, it walks the operator through the response and generates the documentation. Currently this is done with paper checklists and periodic audits — an always-available agent could make compliance continuous rather than periodic.

##### Getting started

Approach a local food manufacturing consultant who advises small producers on HACCP — they have dozens of clients who all share the same compliance headache.

### Worked example: Small recruitment agency candidate-role matching

**The opportunity:** A small recruitment agency (3-5 consultants) typically handles dozens of active roles and hundreds of candidate profiles. Matching is often done from memory and basic keyword search in their ATS. Consultants likely miss matches because they can't hold the full picture in their heads — a candidate registered six months ago for a different role might be perfect for today's brief, but no one remembers. ATS search is only as good as the data entry, which tends to be inconsistent. There's an interesting question about whether semantic matching (understanding what a CV implies, not just what it says) could surface placements that keyword search misses.

**How Sunrise addresses it:** An agent with all candidate CVs and role specifications loaded into the knowledge base. When a new role comes in, the agent matches against the full candidate pool — not just keywords but contextual understanding ("this role needs someone who's managed a P&L, and this candidate's CV shows they ran a business unit at their last company even though they didn't use that exact phrase"). The agent can also handle initial candidate screening conversationally: "Tell me about your experience with stakeholder management" — capturing structured notes for the consultant. A workflow runs when a new candidate registers: match against all open roles, alert relevant consultants.

**Venture studio path:** Partner with 2-3 small agencies. Charge a monthly SaaS fee positioned against the revenue from placements they're currently missing (one extra placement per quarter pays for a year of the tool). Trojan horse: once matching works, extend to candidate engagement (keeping warm candidates active), client reporting (pipeline updates), and compliance documentation (IR35 checks, right-to-work verification). Scale through recruitment industry networks and associations.

**Value-based sales message:** "Stop losing placements to your own database. Your AI knows every candidate you've ever registered and matches them to new roles before your competitors find them on LinkedIn."

**Starting point:** One agent, loaded with one agency's candidate database (CSV export from their ATS) and current open roles. No ATS integration initially — the agent runs alongside the existing system. Test with 20 open roles. Measure: matches surfaced that consultants wouldn't have found, time saved on candidate screening.

---

## 11. Platform and Marketplace Plays

### Paradigm shift

Traditional marketplaces connect supply and demand through search and listings. Agentic marketplaces connect them through conversation and orchestration — the AI understands what you need, matches it to what's available, handles the negotiation or configuration, and coordinates the delivery. The difference: instead of browsing 200 listings, you describe your situation and the agent does the work. This also enables entirely new marketplace dynamics: agents representing buyers negotiating with agents representing sellers, micro-transactions via crypto rails, and token-gated access to premium agent capabilities.

### Subcategories

#### Expert marketplaces

_matching knowledge seekers to providers with AI-assisted triage_

A platform connecting homeowners to vetted tradespeople — but instead of browsing listings, you describe your problem conversationally: "I've got a crack running down my internal wall, about a metre long, appeared in the last few months." The agent triages (is this structural or cosmetic?), determines the right trade (structural engineer first, then builder), and matches to a qualified local provider. The AI triage adds value that a simple directory can't — and could reduce wasted callouts for both homeowners and trades.

##### Getting started

Partner with a local trades directory or a Checkatrade-style platform that already has the supply side — we add the intelligent triage layer they lack.

#### Service coordination

_multi-party workflows where the agent orchestrates between providers_

A property management company could deploy an agent that coordinates maintenance between tenants, landlords, and contractors. Tenant reports an issue → agent triages → schedules a contractor → confirms access with tenant → follows up on completion → updates landlord. Currently this is someone on the phone all day. The agent handles the coordination across multiple parties, each with their own availability and communication preferences. Start with one property manager, scale through letting agency networks.

##### Getting started

Approach a local letting agency that manages 100+ properties — they'll have a property manager who spends most of their time on exactly this coordination.

#### Aggregation and comparison

_agent-driven comparison that understands context, not just price_

A business energy comparison service where the agent actually understands your usage patterns: "We're a bakery, we use a lot of power overnight for proving ovens, we have solar panels on the roof." Instead of a comparison table sorted by unit rate, the agent models actual cost based on your specific usage profile and tariff structures. This is the kind of contextual comparison that existing comparison sites can't do because they reduce everything to simple inputs. Revenue via referral from energy suppliers.

##### Getting started

Build a prototype for one sector (hospitality — high energy costs, complex usage patterns) and approach a business energy broker who'd use it as a differentiation tool.

#### Peer-to-peer knowledge exchange

_community expertise sharing with AI-assisted quality control_

A professional community of practice (say, UK data protection officers) could deploy an agent that curates and quality-checks member contributions. Members share their approaches to common challenges ("how are you handling the new GDPR adequacy framework post-Brexit?"), the agent synthesises responses, identifies consensus and disagreement, and makes the collective knowledge searchable. It also flags outdated or potentially incorrect advice. This is a more structured version of what happens in Slack channels and forums, with the agent adding editorial intelligence.

##### Getting started

Find an active professional Slack or Discord community and offer to build a knowledge synthesis layer on top of their existing discussions — they already have the content, we add the intelligence.

#### Agent-as-a-service (white-label)

_providing pre-built agentic capabilities to other businesses_

See worked example below. Beyond trade associations, the white-label model works for franchise networks (each franchisee gets an agent with brand-level knowledge plus local customisation), professional networks (each member firm gets a client-facing agent), and software vendors (embed an agent in their product for customer support and onboarding).

##### Getting started

Identify a franchise network we have a personal connection to and propose a pilot — one franchisee first, then roll out across the network.

#### Token-gated agent access

_pay-per-query via Lightning or crypto micropayments_

A specialist research agent — say, one with deep knowledge of UK planning law precedents — could be accessed on a pay-per-query basis via Lightning Network micropayments. No subscription, no account creation — pay a few hundred sats per query. This enables a long tail of specialist knowledge agents that aren't viable as subscriptions (too niche) but could sustain themselves through micropayments. The Lightning integration via a capability makes this technically straightforward. Interesting as an experiment in new economic models for knowledge access.

##### Getting started

Build one ourselves as a proof of concept — pick a niche knowledge domain, load it up, integrate LNbits for payments, and publish it to the Bitcoin/Nostr community as an experiment.

#### Decentralised agent marketplaces

_agents published and consumed without a platform middleman_

Longer term, there's an intriguing possibility of a marketplace where domain experts publish agents (with their knowledge bases) and consumers access them directly — without a centralised platform taking a percentage. Agents could be self-hosted, discovered via a registry, and paid for via Lightning. This is more speculative, but Sunrise's multi-provider architecture and embeddable widget make it technically feasible. Worth exploring as the agent ecosystem matures and the desire for platform independence grows.

##### Getting started

This one is a longer-term vision — start by publishing a few of our own agents with Lightning payment, learn what works, and write up the architecture as a public spec to attract interest.

### Worked example: Agent-as-a-service for trade associations

**The opportunity:** Trade associations (Federation of Small Businesses, National Farmers Union, and hundreds of niche associations) provide member benefits including advice helplines. These are expensive to staff, limited to business hours, and variable in quality. Members pay annual fees and may rarely use the helpline, which can make it hard to justify. Meanwhile, the association typically has deep domain knowledge in their publications, guidance notes, and policy documents — but it's locked in PDFs that members don't read. There's a compelling opportunity to turn that static knowledge library into a conversational advisor — and in doing so, make the membership itself more valuable.

**How Sunrise addresses it:** White-label agent deployments for trade associations. The association's existing guidance library goes into the knowledge base. Members get 24/7 access to an agent that answers domain-specific questions ("do I need to register for VAT if I sell at farmers' markets?", "what are the new tractor emissions regulations?"). The embed widget sits on the members-only section of the association's website. The admin UI lets association staff manage the knowledge base and see analytics (what are members asking about most?). Multi-provider LLM support keeps costs predictable; budget controls cap per-member spend.

**Venture studio path:** Approach one association with a pilot: "we'll deploy an AI advisor for your members in 4 weeks, you give us your guidance documents and access to 100 members for testing." Revenue: per-member-per-month fee to the association (they pass it on as part of membership, or it justifies a fee increase). Trojan horse: once one association validates the model, pitch to others — the deployment pattern is identical, only the knowledge base changes. The UK has a large number of trade and professional associations. Longer term: the platform itself becomes a marketplace where associations can subscribe to pre-built agent templates.

**Value-based sales message:** "Turn your guidance library into a 24/7 expert advisor for your members. They get instant, personalised answers. You get data on what they actually need. The PDFs nobody reads start earning their keep."

**Starting point:** One association, their top 50 guidance documents loaded, 100 test members. No integration with membership systems — just a password-protected page. Measure: queries per member per month, member satisfaction, topics requested that aren't in the knowledge base (content gap analysis the association will love).

---

## 12. Infrastructure and Public Systems Transformation

### Paradigm shift

Public systems — healthcare, education, justice, social care — were designed for a world where human professionals were the only way to deliver expertise. The systems are over-capacity, under-funded, and collapsing in many countries. The shift isn't "AI replaces the doctor/teacher/social worker" — it's that a large proportion of professional interactions are actually navigation, triage, preparation, and follow-up. If AI can handle those, professionals can focus on the parts that genuinely require human judgment. And when the systems fail entirely (as they increasingly do), agentic AI can help communities build alternatives.

### Subcategories

#### Healthcare delivery and triage

_symptom assessment, appointment preparation, care pathway navigation_

See worked example below. Beyond GP triage, the same conversational pre-consultation model could work for dentistry (capturing symptoms and dental history before the appointment), physiotherapy (movement assessment and pain history), and mental health services (initial assessment that helps clinicians prepare). Each healthcare vertical has its own protocols but the pattern is identical.

##### Getting started

Approach a local PCN clinical director — PCNs have innovation budgets and a mandate to improve access, and clinical directors tend to be more tech-forward than individual GP partners.

#### Education systems

_personalised learning, teacher workload reduction, SEND support coordination_

A multi-academy trust could deploy an agent that helps SENCOs (Special Educational Needs Coordinators) manage their caseload. "I need to update the provision map for Year 3 — what interventions are we running and who's in each group?" The agent tracks SEND provision across the school, helps prepare for annual reviews, and drafts the paperwork that SENCOs spend evenings on. Start with one school, scale through the trust. Revenue via per-school subscription, justified by SENCO time savings and compliance confidence.

##### Getting started

SENCOs are very active on Twitter/X and in Facebook groups — find one who's vocal about workload and offer to build a prototype around their specific frustrations.

#### Government services and case management

_benefits processing, social housing allocation, licensing_

A local authority's housing allocations team could deploy an agent that helps applicants understand the social housing process. "I've been on the waiting list for two years — how does the points system work and can I increase my priority?" The agent explains the allocations policy in plain language, helps applicants check their banding is correct, and identifies whether changed circumstances (new medical evidence, overcrowding) warrant a review. This doesn't change the allocation process but makes it transparent and navigable.

##### Getting started

Approach a council's digital transformation team — many councils have innovation officers actively looking for projects like this, and their allocations policies are public documents.

#### Justice and legal systems

_court preparation, legal aid triage, victim support coordination_

A victim support organisation could deploy an agent that helps crime victims understand the court process. "I've been told I need to give evidence at a Crown Court trial — what happens?" The agent explains the process step by step, addresses common anxieties (cross-examination, seeing the defendant), explains special measures they can request, and helps them prepare. Currently this is done by volunteer witness supporters with variable training. An agent could provide consistent, thorough preparation.

##### Getting started

Contact Victim Support's national office — they're a large charity with a technology team and regularly look for ways to support their volunteer workforce.

#### Transport and urban planning

_public consultation, route optimisation, demand modelling_

A city council running a public consultation on a proposed cycling lane could deploy an agent that makes the consultation genuinely accessible. Instead of a 40-page PDF and a feedback form, residents describe their concerns conversationally: "I live on that road and I'm worried about losing parking" or "I cycle that route and the current road layout is dangerous." The agent captures structured feedback, identifies themes, and produces a consultation report. More inclusive, richer data, and probably better engagement than the traditional approach.

##### Getting started

Find a live local consultation (they're listed on every council website), build a prototype that makes it conversational, and show it to the council's consultation team as a proof of concept.

#### Social care and safeguarding

_needs assessment, care package coordination, carer support_

A carers' support charity could deploy an agent that helps unpaid carers navigate available support. "I've been looking after my mum who has dementia — I'm exhausted and I don't know what help I can get." The agent walks through carer's assessments, respite options, financial support (Carer's Allowance, Attendance Allowance), and local services. Carers are often too busy caring to research their options — an agent that can be consulted at 11pm when the person they care for is finally asleep could be genuinely valuable.

##### Getting started

Approach Carers UK or a local carers' centre — they publish excellent guidance that could seed the knowledge base, and they understand the 24/7 nature of their audience's needs.

#### Post-institutional alternatives

_community-organised versions of failing public services_

A homeschooling co-operative could use an agent to coordinate curriculum, share resources, and track progress across families. "We're covering the Tudors this term — what resources do other families recommend? What does the national curriculum expect at Key Stage 2?" The agent holds the collective knowledge of the co-op, helps with curriculum planning, and connects families with complementary expertise ("three families in the group have a parent with a science background who could do a group session"). More speculative, but relevant as alternative education grows.

##### Getting started

Home education Facebook groups are large and active — post asking whether coordination tools would be useful and see what response you get before building anything.

### Worked example: GP surgery triage and appointment preparation

**The opportunity:** GP surgeries handle an enormous volume of consultations. A significant portion of appointment time is likely spent on history-taking and information-gathering that could happen before the patient walks in. Receptionists (generally untrained in clinical triage) are often the front line for "is this urgent?" decisions. Patients may wait weeks for appointments, then get a short consultation in which the GP spends much of the time catching up on context. Online triage systems like eConsult exist but are form-based and widely disliked by both patients and clinicians. There's an interesting opportunity in making pre-consultation capture conversational rather than form-based — and potentially giving GPs a structured summary before the patient walks in.

**How Sunrise addresses it:** An agent with the surgery's clinical protocols in the knowledge base (not general medical knowledge — the practice's specific pathways, referral criteria, and local services). Before an appointment, the patient has a conversational interaction: "What's been going on? How long? What have you tried?" The agent captures a structured pre-consultation summary for the GP (using a workflow template), flags red flags for urgent review, and suggests relevant investigations the GP might want to order. Critically, it's conversational not form-based — the patient describes their problem naturally, the agent asks intelligent follow-ups. Output guard ensures no diagnostic claims.

**Venture studio path:** Partner with one forward-thinking GP practice or PCN (Primary Care Network, ~30-50k patients). Fund the pilot via NHS Innovation funding or an AHSN (Academic Health Science Network) — they exist specifically to fund this kind of trial. Revenue model: per-practice subscription, or per-consultation fee. Trojan horse: once triage works, extend to chronic disease management (diabetes reviews, asthma check-ups) and post-consultation summaries for patients. Scale through PCNs (one decision-maker covers 5-10 practices) and GP software vendors (EMIS, SystmOne) as an integration partner.

**Value-based sales message:** "What if your GPs got a structured clinical summary before the patient walked in — captured conversationally, not via a form patients hate?"

**Starting point:** One practice, one pathway (e.g., musculoskeletal complaints — high volume, low urgency, well-defined triage criteria). Agent generates a pre-consultation summary document the GP reads before the patient walks in. No integration with clinical systems initially — the summary is a document, not a data feed. Measure: GP satisfaction, consultation time utilisation, patient preference vs. existing triage.

---

## 13. New Categories of Human-AI Collaboration

### Paradigm shift

Most AI applications are framed as automation — the AI does what a human used to do, but faster or cheaper. The more interesting frontier is collaboration — things that neither the human nor the AI could do alone. A musician who can't read notation collaborating with an AI that can structure their improvisations. A person with early-stage dementia using an AI to maintain continuity of memory. A community using collective AI-facilitated deliberation to reach decisions that no committee process could achieve. These aren't efficiency plays — they're capability expansions.

### Subcategories

#### Co-creation

_art, writing, design, music, game design, architecture where AI is a creative partner_

A music education charity could deploy an agent that helps young people compose music. "I've got a melody in my head but I can't write it down — I can hum it." The agent helps translate hummed melodies into notation or MIDI, suggests harmonic structures, and teaches music theory through the act of creating rather than through abstract lessons. The knowledge base contains the charity's pedagogy and repertoire. This isn't AI generating music — it's AI helping someone who has musical ideas but lacks the technical vocabulary to express them.

##### Getting started

Approach a music education charity like Youth Music or a local music hub — they're often keen on technology projects and may have grant funding earmarked for innovation.

#### Augmented decision-making

_AI that structures complex decisions without making them for you_

A small business owner facing a significant decision ("should I take on a commercial lease, hire my first employee, or keep working from home?") could use an agent that helps structure the thinking. The agent doesn't decide — it asks the right questions, surfaces considerations the owner might not have thought of, models scenarios, and helps them articulate their own priorities. This could be offered as part of a business mentoring programme, or as a standalone tool for the large population of small business owners who don't have a board or trusted advisors.

##### Getting started

Build a prototype with a generic small business decision framework, then test it with 5-10 business owners through a local enterprise hub or FSB (Federation of Small Businesses) chapter — their feedback will shape what the agent actually needs to know.

#### Personal AI

_life admin, reflection, memory augmentation, habit formation_

A personal agent that handles life admin — "I need to renew my car insurance, switch energy provider, and sort out a dentist appointment." The agent tracks tasks, researches options, and handles the tedious comparison and form-filling. More interestingly, it could serve as a structured reflection tool — daily check-ins that help people track their own thinking and goals over time, creating a personal knowledge base they can query ("what was I worried about this time last year?"). Early-stage and speculative, but the demand for personal AI assistants seems real.

##### Getting started

Dogfood this one — build a personal admin agent for yourself, use it daily for a month, and document what works and what doesn't. The authentic experience of using your own tool is the best pitch material.

#### Intergenerational knowledge transfer

_capturing and making accessible the knowledge of older generations_

See worked example below. Beyond business succession, this pattern applies to family history (grandparents' stories captured conversationally and made queryable by future generations), community elders (local knowledge that would otherwise be lost), and retiring specialists in any field (the master craftsperson, the experienced clinician, the long-serving teacher). Each is a discrete project with a clear deliverable.

##### Getting started

Find one retiring professional in your own network — a family friend closing their business, a relative with decades of specialist knowledge — and do the first capture for free as a case study.

#### Simulation and scenario planning

_"what if" exploration for personal, business, or policy decisions_

A local council considering the impact of a new housing development could deploy an agent that helps model scenarios: "what happens to school capacity if 500 new homes are built? What about GP registration? Traffic on the B-road?" The agent draws on census data, school capacity data, and transport models loaded into the knowledge base. This is currently done by expensive consultants producing static reports — a conversational scenario tool could make the exploration iterative and accessible to councillors who aren't data analysts.

##### Getting started

Approach a planning consultancy that already does this work with spreadsheets and reports — they'd be a natural partner to test whether a conversational interface changes how councillors engage with the data.

#### Companion and accountability partnerships

_AI as consistent support for behaviour change_

A smoking cessation service could deploy an agent as a between-appointment companion. The agent checks in daily, helps manage cravings in the moment ("I'm about to buy cigarettes — talk me through this"), tracks progress, and celebrates milestones. Unlike a human supporter, it's available at 2am when the craving hits. The knowledge base contains evidence-based cessation strategies from the service's clinical team. Revenue via the NHS Stop Smoking service (which funds cessation support) or via private health insurers who benefit from reduced claims.

##### Getting started

Approach a local authority Stop Smoking service — they have budgets, measurable outcomes, and a captive user group who've already opted in to support. Offer a 3-month pilot alongside their existing programme.

#### Augmented survival and adaptation

_AI helping people navigate rapidly changing conditions_

In a rapidly changing regulatory environment (post-Brexit trade rules, for example), a small import/export business could deploy an agent that helps them stay compliant. "I'm importing olive oil from Italy — what's changed since January?" The agent tracks regulatory changes, customs requirements, and certification needs, providing guidance specific to the business's products and trade routes. The knowledge base is updated as regulations change. This is a pattern that becomes more valuable as the world becomes more complex and unpredictable.

##### Getting started

Pick one specific regulatory area you can become expert in quickly (e.g., food import rules post-Brexit), build a prototype agent with HMRC and Border Force guidance in the knowledge base, and cold-approach 20 small importers in that sector with a free trial.

#### Collective intelligence

_AI-facilitated group sensemaking, deliberation, and consensus-building_

A citizens' assembly (increasingly popular in UK local and national governance) could use an agent to facilitate deliberation. Participants submit their views on a topic ("what should our town prioritise: more housing, better transport, or green spaces?"), the agent synthesises the arguments, identifies areas of agreement and disagreement, surfaces trade-offs, and helps the group converge on shared priorities. This is more structured than a town hall meeting and more inclusive than a committee. Interesting as a tool for democratic innovation organisations like Involve or DemSoc.

##### Getting started

Contact Involve or DemSoc directly with a working demo — these organisations are actively looking for digital tools to support deliberative democracy and are likely receptive to a well-framed approach.

### Worked example: Intergenerational knowledge transfer for family businesses

**The opportunity:** When the founder of a small family business retires or dies, decades of relationship knowledge, supplier negotiations, customer preferences, and "how we do things" typically goes with them. Succession planning focuses on legal and financial transfer — not knowledge transfer. A third-generation butcher knows which farms produce the best beef in which season, which customers want their mince lean, and why they stopped using that particular supplier in 2015. This kind of tacit knowledge may be worth more than the physical assets of the business, but it's rarely captured in any structured way. Agentic AI offers an intriguing approach: structured conversations that capture knowledge in a form that can be queried by a successor, rather than lost.

**How Sunrise addresses it:** An agent conducts structured knowledge-capture conversations with the retiring founder: "Tell me about your suppliers — who do you trust and why? Who's unreliable? What are the stories behind those relationships?" The conversations are ingested into the knowledge base, creating a searchable, queryable institutional memory. The successor can then ask the agent: "Dad used to get lamb from three different farms depending on the season — which ones and why?" The agent answers from the founder's own words and reasoning. A workflow can structure the capture process: key topics to cover, follow-up questions when answers are vague, gap identification.

**Venture studio path:** Partner with a business succession advisory firm or a local chamber of commerce. Position as part of the succession planning package. Revenue: one-off knowledge capture fee (2-4k for the structured interview and agent setup) plus ongoing subscription for the knowledge base. Trojan horse: the same pattern works for any organisation where institutional knowledge is concentrated in a few heads — law firms, medical practices, engineering firms, charities. The business succession angle is the entry point because there's a clear trigger event (retirement) and an obvious buyer (the successor or the advisory firm).

**Value-based sales message:** "Your founder's 30 years of knowledge shouldn't retire when they do. Capture it in conversations. Access it forever."

**Starting point:** One business, 5-10 hours of structured conversation with the founder, ingested into a knowledge base. The successor gets an agent they can query. No integrations, no complexity — just captured knowledge made accessible. Measure: successor satisfaction, questions answered that would otherwise have been lost, time to competence for the successor.

---

## 14. Data-to-Decision Pipelines for Complex Domains

### Paradigm shift

Complex domains generate enormous amounts of data — climate sensors, health records, financial markets, supply chain logistics — but the bottleneck has never been data collection. It's synthesis: turning data into decisions. Previously, this required expensive analysts or consultants. Agentic AI can ingest data, identify patterns, generate interpretations, and present options — not replacing human judgment but making it possible for a wider range of people and organisations to engage with complex data at all.

### Subcategories

#### Climate and environmental monitoring

_sensor data interpretation, compliance tracking, impact assessment_

A river trust could deploy an agent that helps volunteer water quality monitors interpret their data. Volunteers collect samples and enter readings — the agent interprets the results in context ("phosphate levels at this site have been trending upward over the last 6 months — this could indicate agricultural run-off from the land upstream"), identifies patterns across monitoring sites, and helps draft reports to the Environment Agency. The knowledge base contains water quality standards, local catchment data, and reporting protocols.

##### Getting started

Volunteer with a river trust for a few months to understand the workflow firsthand — Waterkeeper Alliance and local Rivers Trusts are always short of technical help, and you'll learn exactly where the data interpretation bottleneck is.

#### Epidemiology and public health

_outbreak detection, health trend analysis, intervention planning_

A local public health team could deploy an agent that helps analysts spot patterns in health data. "Show me respiratory illness presentations across GP practices this month compared to the same period last year — any clusters?" The agent ingests anonymised health data, identifies anomalies, and helps the team prioritise investigation. Currently this analysis requires specialist epidemiologists — an agent could make it accessible to public health officers with less statistical training.

##### Getting started

Approach one local authority's public health team through their Director of Public Health — these teams are chronically under-resourced and often receptive to innovation partnerships, especially if you can frame it as a no-cost pilot.

#### Supply chain optimisation

_disruption detection, alternative sourcing, demand forecasting_

A small UK manufacturer that imports components from multiple countries could deploy an agent that monitors supply chain risk. "What's the current situation with shipping from the Suez Canal? Do we have alternative suppliers for the capacitors we usually source from Shenzhen?" The agent tracks news, shipping data, and supplier status, and alerts when disruptions may affect the business. Knowledge base includes supplier databases, lead times, and alternative sourcing options. Revenue via subscription to small manufacturers.

##### Getting started

Attend a Make UK or Manufacturing NI event and talk to small manufacturers about their recent supply disruptions — the stories will tell you exactly what data sources the agent needs to monitor.

#### Energy grid management

_demand prediction, renewable integration, load balancing_

A community energy cooperative running a local solar farm could deploy an agent that helps manage generation and demand. "We're generating more than we can use today — which members should we alert to run their washing machines now?" The agent matches generation forecasts (weather data) to demand patterns (member usage profiles) and coordinates load shifting. More speculative, but community energy is growing and the coordination challenge is real. Could also help with battery storage decisions and export optimisation.

##### Getting started

Community Energy England maintains a directory of community energy groups — find one with a solar installation and offer to build a demand-matching prototype as an innovation project.

#### Financial risk modelling

_portfolio analysis, scenario testing, regulatory compliance_

A small IFA (Independent Financial Adviser) practice could deploy an agent that helps with portfolio scenario testing. "If interest rates rise by 1% and sterling falls 10%, what happens to this client's portfolio?" The agent models scenarios using fund composition data and historical correlations. Currently this requires expensive portfolio analysis tools — an agent with financial data in the knowledge base could make it accessible to smaller practices. Revenue via subscription positioned against the cost of commercial portfolio tools.

##### Getting started

If you know an IFA personally, offer to build a prototype for free. If not, attend a local CISI (Chartered Institute for Securities and Investment) networking event — advisers there will tell you exactly what tools they wish existed.

#### Urban development and planning

_impact modelling, community feedback analysis, infrastructure planning_

A planning consultancy could deploy an agent that helps analyse community consultation responses. After a public consultation generates hundreds of free-text responses, the agent categorises concerns, identifies themes, quantifies sentiment, and produces a structured consultation report. Currently this is done manually by junior consultants over days or weeks. The agent could produce a first-pass analysis in hours, with the human focusing on interpretation and recommendations.

##### Getting started

Many planning consultation responses are published as public documents — download one, build a prototype that analyses it, and show the results to a planning consultancy as a cold demo of what's possible.

#### Real-time geopolitical risk assessment

_sanctions monitoring, trade disruption, regulatory change tracking_

A mid-size law firm with international clients could deploy an agent that monitors sanctions and regulatory changes. "Has anything changed in the last week that affects our clients trading with Turkey?" The agent tracks OFSI (Office of Financial Sanctions Implementation), EU, and UN sanctions lists, regulatory updates, and trade policy changes, and alerts the relevant partner. Currently this monitoring is either manual (and patchy) or requires expensive compliance platforms. An agent with regulatory feeds in the knowledge base could serve smaller firms.

##### Getting started

OFSI publishes its sanctions list freely — build a prototype that monitors it and generates plain-English alerts, then approach mid-tier law firms through their compliance partners with a working demo.

#### Alternative economic indicators

_on-chain analytics, community economic health, informal economy measurement_

An economic research organisation could deploy an agent that tracks alternative indicators of economic health — Bitcoin adoption rates, local currency transaction volumes, mutual aid activity, community energy generation, food bank usage. "What does the on-chain data tell us about Bitcoin adoption in the UK this quarter?" These indicators may tell a different story from official statistics and could be valuable for investors, policymakers, and community organisations. Speculative, but the data is increasingly available and the demand for alternative perspectives on economic health is growing.

##### Getting started

Build a prototype using freely available on-chain data (Mempool.space API, Clark Moody dashboard) and publish a monthly "alternative indicators" report — the content itself becomes marketing for the tool.

### Worked example: Small farm regenerative agriculture advisor

**The opportunity:** Regenerative agriculture (soil health, biodiversity, carbon sequestration) requires understanding complex interactions between soil biology, crop rotation, cover cropping, grazing management, and local climate. Larger farms may hire agronomists; smaller farms often rely on generic guidance, neighbouring farmers' advice, and trial and error. The knowledge exists in academic research, but it's largely inaccessible to a working farmer. Government schemes (Environmental Land Management) pay farmers for regenerative practices but the application and monitoring process is complex. There's an interesting confluence here: farmers who want to do the right thing but need contextualised guidance, and a grant system that's too bureaucratic for many to navigate — both potentially addressable by a knowledgeable agent.

**How Sunrise addresses it:** An agent with agricultural research, soil science guidance, and local climate data in the knowledge base. The farmer describes their land: "120 acres, heavy clay, currently arable wheat and barley rotation, I want to introduce cover crops and mob grazing." The agent builds a contextualised plan, referencing relevant research ("on heavy clay, a diverse cover crop mix including deep-rooted species like daikon radish will improve drainage — here's the research"). A capability could integrate with weather and soil data APIs. A scheduled workflow provides seasonal reminders and check-ins. The agent also helps with grant applications by drafting ELM submissions based on the management plan.

**Venture studio path:** Partner with a regenerative farming organisation (Groundswell, Pasture-Fed Livestock Association) or an agricultural college. Revenue: subscription per farm — positioned against the cost of one agronomist visit (which the agent doesn't replace, but reduces the frequency needed). Trojan horse: once the farming advisor is validated, the same platform serves garden designers, allotment associations, and conservation land managers. The grant application assistance alone justifies the subscription for many farmers. Longer term: aggregate anonymised soil and practice data across farms — valuable for agricultural research and carbon credit verification.

**Value-based sales message:** "Regenerative farming advice grounded in science and specific to your land — not generic pamphlets. Plus, help with the ELM paperwork that's stopping you from getting paid for doing the right thing."

**Starting point:** One agent, knowledge base loaded with publicly available regenerative agriculture guides (Soil Association, AHDB, Innovative Farmers network) and ELM scheme documentation. Test with 15 farms through a farming network. Measure: practice adoption, grant application success rate, farmer confidence in soil management decisions.

---

## 15. Agentic AI as the Interface Layer for Emerging Technologies

### Paradigm shift

Most emerging technologies are powerful but unusable by normal people. Blockchain requires understanding wallets, gas fees, and smart contracts. IoT generates data that nobody analyses. XR/VR is impressive but lacks compelling daily utility. Agentic AI becomes the conversational control plane — the layer that makes complex technology accessible through natural language. Instead of learning to use the technology, you tell the agent what you want and it operates the technology on your behalf. This is where agentic AI becomes a multiplier for every other technology trend.

### Subcategories

#### Blockchain and DeFi navigation

_wallet management, yield strategies, governance participation, smart contract interaction without Solidity_

See worked example below. Beyond business adoption, there's an opportunity for personal Bitcoin/crypto guidance — "I want to set up a multi-sig wallet for my family's savings, how does that work?" or "I'm interested in participating in Nostr governance but I don't understand how zaps work." The agent makes the crypto ecosystem accessible without requiring users to learn the jargon first. Partner with Bitcoin education organisations for content and credibility.

##### Getting started

Attend a Bitcoin meetup (every major UK city has one) and offer to build a prototype for a common pain point discussed there — wallet setup confusion, tax questions, or inheritance planning are consistently popular topics.

#### IoT and sensor orchestration

_interpreting sensor data, automating responses, monitoring dashboards for non-technical users_

A small commercial greenhouse could deploy an agent that interprets data from temperature, humidity, and soil moisture sensors. "The temperature in tunnel 3 spiked to 35 degrees at 2pm yesterday — is that a problem for my tomatoes?" The agent understands the crop requirements, interprets the data in context, and either takes automated action (triggering ventilation via an IoT capability) or alerts the grower with a recommendation. This turns dumb sensors into an intelligent growing assistant. Partner with an agricultural IoT hardware supplier.

##### Getting started

Find an IoT hardware company already selling sensors to growers (several UK-based ones attend the GLEE and LAMMA trade shows) and propose a joint offering — they sell hardware, you provide the intelligence layer.

#### XR and spatial computing companions

_AI agents that exist in immersive environments as guides and collaborators_

A heritage site could deploy an AI guide that visitors interact with through AR (augmented reality) on their phones. Point the camera at a feature and ask: "What am I looking at? When was this built?" The agent knows the site's history and archaeology (knowledge base), and responds to what the visitor is seeing. More engaging than an audio guide, more available than a human guide. Start with one heritage site, expand through heritage organisations like English Heritage or the National Trust. This requires AR integration beyond current Sunrise capabilities but the knowledge and conversation layer is a natural fit.

##### Getting started

Approach a single heritage site with a working text-based knowledge agent first — prove the knowledge layer adds value before investing in the AR integration. English Heritage has an innovation team that takes pitches.

#### Robotics coordination

_decision-making layer for physical systems in warehouses, farms, care settings_

A small fulfilment warehouse could deploy an agent as the decision-making layer for their picking robots. "We've got 200 orders to ship by 5pm, three robots available, and aisle 7 is blocked for restocking." The agent optimises routing and task allocation, handles exceptions conversationally when the warehouse manager needs to intervene, and adapts when conditions change. This is more speculative and depends on robotics integration capabilities, but the decision and coordination layer is where Sunrise's workflow engine would add value.

##### Getting started

This is too speculative for a cold approach — start by building a simulated warehouse coordination demo and share it in robotics communities (UK RAS Network, robotics meetups) to find a partner with actual hardware to test against.

#### Digital fabrication and 3D printing

_design agents that turn intent into printable outputs_

A maker space or FabLab could deploy an agent that helps members design printable objects. "I need a bracket to mount a Raspberry Pi to the underside of my desk — the desk is 25mm thick." The agent captures the requirements conversationally, generates a parametric design (via a capability calling an OpenSCAD API or similar), and prepares it for the specific printer in the space. This democratises 3D printing for people who have practical needs but can't use CAD software. Revenue via the maker space membership, or as a standalone tool for the growing 3D printing hobbyist community.

##### Getting started

Join a local maker space or FabLab and observe what people struggle with — then build a prototype that solves the most common "I want to print X but can't design it" problem. The maker community is enthusiastic about testing new tools.

#### Biotech and genomics interpretation

_lab results, genetic data, and protocol guidance for citizen scientists and patients_

A citizen science project studying local biodiversity could deploy an agent that helps volunteers interpret eDNA (environmental DNA) sampling results. "We took a water sample from the river and the lab found traces of great crested newt — what does that mean for the development proposal?" The agent explains the significance, suggests follow-up sampling protocols, and helps write up findings for submission to the local planning authority. The knowledge base contains species identification guides, legal protections, and sampling protocols.

##### Getting started

Citizen science projects are coordinated through organisations like the Freshwater Habitats Trust and local Wildlife Trusts — volunteer for an eDNA project and you'll quickly see where data interpretation support is needed.

#### Agent-to-agent economies

_autonomous agents transacting with each other, settled via crypto micropayments_

This is the most speculative subcategory but potentially the most transformative. Imagine a network where your personal purchasing agent queries multiple supplier agents: "I need 500 business cards, 400gsm, matte laminate, delivered by Friday." The supplier agents compete on price and terms, and the transaction settles via Lightning. No human negotiation, no comparison websites — agents transacting on your behalf within parameters you set. This requires significant infrastructure development but the Sunrise capability and workflow systems provide the decision-making and approval-gate foundation.

##### Getting started

Build a simplified proof-of-concept where two Sunrise agents negotiate a simulated transaction over Lightning — publish the demo and write-up to attract collaborators from the Bitcoin and AI agent communities.

#### Decentralised identity and self-sovereign data

_personal AI agents managing your data, credentials, and consent_

A personal AI agent that manages your data sharing across services. Instead of clicking "accept all cookies" or manually configuring privacy settings on every site, your agent manages consent according to your preferences: "share my email with this service but not my location, and revoke access if they haven't contacted me in 6 months." This intersects with emerging standards around decentralised identity (DIDs, Verifiable Credentials) and could become more relevant as data sovereignty becomes a mainstream concern. Early-stage, but the personal agent concept is a natural fit.

##### Getting started

Follow the W3C Decentralised Identifiers working group and Verifiable Credentials community — build a prototype consent manager and share it in privacy-focused communities (e.g., Open Rights Group) to find early adopters who care deeply about data sovereignty.

### Worked example: Bitcoin and Lightning network onboarding for small businesses

**The opportunity:** Small businesses increasingly encounter Bitcoin — whether driven by curiosity, concerns about currency stability, de-banking experiences, or customer demand. But the practical steps are bewildering: which wallet, how to accept payments, tax implications, conversion strategies, Lightning vs. on-chain, custody options. Existing resources tend to assume technical literacy. Many accountants don't yet understand it well. Payment processors exist (BTCPay Server, Strike, CoinCorner) but setup and management can require technical knowledge. There may be an opportunity in being the "knowledgeable friend" who walks a business through adoption step by step — and stays around to answer ongoing questions about accounting, tax, and operations.

**How Sunrise addresses it:** An agent with Bitcoin/Lightning educational content, BTCPay Server documentation, HMRC crypto tax guidance, and payment integration guides in the knowledge base. The agent starts with the business's situation: "What kind of business are you? What payment methods do you accept now? What's your monthly card processing bill?" Based on answers, it builds a personalised adoption path: which wallet, which payment processor, how to handle accounting, how to explain it to customers. A capability could interact with BTCPay Server's API for basic setup tasks. The agent is an ongoing advisor: "A customer paid 0.003 BTC yesterday — here's what you need to record for tax purposes."

**Venture studio path:** Partner with a Bitcoin payment processor (BTCPay Server community, CoinCorner, or similar) as a referral channel. Revenue: monthly subscription positioned against card processing fee savings. Trojan horse: once Bitcoin payments are set up, the same agent handles crypto accounting, tax reporting, and treasury management (when to hold, when to convert). The Bitcoin-friendly business community is tight-knit and evangelical — early adopters become advocates. Scale through Bitcoin meetups, business networks, and the payment processor's existing merchant base.

**Value-based sales message:** "Accept Bitcoin payments without becoming a crypto expert. Your AI advisor sets you up, handles the accounting, and answers every question in plain English — from your first satoshi to your tax return."

**Starting point:** One agent, knowledge base loaded with BTCPay Server docs, HMRC crypto guidance, and a curated set of "Bitcoin for business" resources. Test with 10 small businesses referred by a Bitcoin meetup group. Measure: successful payment setup rate, ongoing usage, questions the agent can't answer (knowledge gaps to fill).

---

## 16. Resilience, Sovereignty and Alternative Systems

### Paradigm shift

The 2020s have revealed that institutional stability cannot be assumed. Banking systems de-bank lawful businesses, supply chains fragment overnight, currencies lose purchasing power, governments change rules capriciously, and information ecosystems are weaponised. People and communities need tools to build resilience — not prepper bunkers, but practical systems for maintaining agency when centralised infrastructure becomes unreliable or adversarial. Agentic AI is uniquely suited because it can operate locally (Ollama/LM Studio), doesn't depend on any single cloud provider, and can help coordinate complex responses to novel situations.

### Subcategories

#### Financial resilience and alternative currencies

_Bitcoin savings strategies, local currency systems, barter coordination, multi-currency management_

See worked example below. Beyond the community hub, there's a more focused opportunity in Bitcoin savings guidance for individuals concerned about currency debasement. "I want to start saving in Bitcoin but I don't know how much, how often, or how to custody it safely." The agent provides practical, non-ideological guidance on dollar-cost averaging, self-custody best practices, tax implications, and inheritance planning. Partner with a Bitcoin-only financial services provider for credibility and referrals.

##### Getting started

Create a straightforward Bitcoin savings guidance agent and share it at a Bitcoin meetup — the community will stress-test it immediately and tell you what's wrong, which is exactly the feedback you need.

#### Supply chain localisation

_local supplier discovery, group purchasing coordination, inventory sharing between small businesses_

A network of independent restaurants in a city could deploy an agent that coordinates group purchasing from local suppliers. "Who else in the network needs free-range eggs this week? Can we do a joint order from the farm in Kent?" The agent aggregates demand across the network, negotiates bulk pricing, and coordinates delivery. This reduces costs for individual restaurants and supports local suppliers. Start with one restaurant network, expand through hospitality associations. The same pattern works for any small business cluster — independent bookshops, craft breweries, bakeries.

##### Getting started

Find a restaurant buying group or independent retailer network that already coordinates informally (WhatsApp groups, spreadsheets) and offer to build a coordination tool that formalises what they're already doing.

#### Parallel institution building

_community-organised alternatives to degraded public services (homeschool co-ops, community health, dispute resolution)_

A community mediation service could deploy an agent that handles initial conflict assessment and preparation. Neighbours in dispute describe their perspectives separately to the agent, which identifies the core issues, common ground, and likely sticking points, and prepares a structured brief for the human mediator. This makes volunteer mediators more effective and reduces the preparation time per case. Partner with a community mediation charity. Revenue via local authority contracts (mediation reduces the cost of anti-social behaviour cases and housing disputes).

##### Getting started

Community mediation charities are listed on the Civil Mediation Council's directory — contact one and offer to build a conflict assessment prototype that their volunteer mediators can test with real (anonymised) case scenarios.

#### Crisis response and emergency coordination

_disaster response, refugee coordination, resource allocation under scarcity_

A community flood response group could deploy an agent (running locally on Ollama — crucial when the internet may be down) that coordinates during flooding events. "Water is rising on Mill Lane — who has sandbags? Can someone check on the elderly residents at numbers 12 and 14?" The agent matches resources to needs, tracks which areas have been checked, and maintains a situation log. Deployed on a local network, it works even when mobile data is unreliable. Partner with a flood resilience charity or the Environment Agency's community engagement programme.

##### Getting started

The National Flood Forum works with community flood groups across the UK — approach them with a working prototype running on Ollama and demonstrate the offline-first capability, which is the key differentiator for a crisis tool.

#### Information sovereignty and counter-narrative

_fact-checking tools, source verification, community-owned information channels_

A local news cooperative could deploy an agent that helps citizen journalists verify claims. "The council says they've planted 10,000 trees this year — can we verify that?" The agent checks against FOI data, council minutes, and satellite imagery in the knowledge base, and helps draft a fact-check article with sources. This strengthens community-owned media in an era of declining local journalism and increasing misinformation. Grant-funded initially, potentially via journalism foundations or public interest media funds.

##### Getting started

The Centre for Investigative Journalism and the Bureau of Investigative Journalism both support local journalism — approach with a prototype that demonstrates source verification on a published council claim using FOI data.

#### Cross-border and multi-jurisdictional navigation

_regulatory complexity, sanctions compliance, multi-polar trade navigation_

A small UK exporter selling to both the EU and non-EU markets could deploy an agent that navigates the increasingly complex landscape of trade regulations. "I want to start selling to Saudi Arabia — what certifications do I need? Are there any sanctions implications for my product category?" The agent draws on trade guidance from the Department for Business, customs requirements, and product-specific regulations. This is the kind of multi-layered compliance question that currently requires an expensive trade consultant. Revenue via subscription to SME exporters.

##### Getting started

The Institute of Export & International Trade runs events and has member forums — post about your prototype there or attend an export documentation workshop to find small exporters struggling with exactly these problems.

#### Community self-governance

_decision-making tools, resource allocation, conflict resolution without traditional authority structures_

A housing cooperative could deploy an agent that facilitates collective decision-making. "We need to decide whether to spend our maintenance reserve on roof repairs or new windows — what are the arguments and how should we structure the vote?" The agent helps frame proposals, ensures all members have the information they need, manages the voting process, and documents decisions. This is particularly relevant for organisations using sociocracy or other non-hierarchical governance models where the process itself is complex.

##### Getting started

Housing cooperatives are federated through the Confederation of Co-operative Housing — attend their annual conference or contact a local co-op and offer to build a decision-facilitation prototype for their next AGM or policy decision.

#### Economic transition support

_helping people adapt to paradigm shifts (de-dollarisation, automation displacement, post-employment economy)_

An agent that helps individuals think through economic transitions — "my industry is being automated and I need to figure out what to do next." The agent helps assess transferable skills, explores adjacent career paths, identifies retraining options (and funding for them), and connects to relevant support services. Less about job searching (plenty of tools for that) and more about structured thinking for people facing fundamental economic shifts. Could be offered through trade unions, job centres, or adult education providers. Increasingly relevant as automation displaces roles across multiple sectors simultaneously.

##### Getting started

Approach a trade union learning representative or a local adult education college — they're already having these conversations with workers facing displacement and would value a structured thinking tool to complement their human guidance.

### Worked example: Community financial resilience hub

**The opportunity:** In an environment of currency uncertainty, bank de-platforming, and financial system fragility, individuals and small communities may increasingly look for tools to build collective financial resilience. A family wanting to diversify savings, a community group wanting to set up a local exchange trading system (LETS), a small business network wanting to establish mutual credit — all face a similar barrier: the knowledge and coordination overhead is high. Traditional financial advisors generally don't cover these topics. Online information tends to be either too technical or too ideological. There might be a space for a practical, non-ideological agent that helps people and communities explore their options and coordinate collective action.

**How Sunrise addresses it:** An agent serving a local community with financial resilience knowledge in the knowledge base: Bitcoin basics and savings strategies, LETS/mutual credit system setup, group buying coordination, and basic financial planning for volatility. The agent is deployed locally (Ollama) so it doesn't depend on cloud providers — important for a resilience tool. Community members can ask about their specific situation: "I have savings in a bank I'm worried about — what are my options for diversifying?" or "Our business network wants to set up mutual credit — how do other communities have done this?" A workflow coordinates group actions (group Bitcoin buys to reduce fees, bulk purchasing cycles). The knowledge base includes local economic data and resources.

**Venture studio path:** Start with one community — a transition town, a Bitcoin circular economy group, or a business network. Deploy free initially, funded by the community or a small grant. Revenue emerges from three directions: (1) subscription from community groups who want their own instance, (2) referral fees from Bitcoin services (exchanges, custody), (3) consultancy to local authorities who want to understand community economic resilience. Trojan horse: the financial resilience community is a gateway to broader community coordination (mutual aid, local democracy, resource sharing — categories 7 and 8). The local-first deployment (Ollama) is a selling point: "this tool works even if AWS goes down."

**Value-based sales message:** "Financial resilience for your community — practical guidance on savings diversification, mutual credit, and group purchasing. Runs locally, works offline, doesn't depend on the systems it's helping you prepare for."

**Starting point:** One agent on Ollama (no cloud dependency), knowledge base loaded with open-source financial resilience resources, Bitcoin education materials, and LETS setup guides. Deploy with one community group. Measure: actions taken (savings diversified, LETS transactions, group purchases completed), member confidence in financial preparedness.

---

## Cross-cutting Themes

### The Trojan Horse Pattern

Every worked example above follows the same structure:

1. **Wedge** — start with one narrow, high-value problem for one specific partner
2. **Validate** — prove value with a small cohort and hard metrics
3. **Expand** — the same platform pattern serves adjacent problems (more knowledge base content, same agent architecture)
4. **Scale** — reach the broader market through the partner's network, industry associations, or white-labelling

This is deliberate. Agentic AI products have near-zero marginal cost for additional knowledge domains but high trust barriers. The wedge earns trust. The expansion leverages it.

### Why Sunrise Specifically

These opportunities are not unique to Sunrise — anyone could build an agent. But Sunrise's advantages for a venture studio are:

- **Speed to prototype** — a working agent with knowledge base, embed widget, and admin UI in days, not months
- **Multi-tenancy** — one codebase serves multiple clients/instances with isolated data
- **Cost predictability** — budget controls and cost tracking from day one, essential for subscription pricing
- **Provider flexibility** — start with cheap local models (Ollama), scale to production APIs, without re-architecture
- **Non-technical partner access** — admin UI lets domain experts manage knowledge and monitor usage
- **Workflow engine** — approval gates and multi-step processes for regulated domains
- **Embeddable** — deploy into partner's existing web presence, not a separate app

### Revenue Model Patterns

| Model                                  | When it works                           | Examples                |
| -------------------------------------- | --------------------------------------- | ----------------------- |
| **SaaS subscription**                  | Ongoing value, predictable usage        | Categories 3, 6, 10, 14 |
| **Per-transaction/per-use**            | High-value discrete interactions        | Categories 1, 5, 12     |
| **Revenue share/referral**             | Agent drives purchasing decisions       | Categories 2, 11, 15    |
| **One-off project fee**                | Knowledge capture, setup                | Category 13             |
| **Grant-funded (leads to commercial)** | Social impact with commercial adjacency | Categories 7, 8, 9      |
| **White-label licensing**              | Repeatable pattern across organisations | Categories 4, 11, 12    |
| **Freemium / community**               | Network effects, data value             | Categories 7, 16        |

### Ethical Guardrails

Several of these applications touch sensitive domains (health, legal, financial, housing). Non-negotiable principles:

1. **Never present AI output as professional advice** — always frame as guidance with escalation paths
2. **Output guards on every agent** — topic boundaries, PII detection, liability-aware language
3. **Human approval gates for consequential actions** — refunds, medical escalation, legal letter generation
4. **Transparent about limitations** — the agent should tell users when it doesn't know or when they need a professional
5. **Local-first option for sensitive domains** — Ollama/LM Studio deployment so data never leaves the premises
6. **Audit trail** — every conversation logged, every action traceable, essential for regulated sectors
