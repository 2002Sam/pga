"""The fact graph (after graphiti): facts with when they held; a newer contradicting fact invalidates the older one."""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from pga.db.models import KgEdge, KgEntity
from pga.kg import dedup, temporal
from pga.kg.search import rrf
from pga.kg.service import FactGraph

T1 = datetime(2026, 9, 1, tzinfo=timezone.utc)
T2 = datetime(2026, 10, 1, tzinfo=timezone.utc)


def test_graphiti_temporal_rules_keep_plans_valid_from_when_they_were_said():
    e = SimpleNamespace(fact="Junhan 计划在 2026-11-15 之前提交 3DV 论文", valid_at=None, invalid_at=None)
    temporal.apply_extracted_timestamps(e, "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z", T1)
    assert e.valid_at == T1 and e.invalid_at is None                  # a deadline is not an end
    old = SimpleNamespace(fact="a", valid_at=T1, invalid_at=None, expired_at=None)
    new = SimpleNamespace(fact="b", valid_at=T2, invalid_at=None, expired_at=None)
    assert temporal.apply_temporal_invalidation(new, [old]) == [old] and old.invalid_at == T2 and old.expired_at is not None


def test_entity_dedup_matches_exact_and_fuzzy_names_including_chinese():
    known = [SimpleNamespace(id="1", name="DenseHap 手部接触估计"), SimpleNamespace(id="2", name="PyTorch")]
    st = dedup.DedupResolutionState(resolved_nodes=[None] * 3)
    dedup._resolve_with_similarity(["pytorch", "DenseHap 手部接触估计 ", "Jax"], dedup._build_candidate_indexes(known), st)
    assert st.resolved_nodes[0].id == "2" and st.resolved_nodes[1].id == "1" and st.unresolved_indices == [2]
    assert rrf([["a", "b"], ["b", "c"]])[0][0] == "b"


class Scripted:
    def __init__(self, extractions):
        self.extractions, self.calls = list(extractions), []

    def __call__(self, user, system, prompt, why, max_tokens=3000, now=None):
        self.calls.append(why)
        if "long-term memory" in system:
            return self.extractions.pop(0)
        if "fact deduplication" in system:
            if "<NEW FACT>\nDenseHap 不再用" in prompt:
                return {"items": [{"n": 0, "duplicate_facts": [], "contradicted_facts": [0]}]}
            if prompt.count("DenseHap 的损失包含接触项") >= 2:
                return {"items": [{"n": 0, "duplicate_facts": [0], "contradicted_facts": []}]}
            return {"items": [{"n": 0, "duplicate_facts": [], "contradicted_facts": []}]}
        return {}


def ex(fact, rel, a="DenseHap", b="PyTorch"):
    return {"extracted_entities": [{"name": a, "entity_type_id": 2}, {"name": b, "entity_type_id": 5}],
            "edges": [{"source_entity_name": a, "target_entity_name": b, "relation_type": rel, "fact": fact, "episode_indices": [0]}]}


def test_a_newer_fact_invalidates_the_older_one_and_a_repeated_fact_is_not_doubled(rt, user, monkeypatch):
    fg = FactGraph(rt)
    m = Scripted([ex("DenseHap 用 PyTorch 训练", "TRAINED_WITH"),
                  ex("DenseHap 不再用 PyTorch，改用 JAX 训练", "TRAINED_WITH", b="JAX") | {"extracted_entities": [{"name": "DenseHap", "entity_type_id": 2}, {"name": "JAX", "entity_type_id": 5}, {"name": "PyTorch", "entity_type_id": 5}]},
                  ex("DenseHap 的损失包含接触项", "HAS_LOSS", b="接触损失"), ex("DenseHap 的损失包含接触项", "HAS_LOSS", b="接触损失")])
    monkeypatch.setattr(fg, "_ask", m)
    fg.add_episode(user, "chat:a", "训练", "User: DenseHap 用 PyTorch 训练", T1)
    old = rt.session.query(KgEdge).one()
    assert old.valid_at == T1 and old.invalid_at is None
    r = fg.add_episode(user, "chat:b", "换框架", "User: DenseHap 不再用 PyTorch 了，改用 JAX", T2)
    assert r["invalidated"] == 1
    rt.session.refresh(old)
    new = rt.session.query(KgEdge).filter(KgEdge.fact.like("%JAX%")).one()
    assert old.invalid_at == T2 and old.expired_at is not None and old.invalidated_by == new.id    # kept, marked, pointing at its successor
    assert rt.session.query(KgEntity).filter(KgEntity.name == "DenseHap").count() == 1              # resolved, not duplicated
    fg.add_episode(user, "chat:c", "损失", "User: DenseHap 的损失包含接触项", T1)
    fg.add_episode(user, "chat:d", "损失", "User: DenseHap 的损失包含接触项", T2)
    same = rt.session.query(KgEdge).filter(KgEdge.relation == "HAS_LOSS").all()
    assert len(same) == 1 and set(same[0].refs) == {"chat:c", "chat:d"}
    cur, past = fg.topic_facts(user, ["chat:a", "chat:b"])
    assert [e.fact for e in cur] == ["DenseHap 不再用 PyTorch，改用 JAX 训练"] and [e.id for e in past] == [old.id]
    assert "no longer holds" in fg.describe(old) and "replaced by" in fg.describe(old)
    assert fg.search(user, "JAX 训练")[0].id == new.id
