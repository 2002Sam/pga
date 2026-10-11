"""Turn PGA's canonical state into an Obsidian vault.

Every responsibility, belief, piece of evidence, source, decision, linked AI
agent, project and the cross-agent digest becomes one Markdown note with YAML
frontmatter ("properties"), [[wikilinks]] between notes, #tags and callouts —
the format Obsidian reads natively, so the export opens as a working vault with
graph view, backlinks and tag search.

The same notes feed the 3D vault page. Postgres stays the source of truth; the
notes are a rendering of it, rebuilt on demand.

`read_obsidian_vault` goes the other way (read-only): it parses a vault the
user already keeps so their own notes can sit in the same graph. Nothing from
it is sent to a model.
"""

from __future__ import annotations

import os
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from pga.db.models import (Belief, BeliefEvidence, Decision, Evidence, HubDigest, LinkedAgent, Responsibility, Source,
                           TensionChange)
from pga.db.types import BeliefType, ResponsibilityStatus

HOME = "PGA Home"
DIGEST = "AI Digest"
FOLDERS = {"home": "", "digest": "", "responsibility": "Responsibilities", "belief": "Beliefs", "evidence": "Evidence",
           "source": "Sources", "decision": "Decisions", "agent": "Agents", "project": "Projects"}
STATUS_ZH = {"ACTIVE": "活跃", "MONITORING": "监测中", "SLEEPING": "休眠", "WAIT_USER": "等你回复",
             "WAIT_EXTERNAL": "等待外部", "COMPLETED": "已完成", "ARCHIVED": "已归档", "CANDIDATE": "候选"}
BELIEF_CALLOUT = {BeliefType.CONCLUSION: ("success", "结论"), BeliefType.HYPOTHESIS: ("question", "假设"),
                  BeliefType.UNCERTAINTY: ("warning", "未决问题")}

_BAD_TITLE = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]+')
_WIKILINK = re.compile(r"!?\[\[([^\]\|#\^]*)(?:[#\^][^\]\|]*)?(?:\|[^\]]*)?\]\]")
_INLINE_TAG = re.compile(r"(?<![\w/&#])#([\w\-/]*[^\W\d_][\w\-/]*)", re.UNICODE)
_FENCE = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def note_title(text: str, limit: int = 72) -> str:
    """A string that is safe as an Obsidian file name and wikilink target."""
    t = re.sub(r"\s+", " ", _BAD_TITLE.sub(" ", text or "")).strip(" .")
    if len(t) > limit:
        cut = t[:limit].rsplit(" ", 1)[0] if " " in t[:limit] else t[:limit]
        t = cut.rstrip(" ,;.-") + "…"
    return t or "Untitled"


def tag_slug(text: str) -> str:
    s = re.sub(r"[^\w\-/]+", "-", (text or "").strip().lower(), flags=re.UNICODE).strip("-/")
    if not s or s.replace("-", "").replace("/", "").isdigit():
        s = f"t-{s}" if s else ""
    return s[:60]


def _iso(dt: datetime | None) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M") if dt else None


def _bar(x: float, n: int = 10) -> str:
    k = max(0, min(n, round(x * n)))
    return "▰" * k + "▱" * (n - k)


def _quote(text: str) -> str:
    return "\n".join("> " + line if line else ">" for line in (text or "").strip().splitlines())


@dataclass
class Note:
    id: str
    kind: str
    title: str
    folder: str = ""
    props: dict[str, Any] = field(default_factory=dict)
    body: str = ""
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)       # ids of notes this one links to
    link_targets: list[str] = field(default_factory=list)  # unresolved [[targets]] (external notes)
    updated: datetime | None = None
    external: bool = False

    @property
    def path(self) -> str:
        return f"{self.folder}/{self.title}.md" if self.folder else f"{self.title}.md"

    def markdown(self) -> str:
        props = {k: v for k, v in self.props.items() if v not in (None, "", [])}
        if self.tags:
            props["tags"] = sorted(set(self.tags))
        head = yaml.safe_dump(props, allow_unicode=True, sort_keys=False, width=1000).strip() if props else ""
        return (f"---\n{head}\n---\n\n" if head else "") + self.body.strip() + "\n"


@dataclass
class Vault:
    notes: list[Note]
    unresolved: int = 0

    def backlinks(self) -> dict[str, list[str]]:
        back: dict[str, list[str]] = defaultdict(list)
        for n in self.notes:
            for target in dict.fromkeys(n.links):
                if target != n.id:
                    back[target].append(n.id)
        return back

    def as_json(self, body_limit: int = 12_000) -> dict:
        back = self.backlinks()
        tags = Counter(t for n in self.notes for t in set(n.tags))
        folders = Counter(n.folder or "/" for n in self.notes)
        notes = [{"id": n.id, "kind": n.kind, "title": n.title, "folder": n.folder, "path": n.path,
                  "props": {k: v for k, v in n.props.items() if v not in (None, "", [])}, "tags": sorted(set(n.tags)),
                  "links": list(dict.fromkeys(x for x in n.links if x != n.id)), "backlinks": back.get(n.id, []),
                  "body": n.body if len(n.body) <= body_limit else n.body[:body_limit] + "\n\n…",
                  "updated": n.updated.isoformat() if n.updated else None, "external": n.external}
                 for n in self.notes]
        return {"notes": notes, "tags": dict(tags.most_common()), "folders": dict(folders),
                "stats": {"notes": len(notes), "links": sum(len(n["links"]) for n in notes),
                          "external": sum(n.external for n in self.notes), "unresolved": self.unresolved}}


class _Builder:
    def __init__(self, session: Session, user_id: uuid.UUID, evidence_per_agent: int):
        self.s = session
        self.user_id = user_id
        self.evidence_per_agent = evidence_per_agent
        self.notes: dict[str, Note] = {}
        self._taken: set[str] = set()

    # -------------------------------------------------------------- titles & links

    def reserve(self, nid: str, kind: str, base: str, **kw: Any) -> Note:
        if nid in self.notes:
            return self.notes[nid]
        title = note_title(base)
        stem, i = title, 2
        while title.lower() in self._taken:
            title = f"{stem} ({i})"
            i += 1
        self._taken.add(title.lower())
        n = Note(id=nid, kind=kind, title=title, folder=FOLDERS[kind], **kw)
        self.notes[nid] = n
        return n

    def link(self, src: Note, target_id: str, alias: str | None = None) -> str:
        t = self.notes.get(target_id)
        if t is None:
            return alias or ""
        src.links.append(target_id)
        a = alias and note_title(alias, 120)
        return f"[[{t.title}|{a}]]" if a and a != t.title else f"[[{t.title}]]"

    # -------------------------------------------------------------- build

    def build(self) -> list[Note]:
        resps = [r for r in self.s.scalars(select(Responsibility).where(Responsibility.user_id == self.user_id)
                                           .order_by(Responsibility.tension.desc()))
                 if r.status != ResponsibilityStatus.ARCHIVED]
        rids = {r.id for r in resps}
        beliefs: dict[uuid.UUID, list[Belief]] = defaultdict(list)
        cites: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = defaultdict(list)
        evidence: dict[uuid.UUID, Evidence] = {}
        signals: dict[uuid.UUID, list[TensionChange]] = defaultdict(list)
        if rids:
            for b in self.s.scalars(select(Belief).where(Belief.responsibility_id.in_(rids),
                                                         Belief.superseded_by_id.is_(None))
                                    .order_by(Belief.confidence.desc())):
                beliefs[b.responsibility_id].append(b)
            bids = [b.id for bs in beliefs.values() for b in bs]
            if bids:
                for be, e in self.s.execute(select(BeliefEvidence, Evidence).join(
                        Evidence, Evidence.id == BeliefEvidence.evidence_id).where(BeliefEvidence.belief_id.in_(bids))):
                    cites[be.belief_id].append((e.id, be.stance))
                    evidence[e.id] = e
            for r in resps:
                rows = list(self.s.scalars(select(TensionChange).where(TensionChange.responsibility_id == r.id)
                                           .order_by(TensionChange.created_at.desc()).limit(12)))
                signals[r.id] = rows
                ev_ids = [c.evidence_id for c in rows if c.evidence_id][: self.evidence_per_agent]
                for e in self.s.scalars(select(Evidence).where(Evidence.id.in_(ev_ids))) if ev_ids else []:
                    evidence[e.id] = e
        sources = list(self.s.scalars(select(Source).where(Source.user_id == self.user_id).order_by(Source.created_at)))
        decisions = list(self.s.scalars(select(Decision).where(Decision.user_id == self.user_id)
                                        .order_by(Decision.created_at.desc()).limit(200)))
        agents = list(self.s.scalars(select(LinkedAgent).where(LinkedAgent.user_id == self.user_id)
                                     .order_by(LinkedAgent.last_activity_at.desc().nulls_last())))
        digest = self.s.scalar(select(HubDigest).where(HubDigest.user_id == self.user_id)
                               .order_by(HubDigest.created_at.desc()).limit(1))

        # pass 1: reserve every title so links can resolve in any order
        home = self.reserve("home", "home", HOME)
        for r in resps:
            self.reserve(f"r:{r.id}", "responsibility", r.raw_title or r.title_en, updated=r.updated_at)
        for bs in beliefs.values():
            for b in bs:
                self.reserve(f"b:{b.id}", "belief", b.statement_en, updated=b.updated_at)
        for e in evidence.values():
            self.reserve(f"e:{e.id}", "evidence", e.canonical_summary_en.split(". ")[0], updated=e.revised_at or e.retrieved_at)
        for src in sources:
            self.reserve(f"s:{src.id}", "source", src.title or src.uri or src.query or src.kind.value,
                         updated=src.last_polled_at or src.created_at)
        for d in decisions:
            self.reserve(f"d:{d.id}", "decision", d.decision_en, updated=d.created_at)
        projects: dict[str, dict[str, Any]] = {}
        for a in agents:
            self.reserve(f"a:{a.id}", "agent", a.name, updated=a.last_activity_at or a.created_at)
            for p in _summary(a).get("projects") or []:
                self._project(projects, p, agent=a)
        if digest:
            self.reserve("digest", "digest", DIGEST, updated=digest.created_at)
            for p in _content(digest).get("projects") or []:
                self._project(projects, p)
        for key, p in projects.items():
            self.reserve(f"p:{key}", "project", p["name"])

        # pass 2: bodies
        by_agent = {r.id: f"r:{r.id}" for r in resps}
        for r in resps:
            self._responsibility(r, beliefs[r.id], signals[r.id], sources, decisions, resps)
            for b in beliefs[r.id]:
                self._belief(b, by_agent[r.id], cites[b.id])
        for e in evidence.values():
            self._evidence(e, by_agent.get(e.responsibility_id) if e.responsibility_id else None)
        for src in sources:
            self._source(src, by_agent.get(src.responsibility_id) if src.responsibility_id else None)
        for d in decisions:
            self._decision(d, by_agent.get(d.responsibility_id) if d.responsibility_id else None)
        for a in agents:
            self._agent(a)
        if digest:
            self._digest(digest, agents)
        for key, p in projects.items():
            self._project_note(self.notes[f"p:{key}"], p)
        self._home(home, resps, agents, digest, projects)
        return list(self.notes.values())

    # -------------------------------------------------------------- note kinds

    def _home(self, n: Note, resps: list[Responsibility], agents: list[LinkedAgent], digest: HubDigest | None,
              projects: dict) -> None:
        live = [r for r in resps if r.status not in (ResponsibilityStatus.COMPLETED,)]
        waiting = [r for r in resps if r.status == ResponsibilityStatus.WAIT_USER]
        n.props = {"type": "home", "cssclasses": ["pga-home"], "responsibilities": len(live), "agents": len(agents)}
        n.tags = ["pga", "pga/home"]
        n.updated = max((x.updated for x in self.notes.values() if x.updated), default=None)
        lines = ["# PGA Home", "",
                 f"> [!abstract] 长期通才助理的知识库\n> {len(live)} 个责任 · "
                 f"{sum(x.kind == 'belief' for x in self.notes.values())} 条判断 · "
                 f"{sum(x.kind == 'evidence' for x in self.notes.values())} 条证据 · {len(agents)} 个 AI agent", ""]
        if waiting:
            lines += ["> [!important] 等你回复"] + [f"> - {self.link(n, f'r:{r.id}')}" for r in waiting] + [""]
        lines += ["## 责任 Responsibilities", "", "| 责任 | 状态 | 张力 |", "|---|---|---|"]
        for r in resps:
            lines.append(f"| {self.link(n, f'r:{r.id}')} | {STATUS_ZH.get(r.status.value, r.status.value)} | "
                         f"`{r.tension:.2f}` {_bar(r.tension)} |")
        if not resps:
            lines.append("| *还没有责任* | | |")
        if agents:
            lines += ["", "## AI agents", ""] + [f"- {self.link(n, f'a:{a.id}')} — {a.vendor} · {a.conversation_count} 段对话"
                                                for a in agents]
        if projects:
            lines += ["", "## 项目 Projects", ""] + [f"- {self.link(n, f'p:{k}')}" for k in projects]
        if digest:
            lines += ["", f"综述：{self.link(n, 'digest')}"]
        lines += ["", "## Dataview", "", "```dataview",
                  'TABLE status, tension, wake_threshold FROM "Responsibilities" SORT tension DESC', "```"]
        n.body = "\n".join(lines)

    def _responsibility(self, r: Responsibility, beliefs: list[Belief], signals: list[TensionChange],
                        sources: list[Source], decisions: list[Decision], resps: list[Responsibility]) -> None:
        n = self.notes[f"r:{r.id}"]
        st = r.status.value
        n.props = {"type": "responsibility", "status": st, "tension": round(r.tension, 3),
                   "wake_threshold": r.wake_threshold, "sleep_threshold": r.sleep_threshold,
                   "aliases": [r.title_en] if r.raw_title and r.raw_title != r.title_en else [],
                   "keywords": list(r.keywords or [])[:12], "created": _iso(r.created_at), "updated": _iso(r.updated_at),
                   "up": f"[[{HOME}]]", "pga_id": str(r.id)}
        n.links.append("home")
        n.tags = ["pga/responsibility", f"status/{st.lower()}"] + [f"topic/{tag_slug(k)}" for k in (r.keywords or [])[:6]
                                                                   if tag_slug(k)]
        kind = "danger" if r.tension >= r.wake_threshold else "abstract"
        lines = [f"# {n.title}", "", f"> [!{kind}] 责任 · {STATUS_ZH.get(st, st)}",
                 f"> 张力 `{r.tension:.2f}` / 唤醒线 `{r.wake_threshold:.2f}` · {_bar(r.tension)}"]
        if r.parent_id and f"r:{r.parent_id}" in self.notes:
            lines.append(f"> 上级 {self.link(n, f'r:{r.parent_id}')}")
        if r.stop_reason:
            lines.append(f"> 停止原因：{r.stop_reason}")
        lines.append("")
        if r.description_en:
            lines += [r.description_en.strip(), ""]
        if beliefs:
            lines.append("## 判断 Beliefs")
            for btype in (BeliefType.CONCLUSION, BeliefType.HYPOTHESIS, BeliefType.UNCERTAINTY):
                group = [b for b in beliefs if b.type == btype]
                if group:
                    lines += ["", f"### {BELIEF_CALLOUT[btype][1]}"]
                    lines += [f"- {self.link(n, f'b:{b.id}')} · `{b.confidence:.0%}`" + (" ⚠ 需复核" if b.needs_review else "")
                              for b in group]
            lines.append("")
        if signals:
            lines += ["## 最近信号 Signals", "", "| 时间 | Δ | 说明 |", "|---|---|---|"]
            for c in signals:
                ev = f" {self.link(n, f'e:{c.evidence_id}', '证据')}" if c.evidence_id and f"e:{c.evidence_id}" in self.notes else ""
                why = (c.explanation_en or c.kind.value).replace("|", "/").replace("\n", " ")[:160]
                lines.append(f"| {c.created_at:%m-%d %H:%M} | `{c.delta:+.2f}` | {why}{ev} |")
            lines.append("")
        mine = [s for s in sources if s.responsibility_id == r.id]
        if mine:
            lines += ["## 信息源", ""] + [f"- {self.link(n, f's:{s.id}')}" for s in mine] + [""]
        ds = [d for d in decisions if d.responsibility_id == r.id]
        if ds:
            lines += ["## 决定", ""] + [f"- {self.link(n, f'd:{d.id}')}" for d in ds] + [""]
        kids = [k for k in resps if k.parent_id == r.id]
        if kids:
            lines += ["## 子责任", ""] + [f"- {self.link(n, f'r:{k.id}')}" for k in kids] + [""]
        n.body = "\n".join(lines)

    def _belief(self, b: Belief, rid: str, cites: list[tuple[uuid.UUID, str]]) -> None:
        n = self.notes[f"b:{b.id}"]
        callout, label = BELIEF_CALLOUT.get(b.type, ("note", b.type.value))
        n.props = {"type": "belief", "belief_type": b.type.value, "status": b.status.value,
                   "confidence": round(b.confidence, 3), "needs_review": b.needs_review or None,
                   "responsibility": f"[[{self.notes[rid].title}]]", "key": b.key, "created": _iso(b.created_at),
                   "updated": _iso(b.updated_at), "pga_id": str(b.id)}
        n.links.append(rid)
        n.tags = ["pga/belief", f"belief/{b.type.value.lower()}"] + (["review"] if b.needs_review else [])
        lines = [f"> [!{callout}] {label} · 置信度 {b.confidence:.0%}", _quote(b.statement_en), "",
                 f"responsibility:: {self.link(n, rid)}", ""]
        if b.status.value != "ACTIVE":
            lines += [f"> [!failure] 状态：{b.status.value}", ""]
        if cites:
            lines += ["## 证据 Evidence", ""]
            for eid, stance in cites:
                key = "contradicts" if stance == "CONTRADICTS" else "supports"
                lines.append(f"- {key}:: {self.link(n, f'e:{eid}')}")
        else:
            lines.append("*没有引用证据 —— 最多只能算假设。*")
        n.body = "\n".join(lines)

    def _evidence(self, e: Evidence, rid: str | None) -> None:
        n = self.notes[f"e:{e.id}"]
        n.props = {"type": "evidence", "source_type": e.source_type, "url": e.source_uri,
                   "published": _iso(e.published_at), "retrieved": _iso(e.retrieved_at),
                   "trust": round(e.trust_score, 2) if e.trust_score is not None else None,
                   "retracted": True if e.retracted_at else None, "pga_id": str(e.id)}
        n.tags = ["pga/evidence", f"source/{tag_slug(e.source_type) or 'other'}"]
        lines = [f"> [!quote] {e.source_type}" + (f" · {e.published_at:%Y-%m-%d}" if e.published_at else ""),
                 _quote(e.canonical_summary_en), ""]
        if e.retracted_at:
            lines += ["> [!failure] 来源已撤回或被证明有误", ""]
        if e.source_uri:
            lines += [f"[原文]({e.source_uri})", ""]
        if rid:
            lines.append(f"responsibility:: {self.link(n, rid)}")
        n.body = "\n".join(lines)

    def _source(self, src: Source, rid: str | None) -> None:
        n = self.notes[f"s:{src.id}"]
        n.props = {"type": "source", "kind": src.kind.value, "uri": src.uri, "query": src.query,
                   "enabled": src.enabled, "interval_minutes": src.interval_minutes, "trust": src.trust_score,
                   "last_polled": _iso(src.last_polled_at), "last_status": src.last_status, "pga_id": str(src.id)}
        n.tags = ["pga/source", f"source/{src.kind.value.lower()}"] + ([] if src.enabled else ["paused"])
        lines = [f"> [!info] 信息源 · {src.kind.value}" + ("" if src.enabled else " · 已停用"),
                 f"> {src.uri or src.query or ''}", ""]
        lines.append(f"feeds:: {self.link(n, rid) if rid else self.link(n, 'home')}")
        n.body = "\n".join(lines)

    def _decision(self, d: Decision, rid: str | None) -> None:
        n = self.notes[f"d:{d.id}"]
        n.props = {"type": "decision", "decided_by": d.decided_by.value, "created": _iso(d.created_at), "pga_id": str(d.id)}
        n.tags = ["pga/decision", f"decided-by/{d.decided_by.value.lower()}"]
        lines = [f"> [!tip] 决定 · {d.decided_by.value} · {d.created_at:%Y-%m-%d}", _quote(d.decision_en), ""]
        if d.rationale_en:
            lines += ["## 理由", "", d.rationale_en.strip(), ""]
        if rid:
            lines.append(f"responsibility:: {self.link(n, rid)}")
        n.body = "\n".join(lines)

    def _agent(self, a: LinkedAgent) -> None:
        n = self.notes[f"a:{a.id}"]
        s = _summary(a)
        n.props = {"type": "agent", "vendor": a.vendor, "connector": a.connector, "usage": a.usage,
                   "conversations": a.conversation_count, "messages": a.message_count,
                   "first_activity": _iso(a.first_activity_at), "last_activity": _iso(a.last_activity_at),
                   "up": f"[[{HOME}]]", "pga_id": str(a.id)}
        n.links.append("home")
        n.tags = ["pga/agent", f"vendor/{tag_slug(a.vendor) or 'other'}", f"usage/{a.usage}"]
        n.tags += [f"topic/{tag_slug(t.get('name', ''))}" for t in (s.get("topics") or [])[:8] if tag_slug(t.get("name", ""))]
        lines = [f"> [!example] {a.vendor} · {a.conversation_count} 段对话 · {a.message_count} 条消息"]
        lines.append(_quote(s.get("headline") or a.notes or "还没有总结。"))
        lines.append("")
        if s.get("used_for"):
            lines += ["## 用来做什么", ""] + [f"- {x}" for x in s["used_for"]] + [""]
        if s.get("topics"):
            lines += ["## 主题", ""] + [f"- {t.get('name')} `{_bar(float(t.get('weight') or 0), 5)}`" for t in s["topics"]] + [""]
        if s.get("projects"):
            lines += ["## 项目", ""]
            for p in s["projects"]:
                key = _project_key(p.get("name", ""))
                ref = self.link(n, f"p:{key}") if f"p:{key}" in self.notes else str(p.get("name"))
                lines.append(f"- {ref} · {p.get('status', '')}" + (f" — {p['note']}" if p.get("note") else ""))
            lines.append("")
        if s.get("preferences"):
            lines += ["## 偏好", ""] + [f"- {x}" for x in s["preferences"]] + [""]
        if s.get("open_threads"):
            lines += ["## 未完成", ""] + [f"- [ ] {x}" for x in s["open_threads"]] + [""]
        if s.get("strengths"):
            lines += ["> [!tip] 擅长", _quote(s["strengths"])]
        n.body = "\n".join(lines)

    def _digest(self, d: HubDigest, agents: list[LinkedAgent]) -> None:
        n = self.notes["digest"]
        c = _content(d)
        names = {a.name.lower(): f"a:{a.id}" for a in agents}
        n.props = {"type": "digest", "created": _iso(d.created_at), "agents": len(d.agent_ids or []), "up": f"[[{HOME}]]"}
        n.links.append("home")
        n.tags = ["pga/digest"]

        def agent_ref(name: str) -> str:
            nid = names.get(str(name).lower())
            return self.link(n, nid) if nid else str(name)

        lines = ["> [!abstract] 你和所有 AI 的工作全景", _quote(c.get("overview") or ""), ""]
        if c.get("agent_roles"):
            lines += ["## 分工", ""] + [f"- {agent_ref(x.get('agent', ''))} — {x.get('role', '')}" for x in c["agent_roles"]] + [""]
        if c.get("projects"):
            lines += ["## 项目", ""]
            for p in c["projects"]:
                key = _project_key(p.get("name", ""))
                lines.append(f"- {self.link(n, f'p:{key}')} · {p.get('status', '')}"
                             + (f" — 下一步：{p['next_step']}" if p.get("next_step") else ""))
            lines.append("")
        for k, title, mark in (("recurring_needs", "反复出现的需求", "-"), ("overlaps", "重复劳动", "-"),
                               ("gaps", "没人负责的空白", "-"), ("recommendations", "建议", "- [ ]"),
                               ("open_threads", "未完成", "- [ ]")):
            if c.get(k):
                lines += [f"## {title}", ""] + [f"{mark} {x}" for x in c[k]] + [""]
        n.body = "\n".join(lines)

    def _project(self, projects: dict, p: dict, agent: LinkedAgent | None = None) -> None:
        name = str(p.get("name") or "").strip()
        key = _project_key(name)
        if not key:
            return
        cur = projects.setdefault(key, {"name": name, "status": "unknown", "agents": [], "notes": [], "next": [],
                                        "last_seen": ""})
        if p.get("status") and p["status"] != "unknown":
            cur["status"] = p["status"]
        if agent is not None and agent.id not in cur["agents"]:
            cur["agents"].append(agent.id)
        if p.get("note"):
            cur["notes"].append((agent.name if agent else "digest", p["note"]))
        if p.get("next_step"):
            cur["next"].append(p["next_step"])
        if (p.get("last_seen") or "") > cur["last_seen"]:
            cur["last_seen"] = p["last_seen"]

    def _project_note(self, n: Note, p: dict) -> None:
        n.props = {"type": "project", "status": p["status"], "last_seen": p["last_seen"] or None,
                   "agents": [f"[[{self.notes[f'a:{a}'].title}]]" for a in p["agents"] if f"a:{a}" in self.notes]}
        n.tags = ["pga/project", f"status/{tag_slug(p['status']) or 'unknown'}"]
        lines = [f"> [!summary] 项目 · {p['status']}" + (f" · 最近 {p['last_seen']}" if p["last_seen"] else ""), ""]
        if p["agents"]:
            lines += ["## 在哪些 AI 里做", ""] + [f"- {self.link(n, f'a:{a}')}" for a in p["agents"]] + [""]
        if p["notes"]:
            lines += ["## 记录", ""] + [f"- **{who}**：{text}" for who, text in p["notes"]] + [""]
        if p["next"]:
            lines += ["## 下一步", ""] + [f"- [ ] {x}" for x in dict.fromkeys(p["next"])] + [""]
        if "digest" in self.notes:
            lines.append(f"see:: {self.link(n, 'digest')}")
        n.body = "\n".join(lines)


def _summary(a: LinkedAgent) -> dict:
    s = a.summary_display or a.summary or {}
    return s if isinstance(s, dict) else {}


def _content(d: HubDigest) -> dict:
    c = d.content_display or d.content or {}
    return c if isinstance(c, dict) else {}


def _project_key(name: str) -> str:
    return re.sub(r"\W+", "-", (name or "").lower(), flags=re.UNICODE).strip("-")[:80]


# ------------------------------------------------------------------ the user's own Obsidian vault (read-only)


def _frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    try:
        data = yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError:
        data = {}
    rest = text[end + 4:]
    return (data if isinstance(data, dict) else {}), rest.lstrip("\n")


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def read_obsidian_vault(root: str | Path, *, max_files: int = 1500, max_bytes: int = 200_000) -> list[Note]:
    """Parse .md notes under `root` (skipping .obsidian, .trash and hidden folders). Read-only."""
    base = Path(root).expanduser()
    if not base.is_dir():
        return []
    notes: list[Note] = []
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in ("node_modules",))
        for fn in sorted(filenames):
            if not fn.endswith(".md") or len(notes) >= max_files:
                continue
            p = Path(dirpath) / fn
            try:
                if p.is_symlink() or p.stat().st_size > max_bytes:
                    continue
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            props, body = _frontmatter(text)
            rel = p.relative_to(base)
            plain = _FENCE.sub(" ", body)
            raw_tags = props.get("tags") or props.get("tag") or []
            if isinstance(raw_tags, str):
                raw_tags = re.split(r"[,\s]+", raw_tags)
            tags = [str(t).lstrip("#") for t in raw_tags if t] + _INLINE_TAG.findall(plain)
            targets = [m.strip() for m in _WIKILINK.findall(plain) if m.strip()]
            folder = "Obsidian" + ("/" + rel.parent.as_posix() if rel.parent.as_posix() != "." else "")
            try:
                mtime = datetime.fromtimestamp(p.stat().st_mtime).astimezone()
            except OSError:
                mtime = None
            notes.append(Note(id=f"x:{rel.as_posix()}", kind="external", title=p.stem, folder=folder,
                              props=_jsonable(props), body=body, tags=list(dict.fromkeys(tags)), link_targets=targets,
                              updated=mtime, external=True))
        if len(notes) >= max_files:
            break
    return notes


def _resolve(notes: list[Note]) -> int:
    """Turn external notes' [[targets]] into note ids (by title or path, case-insensitive). Returns unresolved count."""
    by_name: dict[str, str] = {}
    for n in notes:
        by_name.setdefault(n.title.lower(), n.id)
        by_name.setdefault(n.path.lower().removesuffix(".md"), n.id)
        if n.external:
            by_name.setdefault(n.id[2:].lower().removesuffix(".md"), n.id)
    missing = 0
    for n in notes:
        for t in n.link_targets:
            key = t.lower().removesuffix(".md")
            nid = by_name.get(key) or by_name.get(key.rsplit("/", 1)[-1])
            if nid:
                n.links.append(nid)
            else:
                missing += 1
    return missing


def build_vault(session: Session, user_id: uuid.UUID, *, obsidian_dir: str | Path | None = None,
                evidence_per_agent: int = 12) -> Vault:
    notes = _Builder(session, user_id, evidence_per_agent).build()
    if obsidian_dir:
        notes += read_obsidian_vault(obsidian_dir)
    return Vault(notes=notes, unresolved=_resolve(notes))
