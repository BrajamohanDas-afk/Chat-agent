# Since

A chat agent that remembers what it told you — and checks whether it's still true.

Since stores conversations as dated claims with sources, not just transcripts. Ask "we shortlisted five CRMs on Monday — has anything changed?" and it recalls the five, searches current pricing, normalizes plans and billing units, and reports what moved, what stayed the same, and what it could not verify.

## Run it

```bash
npm install
cp .env.example .env
# fill OPENROUTER_API_KEY, TAVILY_API_KEY, GOOGLE_API_KEY
npm run dev
```

Open http://127.0.0.1:3000.

- `OPENROUTER_API_KEY` — analysis, extraction, generation, validation. Models are set in `src/config.ts` (haiku for analysis, sonnet for synthesis).
- `TAVILY_API_KEY` — the web search adapter. One tool, one key.
- `GOOGLE_API_KEY` — `gemini-embedding-2` for semantic recall. Text embeddings are free on the free tier.

Optional: `PORT` (default 3000), `USER_TIMEZONE` (default `Asia/Kolkata`).

## Demo

Click **Load demo history** and try the three prompts:

1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

The demo history is **synthetic and labeled**. Old prices are plausible, not quotes; the mechanism — recall, recheck, diff, cite — is real. The UI shows a demo badge and marks unverified baselines.

Without the demo, ask a question, then ask it again later; the second answer will recall the first and recheck the volatile parts.

## How it works

```
analyze → recall ∥ research → normalize → extract → compare → generate → validate → repair → persist
```

- A fast analyzer extracts intent, entities, dates, volatility and a search plan.
- Memory recall runs in parallel with web research. Dates are resolved to half-open UTC intervals.
- Evidence is normalized with a source rank (official > press > community); only the passage that supports a claim is stored.
- Prices are compared by amount, currency, period, mode, unit, plan, region and conditions — never as bare numbers.
- The generator cites evidence IDs (`[e3]`), never URLs; the UI maps IDs to real links.
- Validation runs while the answer streams. A failed sentence is replaced with "I couldn't verify that" rather than left as fact.
- Claims are append-only; a new observation supersedes the old one but never deletes it.

## Commands

```bash
npm run dev        # server + UI
npm test           # deterministic unit/integration tests
npm run typecheck  # tsc --noEmit
npm run turn -- "question" --scratch   # one turn without the UI
npm run seed       # seed the labeled demo history
npm run eval       # live scenario suite (needs all three keys)
npm run eval -- --offline   # recall, dates, honesty; no Tavily needed
```

## Limits

- Synthetic demo data is marked at row level and in the UI.
- Tavily cannot see logged-in or paywalled pricing pages; the agent abstains instead of guessing.
- Claim extraction is lossy. The diff shows plan, unit and period so a bad comparison is visible.
- Single user, localhost, no auth. Rechecks are on demand; there is no scheduler.
- Only retrieved passages go to model providers, never the full transcript.

`DESIGN.md` has the architecture, the rejected alternatives and the measured eval results.
