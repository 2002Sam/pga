# Third-party notices

## Graphiti (getzep/graphiti)

Copyright 2024, Zep Software, Inc. Licensed under the Apache License, Version 2.0 — the full text is in
`third_party/graphiti/LICENSE`. Source: https://github.com/getzep/graphiti (commit 8e320f8).

PGA's fact graph (`src/pga/kg/`) contains code and prompts copied from Graphiti and modified. Each of these files
keeps Graphiti's copyright notice and says what was changed:

| PGA file | From Graphiti |
|---|---|
| `src/pga/kg/prompts.py` | `graphiti_core/prompts/extract_nodes_and_edges.py`, `dedupe_nodes.py`, `dedupe_edges.py`, `extract_edges.py` |
| `src/pga/kg/dedup.py` | `graphiti_core/utils/maintenance/dedup_helpers.py` |
| `src/pga/kg/temporal.py` | `graphiti_core/utils/maintenance/temporal_edge_utils.py`, `edge_operations.py` (temporal invalidation), `utils/datetime_utils.py` |
| `src/pga/kg/search.py` | `graphiti_core/search/search_utils.py` (`rrf`) |

`src/pga/kg/service.py` follows Graphiti's `add_episode` pipeline but is PGA's own code (Postgres instead of a graph
database, PGA's model router, no embeddings).

## Mixture-of-Agents (togethercomputer/MoA) and FastChat (lm-sys/FastChat)

Both licensed under the Apache License, Version 2.0 — full texts in `third_party/moa/LICENSE` and
`third_party/fastchat/LICENSE`. `src/pga/agents/council.py` contains MoA's aggregator prompt (from `moa.py` / `utils.py`)
and FastChat's `compute_elo` (from `fastchat/serve/monitor/elo_analysis.py`), each marked and with what PGA changed.

## Designs followed without copying code

- LLM Council (karpathy/llm-council, no licence published) — the blind review and chairman flow in `src/pga/agents/council.py` is reimplemented.

- RAPTOR (MIT), GraphRAG (MIT), MemTree — the world tree (`src/pga/worldtree.py`); see `notes/world-tree.md`.
- Open WebUI — interaction designs reimplemented in the web app; no code copied (see `notes/open-webui-study.md`).
