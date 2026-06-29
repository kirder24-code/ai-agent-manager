# AI Agent Manager — Roadmap

> Historical planning document. It may describe ideas, pricing, or product direction that are not part of Runcap's current public offer. See `docs/current-product-status.md` for the current product boundary.

_Last updated: 2026-06-01_

This is the build-and-launch plan for AI Agent Manager. It is split into shippable parts so each phase ends with something usable, not half-finished infrastructure.

---

## 1. Positioning (the decision that drives everything)

**One-line wedge:**

> Know what your agent will cost before you build it — and set a hard ceiling so it never surprises you.

**Pain hook:** Multi-agent runs burn ~15x more tokens than a single chat (Anthropic). Coding agents loop on the same error, rewrite plans, and hand you a confident summary while the task is not done. Every existing tool tells you what *happened*. None tells you what it will *cost* up front, stops it at a ceiling, or proves it actually finished.

**Do NOT compete on:** token dashboards, gateways/routing, budget caps alone. That market is saturated (Langfuse, Helicone, LangSmith, AgentOps, LiteLLM, Portkey, OpenRouter, Vercel/Cloudflare AI Gateway).

**Compete on the loop nobody closes:**

```
estimate before build → guard during run → rescue when stuck → verify it finished
```

**Honesty rule (non-negotiable, baked into the product):** Every cost/quality output carries a truth label — `observed`, `calculated`, `provider_usage`, `manual_calibration`, `unknown`. Estimation is sold as **range + hard cap**, never as a precise oracle. Point estimates get torn apart on Hacker News; ranged budgets with enforcement are honest and genuinely useful.

---

## 2. ICP & business model

- **Launch ICP:** indie / solo developers using Claude Code, Cursor, Codex who feel subscription/token burn. Reachable on r/ClaudeAI, r/LocalLLaMA, r/AI_Agents, Hacker News.
- **Phase-2 ICP:** teams & companies needing org-wide budget governance (SSO, audit, per-seat budgets). Bolt on later, like Langfuse did.
- **Model:** MIT open-source CLI/core (free, self-host) → paid hosted cloud (dashboard, team budgets, alerts) ~$20–50/seat → enterprise add-on (SSO, audit, governance).

---

## 3. What already exists (do not rebuild)

The prototype is real and clean (`src/mission-control.mjs`, zero-dependency Node):

- `aim plan` — heuristic mission planner: budget risk, model routing, proof, stop rule, copyable commands.
- `aim preflight` — broad-scope detection before a run.
- `aim run -- <cmd>` — wraps an agent/command; captures stdout/stderr, exit code, git diff, changed files, parsed errors, stuck score, rescue packet.
- `aim report` / `report.html` — human-readable rescue report.
- `aim export` — evidence JSON with truth labels.
- `aim dashboard` (:8791) — planner + active-work monitor.
- `aim gateway` (:8792) — OpenAI-compatible proxy, records token usage + estimated cost, `AIM_DAILY_BUDGET_USD` budget guard.
- `aim fuel set/calibrate` — manual subscription-percentage calibration.

**Known limits to address:** static prototype price table (OpenAI models only), estimation is keyword-heuristic not history-calibrated, gateway only proxies OpenAI-compatible (no Anthropic-native), beginner onboarding not built, no hosted/cloud layer.

---

## 4. Phases

Each phase ships independently. Order favors the launch wedge first.

### Phase 0 — Launch-ready hardening (this week)
Goal: the OSS repo is credible enough to post to HN / Reddit without getting torn apart.

- [ ] Verify `npm run setup/doctor/demo/acceptance` all pass clean end-to-end.
- [ ] Replace static OpenAI-only price table with a current, sourced multi-provider table (Anthropic Opus/Sonnet/Haiku, GPT, incl. cache-read ~10%, batch 50%). Label source + date.
- [ ] Add Anthropic-native gateway support (`/v1/messages`), not just OpenAI `/v1/chat/completions`. This is the actual ICP's API.
- [ ] README: lead with the wedge line + 15x hook + a 30-second asciinema/GIF of a real stuck run being rescued.
- [ ] One honest claim only: "ranged budget + hard cap," not "exact cost prediction."

**Done when:** a stranger can clone, run `npm run demo`, see a stuck agent get a rescue prompt, and understand the wedge in under 5 minutes.

### Phase 1 — Estimation that earns trust (range + cap)
Goal: turn the keyword heuristic into a defensible, calibrated estimate.

- [ ] Build a task-archetype table from real mission history (`.aim-control/missions`): software-feature, bug-fix, full-app, automation, research — each with observed token/cost distributions.
- [ ] `aim plan` outputs a **range** ("~$8–40, likely $15") + recommended **hard cap**, with confidence + truth label.
- [ ] As history grows, narrow the range per archetype (the "both modes" decision: range by default, tighten with data).
- [ ] Wire the cap into the gateway: a plan can set `AIM_DAILY_BUDGET_USD` automatically for its run.

**Done when:** estimates are backed by the user's own historical runs, displayed as honest ranges, and the cap actually stops a run.

### Phase 2 — Beginner mode (white space, soft moat)
Goal: serve the non-expert that every competitor ignores.

- [ ] `aim coach` / guided mode: plain-language explanations of what a plan means, why a run is stuck, what the rescue prompt does.
- [ ] One-command onboarding: `npx ai-agent-manager` → interactive setup, no flags to memorize.
- [ ] Dashboard "explain this" tooltips on every metric (spend risk, quality risk, fuel).

**Done when:** someone who has never used a CLI observability tool can plan and rescue a run without reading docs.

### Phase 3 — Hosted cloud (revenue)
Goal: paid layer on top of free OSS.

- [ ] Push mission/plan summaries to a hosted dashboard (opt-in, privacy-first — summaries not raw code/logs by default).
- [ ] Team accounts, shared budgets, alerts (Slack/email/Telegram) on cap breach or stuck run.
- [ ] Pricing page; free self-host stays fully featured (Langfuse model).

**Done when:** a team can see all members' agent spend and get alerted when a budget breaks.

### Phase 4 — Enterprise governance
Goal: second ICP.

- [ ] SSO, audit log, org-wide budget policy, role-based limits, cost attribution per team/project.

### Phase 5 — Learning layer
Goal: the product gets smarter per user.

- [ ] Remember which prompts/models/agents actually finished tasks for this user; recommend the cheapest tier that historically succeeded for each archetype.

---

## 5. Design direction (unique, not another dark observability dashboard)

The current dashboard is a competent dark-mode dev tool. To be *memorable* it should feel like a **flight controller / cockpit for AI work**, not a metrics grid. Distinctive direction to validate:

- **Mission-control metaphor, made literal.** Not "traces" — *missions* with a status light (moving / check this / needs rescue). One glance = go/no-go.
- **The "money meter" is the hero.** A single, honest gauge: estimated range, hard cap, spent-so-far — with the truth label visible, never hidden. Honesty *is* the brand.
- **Rescue as the emotional core.** When an agent is stuck, the screen should feel like a calm co-pilot handing you the exact next prompt — big, copyable, one action. This is the moment users will screenshot and share.
- **Light + dark, opinionated accent.** Pick one signature accent (current cyan→green gradient is fine) and a clean editorial type scale. Avoid the generic "AI purple gradient on black" everyone uses.

Design is a Phase 0/1 concern only insofar as the README GIF and the rescue screen look sharp — deep design system can wait until Phase 3 (cloud).

---

## 6. Go-to-market (solo founder, this week → first month)

Proven dev-tool sequence (how Langfuse/Helicone got traction):

1. **Repo first.** Working `npm run demo`, sharp README, honest claims. Preparation beats platform choice.
2. **Show HN** with the wedge line + the 15x hook + GIF. Be in the comments all day; HN rewards honest founders who don't over-claim.
3. **Targeted Reddit:** r/ClaudeAI, r/AI_Agents, r/LocalLLaMA — a genuine post about *the problem* (agents that look busy but don't finish), tool mentioned as the thing you built to fix it. Comment-first, not spammy.
4. **Product Hunt** once there are stars + a few real users for social proof.
5. Position as **"the open-source way to know and cap what your coding agent costs."**

---

## 7. Honest risks (read before over-investing)

- **Estimation is not a moat.** Trajectories are stochastic; nobody — including the labs — solved precise prediction. The defensible, shippable value is **enforcement (the hard cap) + verification (did it finish)**. Estimation is the headline that gets clicks; the cap is the product.
- **Vercel AI Gateway already owns coding-agent spend visibility** and updates it actively. They are the most likely fast-follower if rescue/estimation proves valuable. Speed and the honesty/verification angle are the defense.
- **Two ICPs (beginner vs enterprise) pull UX in opposite directions.** Launch one (indie devs), resist building both at once.
