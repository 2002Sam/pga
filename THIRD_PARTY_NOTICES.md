# Third-party notices

PGA's original code is licensed under Apache-2.0; see `LICENSE`.
The components below retain their respective licenses.

## Monaco Editor (microsoft/monaco-editor)

The local editor files in `src/pga/web/vendor/monaco/0.52.2/` are distributed under MIT.
The upstream `LICENSE`, `ThirdPartyNotices.txt` and `SOURCE.txt` are included in that directory.
These files are served locally for the embedded code editor.

## UI dependencies

The desktop interface uses Svelte (MIT), Vite (MIT), marked (MIT) and DOMPurify (Apache-2.0 OR MPL-2.0)
via npm; exact versions are recorded in `desktop/ui/package-lock.json`.
The web interface also loads libraries from their upstream CDN distributions, including marked (MIT),
DOMPurify (Apache-2.0 OR MPL-2.0), KaTeX (MIT), highlight.js (BSD-3-Clause), Mermaid (MIT),
three.js (MIT), d3 (ISC) and Pyodide (MPL-2.0). Their upstream distributions retain their notices.
The Inter and Cormorant Garamond web fonts use the SIL Open Font License; DM Sans uses the same license.

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

- RAPTOR (MIT), GraphRAG (MIT), MemTree — the world tree (`src/pga/worldtree.py`).
- Open WebUI — interaction designs reimplemented in the web app; no code copied.
- DeepSeek's question index (the strip of marks beside a conversation) — the question strip in `src/pga/web/app-worldbranch.js`, reimplemented.
- VCPToolBox (lioensky/VCPToolBox, CC BY-NC-SA 4.0) — four ideas reimplemented from its published descriptions, no code or prompts copied:
  - the letter a perpetual cycle writes to its next one (`src/pga/perpetual.py`);
  - tag co-occurrence association recall (`src/pga/associate.py`);
  - folding older turns by topic (`src/pga/fold.py`);
  - dreaming with approval (`src/pga/dream.py`).
