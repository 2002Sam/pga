import json

from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.db.models import AgentRun, User
from pga.model_usage import add_model_usage, model_parts
from pga.runtime import Runtime


def test_model_breakdown_counts_cache_once_and_ignores_aggregate():
    data = {"usage": {"input_tokens": 9999}, "model_usage": {
        "sonnet": {"inputTokens": 10, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 20, "outputTokens": 5},
        "haiku": {"inputTokens": 2, "outputTokens": 3}}}
    parts = dict(model_parts(data))
    assert parts["sonnet"]["input"] == 130
    assert parts["sonnet"]["cached"] == 100
    assert parts["haiku"]["input"] == 2


def test_models_stay_separate_and_codex_uses_turn_not_thread_total():
    totals = {}
    for model in ("gpt-a", "gpt-b"):
        add_model_usage(totals, "codex", {"model": model, "usage": {
            "last": {"inputTokens": 20, "cachedInputTokens": 10, "outputTokens": 2},
            "total": {"inputTokens": 99999}}}, "yours")
    assert len(totals) == 2
    assert totals[("codex", "gpt-a")]["yours"]["input"] == 20
    assert next(model_parts({"usage": {"input_tokens": 1}}))[0] == "unknown"


def test_usage_api_models_and_user_isolation(session_factory, policy, provider, backend, user, session):
    other = User(permission_policy_id=user.permission_policy_id)
    session.add(other)
    session.flush()
    def run(uid, adapter, data, parent=None, workflow="ask"):
        r = AgentRun(user_id=uid, workflow=workflow, pattern="single", step="run", agent="codex", adapter=adapter,
                     status="SUCCEEDED", prompt="", output=json.dumps({}), data=data, parent_id=parent)
        session.add(r)
        session.flush()
        return r
    parent = run(user.id, "pool", {"model": "historical-model", "usage": {"input_tokens": 10000}})
    run(user.id, "codex_local", {"usage": {"input_tokens": 40, "output_tokens": 5}}, parent.id)
    run(user.id, "codex_local", {"model": "actual-model", "usage": {"input_tokens": 20}}, parent.id)
    other_parent = run(other.id, "pool", {})
    run(other.id, "codex_local", {"model": "private-model", "usage": {"input_tokens": 777}}, other_parent.id, "task:synthesis")
    session.commit()
    app = create_app(session_factory=session_factory,
        runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as client:
        response = client.get(f"/v1/users/{user.id}/usage/split?days=7")
        assert response.status_code == 200
        data = response.json()
        models = {m["model"]: m for m in data["models"]}
        assert set(models) == {"historical-model", "actual-model"}
        assert models["historical-model"]["yours"]["input"] == 40
        assert models["actual-model"]["yours"]["input"] == 20
        assert data["agents"]["codex"]["yours"]["input"] == 60
        assert data["agents"]["codex"]["background"]["input"] == 0
