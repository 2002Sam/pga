# Perpetual Generalist Agent — Phase 1 (Core)

Implementation of **Phase 1** of `Perpetual_Generalist_Agent_Design.md` (spec v0.3):
schemas + database, Translation Gateway, responsibility state machine, tension
accumulator, resource allocator, 70/30 premium-quota accounting and the run audit log.

> Responsibility is perpetual; computation is not. Always attentive, not always working.

Stack: Python 3.11+, FastAPI, SQLAlchemy 2, PostgreSQL 16 (source of truth), Alembic,
Anthropic SDK. Everything runs offline with `PGA_LLM_PROVIDER=fake`.

## Quick start

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U postgres pga_test   # for the test suite
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env            # set ANTHROPIC_API_KEY + PGA_LLM_PROVIDER=anthropic for real models
alembic upgrade head
pytest                          # 79 tests against real Postgres (+2 live API tests, skipped without a key)
python -m pga                   # API on http://127.0.0.1:8000 — interactive docs at /docs
```

A first conversation:

```bash
U=$(curl -s -X POST localhost:8000/v1/users -H 'content-type: application/json' -d '{"locale":"zh-CN"}' | jq -r .id)
curl -s -X POST localhost:8000/v1/users/$U/responsibilities -H 'content-type: application/json' \
  -d '{"title":"跟踪手-物体接触估计的新论文","keywords":["hand contact","MANO"]}'
curl -s -X POST localhost:8000/v1/chat -H 'content-type: application/json' \
  -d "{\"user_id\":\"$U\",\"text\":\"最近有什么值得我看的？\"}" | jq .reply.display_text
```

## What is built, mapped to the spec

| Spec | Where | What it does |
|---|---|---|
| §4 canonical types | `src/pga/db/models.py`, `migrations/` | All §4 types plus the tables the mechanisms need: event clusters, tension ledger, usage, quota state, allocations, runs, audit log, messages, glossary, translation cache. Enums are constrained `VARCHAR`s; constraint names follow a naming convention. |
| §10 Translation Gateway | `src/pga/translation/` | Middleware, not prompts. Language detection, protected spans, Tier-1 LLM translator, glossary + user corrections, translation cache, explicit output-language override, fail-safe fallback. |
| §5 Responsibility Tension | `src/pga/tension/` | Event clustering, ΔT scoring, diminishing returns, decay with stagnation, resolution/rejection/expiry/absorption, hysteresis wake/sleep, "why did it wake?" ledger. |
| §4/§9 responsibilities | `src/pga/responsibility/` | State machine with guarded ops, user ownership, bounded and expiring candidates with promotion criteria. |
| §1.1, inv. 5 Situation Model | `src/pga/situation.py` | Typed facts; explicit preferences beat inferred ones; external content may only add facts/observations. |
| §6–8 allocator & quota | `src/pga/allocator.py`, `src/pga/budget.py` | Value-vs-cost scoring, mandatory justification, category budgets (bounded exploration, protected user reserve), premium windows with 70/30 policy, cheap-mode fallback. |
| §20–21 audit & guards | `src/pga/runs.py`, `src/pga/audit.py` | Every run records why_now … stop_reason; `RunGuard` enforces timeout, tool and cost budgets. |
| §7 model tiers | `src/pga/llm/router.py` | Tier → model (from config), Anthropic and fake providers, usage reported to the ledger. |
| §19 permissions | `src/pga/permissions.py` | Levels with auto/approval/deny; only the user changes them. |
| API | `src/pga/api/app.py` | Users, chat, situation, responsibilities and ops, events, tick, allocations, budget, quota, runs, glossary, permissions. |

The spec's `/services` and `/packages` layout (§23) maps onto modules of one Python
package for now — `translation` = services/translation, `llm` = packages/llm-router,
`permissions` = packages/permissions, `audit` + `runs` = packages/observability, and so on.
They can be split into separate deployables when Phase 2 adds workers.

## How the core mechanisms behave

**Translation (§10).** Code, URLs, paths, commands, JSON/YAML, math, IDs, citations,
API names and do-not-translate product names are detected first. Short spans are shown
to the translator as `<keep id="3">…</keep>` (so it keeps sentence context), long ones as
opaque `<ph id="4"/>`. After translation every span is restored **from the original bytes
by id**, so a translator that edits a span still cannot change it; missing or duplicated
markup triggers a retry, then a fail-safe (inbound: keep the user's original text;
outbound: show the English). Model history is rebuilt from `canonical_en` only, which is
what prevents zh→en→zh drift loops. "用英文回答" / "answer in English" bypasses Chinese
rendering for that reply; `preferences.output_language` sets a standing choice
(`"en"`, `"zh-CN"` or `"mirror_input"`).

**Tension (§5).**

```
ΔT = core_gain · relevance · novelty · uncertainty · decision_impact
   + w_deadline·deadline + w_dependency·dependency + w_interest·user_interest
   + w_opportunity·opportunity·relevance
   (all × duplicate_decay^n for the n-th source of the same event, × absorbed_factor if already absorbed)
   + w_contradiction·contradiction·relevance   (diminishes only across repeated contradictions)
T ← clamp(decay(T) + ΔT, 0, 1)
```

Five syndicated copies of one story add ≈1.4× one copy, not 5×; a contradiction adds
roughly 3× a plain relevant item. Decay is exponential (72 h half-life) and speeds up
(24 h) after a week without meaningful change. Hysteresis: MONITORING/SLEEPING → ACTIVE at
`wake_threshold` (0.75); ACTIVE → MONITORING at `sleep_threshold` (0.35); MONITORING →
SLEEPING when near zero and stagnant; scheduled reviews bring SLEEPING back to MONITORING.

**Allocation (§6–8).** Checks run in order: responsibility state (sleeping/paused/waiting
work doesn't compute; MONITORING allows only cheap kinds) → five-question justification for
tier ≥ 2 → candidate budget → value-vs-cost floor (proactive only) → category budget →
premium quota. A failing check tries the next cheaper tier down to the task's `min_tier`
before deferring. Proactive premium work stops when it hits 70% of the window *or* would
eat into the 30% reserve; user-facing work may use the reserve and, if the window is empty,
falls back to tier 2 instead of refusing.

**Ownership (invariants 1, 11).** Only the user creates, completes, cancels, pauses or
re-goals a responsibility. The agent may open CANDIDATE children with a `max_units`
budget and an expiry; a candidate never wakes or sleeps into perpetuity — only `promote`
(user approval + criteria) makes it perpetual. External content (`/events`) can raise
tension and add observations, nothing else.

All numbers above live in `src/pga/policy.yaml`; point `PGA_POLICY_FILE` at your own YAML to override any subset.

## Acceptance tests (§26) covered

Translation: Chinese→English canonical · code/URL/path/math byte-identical (against a
translator that rewrites every other character) · English→Chinese display · explicit
English bypass · no loop across turns. Responsibility: duplicates not linear ·
contradiction strong · resolved uncertainty lowers tension · sleeping wakes on relevant
event · candidate can't become perpetual without promotion. Budget: proactive stops near
target · user can use the reserve · background falls back to cheap mode. Plus the
migration round-trip, API end-to-end and the invariants above. Self-improvement and
artifact tests belong to Phases 3–4.

## Limitations to know about

- **No authentication yet.** Run it single-tenant on a trusted network.
- **Clustering is lexical** (MinHash over word shingles of the English text). Reposts and
  syndicated copies merge; independently written reports of the same event do not. Pass
  `event_key` from an upstream deduper, or swap in embeddings in Phase 3.
- **Rule scorer is crude.** Use `Runtime(..., scorer="llm")` (Tier-1 classifier) or send
  explicit `signals` with each event for real relevance/contradiction judgments.
- **The Anthropic provider path is written but was not exercised against the live API** in
  the build environment; the test suite uses the fake provider and a dictionary translator.

## Next: Phase 2 (perpetual loop)

Durable workflows (Temporal; Celery + Redis fallback) that call `TensionService.tick` and
run approved allocations; event ingestion sources (feeds, search monitors); the free
exploration runner using the 70/20/10 mix already enforced by the allocator; and user
notifications driven by wake events and `WAIT_USER`.
