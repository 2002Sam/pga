"""项目: conversations filed under a few real projects when imported (pga.projectsort)."""
from datetime import datetime, timezone
from types import SimpleNamespace

from pga import projectsort
from pga.segments import _unwrap, _yours

NOW = datetime(2026, 10, 29, tzinfo=timezone.utc)


def item(key, title, folder=""):
    return SimpleNamespace(key=key, title=title, project=folder, excerpt=title, times=[NOW])


def test_a_folder_naming_a_project_files_it_and_a_meaningless_one_says_nothing():
    ps = projectsort.DEFAULT
    assert projectsort.by_rule("PGA", ps) == "PGA"
    assert projectsort.by_rule("DenseHap论文材料", ps) == "论文思考"
    assert projectsort.by_rule("简历投递", ps) == "简历投递"
    for f in ("New project", "Desktop", "2026-08-19-10-06", "x", "scratch-12", ""):
        assert projectsort.by_rule(f, ps) is None


def test_the_rest_go_to_the_model_which_may_open_a_few_new_projects_only():
    user = SimpleNamespace(preferences={})
    items = [item("a", "help", "PGA"), item("b", "Loss function", "New project"), item("c", "你好", "x")]
    items += [item(f"n{i}", f"topic {i}", "Desktop") for i in range(8)]
    seen = {}

    def ask(rt, u, system, prompt, now):
        seen["system"] = system
        out = {"i0": "论文思考", "i1": "日常对话"}
        out.update({f"i{i + 2}": f"新项目{i}" for i in range(8)})   # more new projects than allowed
        return out

    r = projectsort.sort(None, user, items=items, now=NOW, ask=ask)
    st = projectsort.state(user)
    assert r["ruled"] == 1 and st["of"]["a"] == "PGA"
    assert st["of"]["b"] == "论文思考" and st["of"]["c"] == "日常对话"
    new = [p for p in st["list"] if p not in projectsort.DEFAULT]
    assert len(new) == projectsort.MAX_NEW
    assert sum(1 for k, p in st["of"].items() if k.startswith("n") and p == projectsort.EVERYDAY) == 8 - projectsort.MAX_NEW
    assert "PGA: the AI agent app" in seen["system"]                       # each project says what it is about
    assert projectsort.project_of(st, "zzz", "New project") == projectsort.EVERYDAY
    r = projectsort.sort(None, user, items=items, now=NOW, ask=lambda *a: {})   # filed ones are not asked again
    assert r["sorted"] == 0 and r["left"] == 0
    projectsort.sort(None, user, items=items, now=NOW, ask=lambda *a: {}, again=True)
    assert projectsort.state(user)["list"] == projectsort.DEFAULT


def test_a_message_relayed_in_an_envelope_counts_as_yours():
    t = ('@"/u/img.png" <wake reason="mention"><project><thread><message trigger="true" from="human">去掉 &lt;b&gt; 这个</message>'
         '</thread></project></wake>')
    assert _yours(t) and _unwrap(t) == '@"/u/img.png" 去掉 <b> 这个'
    assert not _yours("<command-name>/clear</command-name>")
