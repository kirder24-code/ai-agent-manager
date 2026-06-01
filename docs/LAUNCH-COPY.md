# Launch copy — Runcap

Ready-to-paste posts for launch day. Post AFTER `npm publish` succeeds and `npm install -g runcap` works.

Links used:
- npm: https://www.npmjs.com/package/runcap
- repo: https://github.com/kirder24-code/ai-agent-manager
- site: https://launchsoloai.com/runcap

---

## Show HN

**Title:**
```
Show HN: Runcap – a hard spend ceiling for your coding agent (MIT, local)
```

**Body:**
```
I kept getting surprise bills from multi-agent coding runs. The agent loops on
the same error, rewrites its plan, hands me a confident "done" summary, and I
find out what it cost when the invoice (or the subscription limit) shows up.

Every tool I found measures the past. Observability dashboards (Langfuse,
Helicone) show the bill after you paid it. Gateways (LiteLLM, Portkey) route the
present. None of them stop the spend before it happens.

Runcap does one thing those don't: it estimates the cost of a run as a range
before you start, enforces a hard ceiling that physically kills the run when
spend crosses it, and hands you a copyable rescue prompt the moment the agent
gets stuck.

The honest part: it does NOT promise an exact cost oracle. Agent runs are
stochastic. So it gives you a range plus a hard cap — "this build is roughly
$3-7, cap it at $10" — and kills the run at the ceiling. The range is the
headline, the hard cap is the product. Every output carries a truth label
(observed / calculated / provider_usage / unknown); if it can't prove
something, it says so.

It's a single zero-dependency Node CLI. 100% local — your code and tokens never
touch a server. MIT.

  npm install -g runcap
  runcap preflight -- claude "build the full app with auth, payments, deploy"
  ANTHROPIC_API_KEY=... AIM_DAILY_BUDGET_USD=5 runcap gateway

Point any OpenAI- or Anthropic-compatible tool at the local gateway and the
next call returns 429 budget_guard instead of money leaving your account.

Repo: https://github.com/kirder24-code/ai-agent-manager
Would love feedback on the estimation model and the gateway approach.
```

---

## r/ChatGPTCoding

**Title:**
```
I built a CLI that puts a hard $ ceiling on a coding agent and kills the run when it hits the cap [MIT, local]
```

**Body:**
```
Multi-agent runs burn ~15x more tokens than a single chat. Mine kept looping on
the same error and handing me a "done" summary while the task wasn't actually
done — and I'd find the cost on the invoice later.

So I made Runcap. Three things:

1. Estimate — before a run, it gives a cost RANGE (not a fake exact number)
2. Cap — a hard daily ceiling; the run is physically killed at the limit
3. Rescue — when the agent gets stuck, it hands you a copyable prompt to unstick it

It's not another dashboard. Dashboards show the bill after you paid it. This
caps it before. Single Node CLI, zero deps, 100% local, nothing uploaded, MIT.

  npm install -g runcap
  ANTHROPIC_API_KEY=... AIM_DAILY_BUDGET_USD=5 runcap gateway

Works with Claude Code (/v1/messages) and any OpenAI-compatible agent. Free core
forever — only cloud sync/team features are paid.

Repo + 60s demo: https://github.com/kirder24-code/ai-agent-manager

Honest about limits: it can't predict exact tokens (nobody can), so it does
range + hard cap instead of pretending to be a cost oracle. Curious what you'd
want it to wrap.
```

---

## r/LocalLLaMA

**Title:**
```
Runcap: local, MIT CLI that enforces a hard spend cap on coding agents (kills the run at the ceiling)
```

**Body:**
```
For anyone running coding agents against paid APIs (or even just watching a
subscription limit): I built a small local tool that estimates a run's cost as a
range, enforces a hard daily ceiling, and kills the run the moment spend crosses
it. The next call returns 429 instead of charging you.

100% local — code and tokens never leave your machine. Zero dependencies, single
Node file, MIT. Works as an OpenAI- or Anthropic-compatible gateway, so you point
your agent at http://127.0.0.1:8792/v1 and it just works.

  npm install -g runcap
  runcap gateway --mock   # try with no API key

It deliberately does NOT claim to predict exact token counts — agent runs are
stochastic. It gives a range + a hard cap, and labels every output with how it
knows (observed / calculated / provider_usage / unknown).

https://github.com/kirder24-code/ai-agent-manager
```

---

## Posting order & timing

1. `npm publish` succeeds → verify `npm install -g runcap` on a clean shell.
2. Show HN first (Tue-Thu, ~8-10am ET is the usual sweet spot). Don't post the same hour as the Reddit ones.
3. r/ChatGPTCoding + r/LocalLLaMA same day, spaced a few hours apart.
4. Respond to every comment fast in the first 2 hours — that's what moves HN ranking.
5. Do NOT cross-link "go upvote my HN" (against HN rules).
