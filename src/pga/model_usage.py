"""Model totals from persisted agent steps (never count the pool parent twice)."""
from pga.tree import usage_of


def model_parts(data, fallback=None):
    data = data or {}
    breakdown = data.get("model_usage")
    if isinstance(breakdown, dict) and breakdown:
        for model, raw in breakdown.items():
            if not isinstance(raw, dict):
                continue
            # Claude's per-model input excludes cache reads and writes.
            u = usage_of({"usage": {
                "input_tokens": raw.get("inputTokens", 0),
                "cache_read_input_tokens": raw.get("cacheReadInputTokens", 0),
                "cache_creation_input_tokens": raw.get("cacheCreationInputTokens", 0),
                "output_tokens": raw.get("outputTokens", 0),
            }})
            yield str(model), u or {"input": 0, "cached": 0, "output": raw.get("outputTokens", 0) or 0}
        return
    u = usage_of(data)
    if u:
        yield str(data.get("model") or fallback or "unknown"), u


def add_model_usage(totals, agent, data, side, fallback=None):
    for model, usage in model_parts(data, fallback):
        group = totals.setdefault((agent, model), {"agent": agent, "model": model,
            "yours": {"calls": 0, "input": 0, "output": 0, "cached": 0},
            "background": {"calls": 0, "input": 0, "output": 0, "cached": 0}})
        group[side]["calls"] += 1
        for field in ("input", "output", "cached"):
            group[side][field] += usage.get(field, 0)
