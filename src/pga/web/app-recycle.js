/* PGA app · 对话回收 on the stage (pga.recycle on the server).
   - What you saw: a page whose answer finished in front of you (or whose number you cleared by turning to it) is
     reported, batched, to /chats/seen.
   - Once a minute the stage asks /chats/recycle, telling which pages are still unread and which one is in front of
     you; the one-off conversations a manager dispatched that are done and seen are archived, and their pages leave
     the stage. Nothing is deleted: the manager's record of each task stays and says it is archived; 撤销 puts the
     batch back. Only the stage itself runs this (a conversation's frame loads this file too). */
const RC = { seen: new Set(), timer: 0, busy: false };
const rcStage = () => !!$("#vStage")?.dataset.ready && typeof ST !== "undefined" && !!S.uid;
window.stSaw = function (key) {
  if (!key || !rcStage()) return;
  RC.seen.add(key);
  clearTimeout(RC.timer);
  RC.timer = setTimeout(rcFlushSeen, 1500);
};
async function rcFlushSeen() {
  const keys = [...RC.seen]; RC.seen.clear();
  if (keys.length) try { await api(`/v1/users/${S.uid}/chats/seen`, { body: { keys } }); } catch { keys.forEach((k) => RC.seen.add(k)); }
}
async function rcSweep() {
  if (!rcStage() || RC.busy || document.hidden) return;
  RC.busy = true;
  try {
    await rcFlushSeen();
    const wins = stWins().filter((n) => n.key);
    const unread = wins.filter((n) => n.done || n.run).map((n) => n.key);
    const focus = ST.nodes.find((n) => n.id === ST.focus);
    const r = await api(`/v1/users/${S.uid}/chats/recycle`, { body: { unread, visible: focus?.key ? [focus.key] : [] } });
    const gone = new Set((r.archived || []).map((x) => x.key));
    if (!gone.size) return;
    for (const n of stWins()) if (gone.has(n.key) && n.id !== ST.focus) stClose(n);
    rcToast(gone.size);
  } catch {} finally { RC.busy = false; }
}
function rcToast(n) {
  toast(L(`已归档 ${n} 个完成并看过的任务对话（管理员里仍有记录）`, `Archived ${n} finished task conversation(s) you had seen (the manager keeps the record)`));
  const t = $("#toast"), b = document.createElement("button");
  b.className = "sm ghost"; b.style.marginLeft = "10px"; b.textContent = L("撤销", "Undo");
  b.onclick = async () => {
    t.style.pointerEvents = "";
    try {
      const r = await api(`/v1/users/${S.uid}/chats/recycle/undo`, { method: "POST", body: {} });
      toast(L(`已恢复 ${r.restored.length} 个对话`, `Restored ${r.restored.length} conversation(s)`));
    } catch (e) { toast(e.message); }
  };
  t.appendChild(b); t.style.pointerEvents = "auto";               // #toast lets clicks through; this one has a button
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.classList.remove("on"); t.style.pointerEvents = ""; }, 9000);
}
setTimeout(rcSweep, 8000);
setInterval(rcSweep, 60000);
