"""提示词润色 (pga.polish): a draft rewritten a few ways with the personal model."""
from __future__ import annotations

import pytest

from pga.knowledge.datasets import Datasets, edit_facts
from pga.polish import polish


def test_versions_come_back_written_with_what_pga_knows_about_you(rt, user):
    b = Datasets(rt).ensure(user)["user"]
    edit_facts(b, "background", add="在做机器人触觉方向的博士研究")
    seen = {}

    def ask(rt_, user_, system, prompt, now):
        seen.update(system=system, prompt=prompt)
        return {"versions": [{"title": "清晰精炼", "prompt": "帮我总结这篇论文的方法", "why": "去掉了口语"},
                             {"title": "补全背景", "prompt": "我在做触觉方向的博士研究，帮我总结…", "why": "加入你的研究方向"},
                             {"title": "空的", "prompt": " "}, "坏的"]}
    vs = polish(rt, user, "帮我看看这篇论文讲了啥", n=3, ask=ask)
    assert [v["title"] for v in vs] == ["清晰精炼", "补全背景"]
    assert "机器人触觉" in seen["prompt"] and "帮我看看这篇论文讲了啥" in seen["prompt"] and "3 polished versions" in seen["system"]
    with pytest.raises(ValueError):
        polish(rt, user, "   ", ask=ask)
