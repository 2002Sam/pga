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


def test_manual_category_survives_automatic_reclassification(user):
    projectsort.assign(user, 'chat:a', '论文思考')
    projectsort.assign(user, 'imp:example', 'PGA')
    st = projectsort.state(user)
    assert st['of']['c:example'] == 'PGA'
    assert 'imp:example' not in st['of']
    projectsort.sort(None, user, items=[], now=NOW, ask=lambda *a: {}, again=True)
    assert projectsort.state(user)['of']['chat:a'] == '论文思考'
    assert projectsort.state(user)['of']['c:example'] == 'PGA'


def test_conversation_category_api_creates_distinct_empty_chats_and_moves_them(session_factory, policy, provider, backend, user):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.runtime import Runtime
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    url = f'/v1/users/{user.id}/conversation-projects'
    with TestClient(app) as c:
        assert '论文思考' in c.get(url).json()['names']
        a = c.post(url, json={'project':'PGA','create':True}).json()
        b = c.post(url, json={'project':'论文思考','create':True}).json()
        assert a['key'] != b['key']
        catalog = c.get(url).json()
        assert catalog['of'][a['key']] == 'PGA' and catalog['of'][b['key']] == '论文思考'
        assert a['key'] in catalog['drafts']
        chat = c.get(f"/v1/users/{user.id}/chats/{a['key']}").json()
        assert chat['turns'] == [] and not chat['branch']
        assert c.post(url,json={'project':'论文思考','key':a['key']}).status_code == 200
        assert c.get(url).json()['of'][a['key']] == '论文思考'
        assert c.post(url,json={'project':'不存在','key':a['key']}).status_code == 422
        assert c.post(url,json={'project':'PGA','key':''}).status_code == 422
        assert c.get(url).json()['of'][a['key']] == '论文思考'
