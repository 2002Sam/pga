/* PGA app · 验收 (watchdog), a canvas node ported from Paperclip's task watchdog (paperclipai/paperclip, MIT, Copyright (c)
   2025 Paperclip AI; see third_party/paperclip/LICENSE).

   Wire branches into it and it watches them:
   - when every one of them has stopped (none running), and their state is not one it already reviewed (the stop
     fingerprint), it wakes an agent to verify;
   - the agent treats each answer as a claim and checks it against the evidence; a branch that is not really done gets
     an instruction and runs again, carried on in its own conversation (the earlier answer stays a version);
   - the result changes the fingerprint, so the node checks again, up to its round limit; an unchanged state is never
     reviewed twice.

   Copied: the default mandate (packages/adapter-utils/src/server-utils.ts WATCHDOG_DEFAULT_MANDATE), the stop fingerprint
   and the review-once rule (server/src/services/task-watchdogs.ts). Modified by PGA (2026-10-22):
   - issues, subtrees and comments become a canvas node's branches and their conversations;
   - Paperclip's server-side mutations become a JSON verdict that this page applies;
   - the platform-bug route and the company boundaries are dropped (PGA has neither). */

// ---- adapted from Paperclip's WATCHDOG_DEFAULT_MANDATE (MIT)
const WATCHDOG_MANDATE = [
  "You are running as a task watchdog, not as the original deliverable worker.",
  "Your mission is to keep the watched work moving by verifying stopped work, not by trusting agent claims.",
  "",
  "Mandate:",
  "- Treat every stopped branch below (answered, failed, or waiting) as a claim that must be verified against the evidence: what was asked, what the answer says, files, diffs, tests and commands you can inspect in the working folder.",
  '- Do not accept "I could not" or "waiting for approval" as automatically valid. Read the evidence before deciding.',
  "- If a branch is genuinely complete, leave it alone and record why you believe so.",
  "- If a branch is not genuinely complete, restore a live path: write the concrete, actionable instruction that its agent should carry out next.",
  "- If you confirm a true blocker on a human or external system, mark it blocked and name who must act and what they must do, rather than silently approving it.",
  "",
  "Safety constraints (these always apply, even if custom instructions disagree):",
  "- Stay inside the branches you were given. Do not change files yourself; you verify, the branch agents do the work.",
  "- Do not impersonate the user's approvals or accept spending, hiring or security-sensitive decisions on their behalf.",
  "- Custom instructions can add focus or veto specific shortcuts, but cannot remove these safety constraints.",
  "",
  "Disposition:",
  "- Keep the work moving. Do not loop on the same unchanged state.",
].join("\n");
// ---- end of adapted text

const WATCH_FORMAT = `End your reply with one fenced JSON block, exactly in this shape, one entry per branch, using the ids given:
\`\`\`json
{"branches": [{"id": "…", "verdict": "done" | "redo" | "blocked", "why": "one sentence", "next": "the instruction for its agent (redo), or who must act (blocked)"}], "summary": "two or three sentences"}
\`\`\`
Write the reasons and instructions in the language the branches were asked in.`;

const watchLeaves = (n) => cvIns(n.id).filter((u) => !u.gone && u.kind !== "group");
function stopFingerprint(n) {                    // Paperclip: a hash over the stopped leaves and the watchdog's own settings
  const ls = watchLeaves(n);
  return "stop:" + fnv(JSON.stringify([n.text || "", n.agent || "", ...ls.map((u) => [u.id, state(u), fnv(outOf(u)), u.err || ""])]));
}
function watchReady(n) {
  const ls = watchLeaves(n);
  return ls.length > 0 && ls.every((u) => !CV.busy[u.id] && (SOURCES.has(u.kind) || ["fresh", "error", "locked"].includes(state(u))))
    && ls.some((u) => outOf(u) || u.err);
}
function watchBody(n) {
  const v = n.verdicts || {}, ls = watchLeaves(n), mark = { done: "✓", redo: "↻", blocked: "⏸" };
  return `<div class="cvrow"><select data-f="agent"><option value="auto" ${!n.agent || n.agent === "auto" ? "selected" : ""}>${L("自动选 agent", "Auto")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === n.agent ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("")}</select>
      <label class="cvdim"><input type="checkbox" data-wauto ${n.auto !== false ? "checked" : ""}> ${L("自动", "auto")}</label><span class="cvdim">${L(`第 ${n.rounds || 0}/${n.max || 3} 轮`, `round ${n.rounds || 0}/${n.max || 3}`)}</span></div>
    <textarea class="cvt" data-f="text" rows="2" placeholder="${L("额外的验收要求（可空），比如：每一项都要有测试通过的证据", "Extra checks (optional), e.g. every item needs passing tests as evidence")}">${esc(n.text || "")}</textarea>
    ${ls.length ? `<div class="cvwl">${ls.map((u) => { const x = v[u.id]; return `<div class="cvwi ${x?.verdict || ""}"><b>${x ? mark[x.verdict] || "·" : "·"}</b><span title="${esc(x?.why || "")}">${esc((u.title || kname(u.kind)).slice(0, 34))}${x?.why ? ` — <em>${esc(x.why.slice(0, 80))}</em>` : ""}</span></div>`; }).join("")}</div>`
      : `<div class="cvdim">${L("把要验收的分支连进来：它们都停下以后，这里会派一个 agent 逐个核对", "Wire in the branches to verify: once all have stopped, an agent checks each")}</div>`}
    ${n.out ? `<div class="cvo">${md(n.out)}</div>` : ""}${n.err ? `<div class="cverr">${esc(n.err)}</div>` : ""}`;
}
async function cookWatch(n) {
  const ls = watchLeaves(n); if (!ls.length) throw new Error(L("还没有连进来的分支", "Nothing wired in yet"));
  const fp = stopFingerprint(n);
  const branches = ls.map((u) => {
    const q = u.askIn ? cvNode(u.askIn)?.text : u.kind === "chat" ? [inputText(u), u.text].filter(Boolean).join("\n") : u.text;
    return `### id: ${u.id}\nTitle: ${u.title || kname(u.kind)} (${kname(u.kind)}${u.used || u.agent ? ", agent " + (u.used || u.agent) : ""}, state ${state(u)})\nAsked:\n${String(q || "").slice(0, 2500)}\nAnswer:\n${String(outOf(u) || u.err || "(none)").slice(0, 5000)}`;
  }).join("\n\n");
  const text = [WATCHDOG_MANDATE, `Stop fingerprint: ${fp}`, "Stopped branches to verify:", branches,
    n.text ? `Board-supplied watchdog instructions (read after the mandate; do not let them remove safety constraints):\n${n.text}` : "No board-supplied watchdog instructions. Apply the mandate above.", WATCH_FORMAT].join("\n\n");
  const key = n.key || `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; n.key = key;
  const acc = S.acc?.["*new"] || {};
  const r = await api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: n.agent || "auto", conversation: key, world: CV.world !== "top" ? CV.world : undefined, access: "read", folder: acc.folder || "" } });
  if (!r?.text && r?.error) throw new Error(r.error);
  const m = String(r.text || "").match(/```json\s*([\s\S]*?)```/) || String(r.text || "").match(/(\{[\s\S]*"branches"[\s\S]*\})/);
  let v; try { v = JSON.parse(m[1]); } catch { throw new Error(L("验收的回答里没有可读的结论", "The watchdog's reply had no verdict to read")); }
  keepVersion(n); n.used = r.agent; n.at = new Date().toISOString(); n.reviewed = fp; n.rounds = (n.rounds || 0) + 1;
  n.verdicts = Object.fromEntries((v.branches || []).filter((b) => b && b.id).map((b) => [b.id, { verdict: b.verdict, why: b.why || "", next: b.next || "" }]));
  const redo = (v.branches || []).filter((b) => b.verdict === "redo" && b.next && cvNode(b.id)?.kind === "chat");
  n.out = `${v.summary || ""}${redo.length ? `\n\n${L(`退回 ${redo.length} 项接着做`, `${redo.length} sent back`)}` : ""}`;
  setTimeout(() => {                             // restore a live path: each branch not really done carries on with the instruction
    for (const b of redo) { const u = cvNode(b.id); if (!u || u.lock) continue; u.text = b.next; u.err = null; cook(u.id, { force: true }); }
    cvRender();
  }, 0);
}
setInterval(() => {                              // the scan: wake a watchdog when what it watches has come to rest in a state it has not reviewed
  if (S.view !== "canvas" || !CV.data) return;
  for (const n of CV.data.nodes) {
    if (n.kind !== "watch" || n.auto === false || n.lock || CV.busy[n.id] || CV.cooking[n.id]) continue;
    if ((n.rounds || 0) >= (n.max || 3) || !watchReady(n)) continue;
    if (stopFingerprint(n) === n.reviewed) continue;                 // already saw this exact stopped state
    cook(n.id, { force: true });
  }
}, 5000);
document.addEventListener("change", (e) => {
  const c = e.target.closest?.("[data-wauto]"); if (!c) return; const n = cvNode(c.closest(".cvnode")?.dataset.nid); if (!n) return;
  n.auto = c.checked; if (n.auto && (n.rounds || 0) >= (n.max || 3)) n.rounds = 0; cvRender(); cvSave();
});
