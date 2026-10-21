"""
Copyright 2024, Zep Software, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Modified by PGA (2026-10-21), from getzep/graphiti @ 8e320f8, graphiti_core/search/search_utils.py: `rrf` (reciprocal
rank fusion) is kept as it is. Graphiti's edge search fuses full-text (BM25), cosine similarity and breadth-first
search from given nodes; PGA has no embeddings, so here it fuses BM25 over the facts (words and Chinese character
pairs, pga.knowledge.uploads._grams), BM25 over the entity names (facts touching the matched entities) and a one-hop
BFS from those entities — then RRF, like graphiti's `rrf` reranker.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from typing import Any

from pga.knowledge.uploads import _grams


def rrf(results: list[list[str]], rank_const=1, min_score: float = 0) -> tuple[list[str], list[float]]:
    scores: dict[str, float] = defaultdict(float)
    for result in results:
        for i, uuid in enumerate(result):
            scores[uuid] += 1 / (i + rank_const)

    scored_uuids = [term for term in scores.items()]
    scored_uuids.sort(reverse=True, key=lambda term: term[1])

    sorted_uuids = [term[0] for term in scored_uuids]

    return [uuid for uuid in sorted_uuids if scores[uuid] >= min_score], [
        scores[uuid] for uuid in sorted_uuids if scores[uuid] >= min_score
    ]


def bm25(docs: dict[str, str], query: str, k: int = 50) -> list[str]:
    q = set(_grams(query))
    if not q or not docs:
        return []
    toks = {i: _grams(t) for i, t in docs.items()}
    n, avg = len(toks), sum(len(t) for t in toks.values()) / max(1, len(toks))
    df = {g: sum(1 for t in toks.values() if g in t) for g in q}
    out = []
    for i, t in toks.items():
        tf: dict[str, int] = {}
        for g in t:
            if g in q:
                tf[g] = tf.get(g, 0) + 1
        s = sum(math.log(1 + (n - df[g] + .5) / (df[g] + .5)) * (c * 2.2) / (c + 1.2 * (.25 + .75 * len(t) / avg)) for g, c in tf.items())
        if s > 0:
            out.append((s, i))
    out.sort(reverse=True)
    return [i for _, i in out[:k]]


def search_edges(edges: list[Any], entities: dict[str, Any], query: str, k: int = 12, current_only: bool = True,
                 at: datetime | None = None) -> list[Any]:
    """Facts that answer `query`: BM25 on the facts, on the entities' names (their facts), and one hop out from the
    entities found — fused by RRF. `current_only`: facts not yet invalidated (graphiti's default search filter)."""
    pool = [e for e in edges if not current_only or (e.expired_at is None and e.invalid_at is None)]
    by_id = {str(e.id): e for e in pool}
    fact_hits = bm25({i: e.fact for i, e in by_id.items()}, query)
    ent_hits = bm25({i: x.name for i, x in entities.items()}, query, k=10)
    touching = [i for i, e in by_id.items() if str(e.source_id) in ent_hits or str(e.target_id) in ent_hits]
    touching.sort(key=lambda i: -(by_id[i].valid_at or by_id[i].created_at).timestamp())
    near = set(ent_hits)
    for i in touching[:20]:                                  # one hop out (graphiti: BFS from the found nodes)
        near.update((str(by_id[i].source_id), str(by_id[i].target_id)))
    bfs = [i for i, e in by_id.items() if (str(e.source_id) in near or str(e.target_id) in near) and i not in touching]
    ranked, _ = rrf([fact_hits, touching, bfs[:30]])
    return [by_id[i] for i in ranked[:k]]
