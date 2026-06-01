# AI Agent Manager — Business Plan (idea → money)

_Last updated: 2026-06-01_

This is the money path. It runs alongside `ROADMAP.md` (what to build) and answers: how do we sell it, get it in front of people, prove value, keep it simple, what it costs to build, what it costs to sell, and how every build step gets analyzed and improved before the next one.

The guiding rule (from hard experience): **sell, don't just build.** No infrastructure gets built until it has a money or traction reason. Free local value first; paid layer only when people ask for it.

---

## 1. The product in one breath

An open-source CLI + local dashboard that tells a developer what their coding agent will cost **before** they hit go, enforces a **hard spend ceiling** that physically stops the run, and when the agent gets stuck, hands back the exact rescue prompt. Free, local, nothing uploaded.

**Wedge line (use everywhere):**

> Know what your agent will cost before you build it — and set a hard ceiling so it never surprises you.

---

## 2. Why this is different (the uniqueness story)

The entire market — Langfuse, Helicone, Portkey, AgentOps, LangSmith — is **observability: a rear-view mirror.** It shows you the bill *after* you paid it. Our inversion: **prediction + a hard pre-commit ceiling, before the spend.** A circuit breaker, not a dashboard.

Three audiences, three versions of the same story:

- **Hacker News skeptic:** "Every tool here is a rear-view mirror — it shows the bill after you've paid it. This estimates the bill *before* you start and enforces a hard cap that physically stops the agent. It's a circuit breaker, not a dashboard. Core is MIT and 100% local — your code and tokens never touch my server."
- **Solo dev on Reddit:** "Ever wake up to a $40 Claude Code bill from an agent that looped all night? This tells you 'this build is roughly $3–7' before you hit go, then kills the run the second it hits your ceiling. Free, runs on your machine, nothing uploaded."
- **Paying team:** "Give every engineer a spend ceiling. Set org budgets, see which projects burn tokens, stop the 2am surprise invoice. Predictive budget governance for agentic coding — the thing observability can't do because it only measures the past."

**Honest moat read:** the *capability* (estimate-before-build + hard cap + completion verification) is the differentiator, but an incumbent could copy it in a sprint. The durable edge is **being the tool devs already have installed and trust** — won by being genuinely free, local, and honest (truth labels, no over-claiming). Speed to mindshare is the defense, not the feature.

---

## 3. Pricing ladder

Comps verified (2026): Langfuse Core $29 / Pro $199; Helicone Pro $79 / Team $799; Portkey Production $49; AgentOps Pro ~$40; Vercel AI Gateway pay-as-you-go. Indie-credible first paid tier sits at **$19–$79/mo**.

| Tier | Price | What you get | What it's for |
|---|---|---|---|
| **OSS Free** (MIT, local) | $0 forever | All local runs, cost estimation, hard spend cap, run wrapping, stuck detection, rescue prompts, local dashboard | Distribution engine. Never crippleware this. |
| **Pro** | **$19/mo** ($190/yr) | Cloud sync of run history across machines, hosted dashboard, estimate-vs-actual trend analytics (90 days), shareable run reports, Slack/Discord alert on cap breach or stuck agent | Impulse buy a solo dev expenses without asking |
| **Team** | **$49/seat/mo** (3+ seats) | Shared budget pools, org-wide ceilings, per-project cost rollups, SSO, role-based caps (junior devs get lower ceilings) | The 2am-surprise-invoice killer for teams |

**What we gate:** never the local core. Only **persistence, collaboration, aggregation** — things that only matter once data leaves the laptop. $19 is set deliberately *under* the field because we are indie-first.

---

## 4. Cost to build & run

The local OSS core is a CLI + local server → **$0/mo infra at any scale.** This is the single biggest structural advantage; it is also a marketing line ("nothing uploaded, runs on your machine").

Cheapest credible cloud stack for the eventual Pro/Team layer: **Vercel + Supabase (Postgres + Auth in one) + Vercel AI Gateway** for any summarization features.

| Users | Stack | Monthly |
|---|---|---|
| 0 | Vercel Hobby + Supabase Free | **$0** |
| 100 | Vercel Pro $20 + Supabase Pro $25 | **~$45** |
| 1,000 | + ~$15–45 egress/compute | **~$60–90** |

Run rows are tiny (metadata, not payloads), so DB growth is cheap. **Rule: do not provision cloud until 10+ people ask to sync.** Stay at $0.

**Founder time cost (the real cost):** Phase 0 hardening is days, not weeks, because the prototype already works. The expensive thing is attention, not money — so spend it on the launch, not on premature infra.

---

## 5. Cost to sell

- **Ads:** $0 this month. Do not buy traffic for a free OSS tool before organic proof.
- **Channels:** all free (HN, Reddit, X, GitHub, Product Hunt).
- **Billing rails:** Polar.sh (handles license keys + paid tiers for OSS, low fee) + GitHub Sponsors (zero cost). No Stripe integration needed at launch.
- **Customer acquisition cost target:** effectively $0 — earned distribution. The "cost to sell" is one excellent Show HN post and honest engagement in comments.

---

## 6. Distribution channels (ranked by ROI for a solo founder)

1. **Show HN — #1, hit first.** Engineered for HN: cost anxiety + "hard cap so it never surprises you." Effort: one good post + working repo. Reach: 5k–50k if front page. Highest-intent dev-tool traffic on the internet. **This is the launch.**
2. **Reddit — high ROI, low effort.** r/ClaudeAI, r/cursor, r/ChatGPTCoding, r/LocalLLaMA, r/SideProject. Post as a story ("my agent ran up $40 overnight"), not an ad. Comment-first doctrine applies.
3. **X/Twitter dev community — high if presence built.** A 30-sec screen recording of "estimate → cap → agent stops at ceiling" is inherently shareable. Compounds.
4. **GitHub trending — earned.** Strong README + HN/Reddit spike → trending → self-feeding stars. An outcome of #1–2, not a separate effort.
5. **Product Hunt — medium.** Credibility badge + traffic bump; launch *after* HN.
6. **YouTube demos — medium, slow.** High-trust, high-effort. After HN validates the message.
7. **dev.to / indie forums — low.** Backlinks/SEO, weak launch-day conversion.

---

## 7. GTM sequence (this week → first month)

1. **Repo first.** Working `npm run demo`, sharp README leading with the wedge line + the 15x-tokens hook + a GIF of a real stuck run being rescued. Honest claims only.
2. **Set up rails:** GitHub Sponsors + Polar.sh, with a **founding Pro license presale** (~$49–99, capped at 100 seats for urgency) to fund the cloud build later.
3. **Ship the landing page** at launchsoloai.com/agent-manager — wedge line, 30-sec demo, pricing, "install in 30 seconds," GitHub link. (Subsection of existing domain; keeps SEO, no new domain cost.)
4. **Show HN** with the wedge + hook + GIF. Be in the comments all day — HN rewards honest founders who don't over-claim.
5. **Reddit posts** across the target subs, staggered, story-led.
6. **Product Hunt** once there are stars + a few real users for social proof.

---

## 8. Funding / crowdfunding verdict

- **Skip Kickstarter/Indiegogo** — they're for physical/consumer products; an OSS dev CLI there signals "doesn't understand its market."
- **GitHub Sponsors** — set up day one. Goodwill tipping, not a revenue plan (realistically tens–low-hundreds/mo).
- **Polar.sh** — the billing rail. License keys + paid private tiers + founding-license presale.
- **Recommendation: bootstrap via the paid cloud tier; don't crowdfund.** Free local value earns trust first, then converts the subset that wants sync/collaboration. That sequencing is the answer to "another observability tool" skepticism.

---

## 9. Realistic month-one outcome (honest)

If Show HN lands: a few hundred to low-thousands of installs, GitHub stars, single-digit to low-double-digit paid conversions from the founding-license presale. **Not "revenue fast" in a VC sense** — a real, $0-burn wedge into a market actively scared of its agent bills. The win condition for month one is **installs + trust + a handful of paying believers**, not MRR.

---

## 10. The build → analyze → improve loop

Every build phase ends with a stop-and-analyze checkpoint before the next. The questions at each checkpoint:

1. **Did it ship something a stranger can use in 5 minutes?** (usability gate)
2. **What did building it reveal we could add for more uniqueness/usefulness?** (the "stopped, analyzed, found more" step)
3. **Does the next thing have a money or traction reason?** If not, don't build it.
4. **What's the smallest next slice?** (no broad rewrites — our own doctrine)

This loop is the product's own philosophy applied to itself: plan before spend, prove with evidence, stop when there's no proof of progress.

**Phase checkpoints map to ROADMAP.md phases:**
- After Phase 0 → is the repo HN-credible? Analyze: what's the one feature that would make the demo unforgettable?
- After Phase 1 (estimation) → are estimates trusted? Analyze: which archetype is most valuable to nail next?
- After launch → what are people actually asking for? That demand decides Phase 2 vs 3 ordering, not this plan.

---

## 11. Decisions locked (Jun 1 2026)

- **Rename from generic "AI Agent Manager"** to a sharper, memorable name before the HN/PH launch. Naming pass happens in Phase 0, before README/repo/landing copy is finalized. (Locked Jun 1.)
- **Founding-license presale runs AT launch** — link live on launch day to capture impulse buyers at peak attention. Mitigate the "selling vaporware" risk with honest framing: presale funds the *cloud* layer; the local core is free MIT forever and already works.
- **Anthropic-native gateway is a Phase 0 must** (the ICP uses Claude, not just OpenAI).
