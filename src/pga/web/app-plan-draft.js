/* Generate in this page. Only accepting a proposal writes it to the plan. */
function planDraftDialog(seed, page) {
  const note = page?.row || S.notes?.find(row => row.id === S.note);
  if (!note) return;
  const html = `<form class="plan-form">
    <div class="plan-form-head"><span class="dimt">${esc(note.title)}</span>
      <button type="button" class="sm ghost" data-closemodal="1">${L("关闭", "Close")}</button></div>
    <div class="plan-entry"><h2><label for="plan-description-${esc(note.id)}">${L("明天想做什么？", "What’s on for tomorrow?")}</label></h2>
      <textarea id="plan-description-${esc(note.id)}" name="description" rows="4" maxlength="6000" required placeholder="${L("明天下午三点要给客户演示新版。我想先跑通流程，再做几页演示稿，还有两封邮件要回。", "Tomorrow I’m showing the new version to a client at 3. I want to rehearse, make a few slides and reply to two emails.")}"></textarea>
      <button type="submit" class="sm primary">${L("生成项目安排", "Generate agenda")}</button></div>
    <section class="plan-result" hidden><article class="md plan-paper"></article>
      <div class="plan-questions"></div>
      <div class="plan-buttons"><button type="button" class="sm primary" data-apply-plan></button>
      <button type="button" class="sm" data-rewrite>${L("修改描述", "Edit description")}</button></div></section>
    <span role="status" aria-live="polite"></span></form>`;
  const dialog = page ? document.createElement("section") : modal(html);
  if (page) {
    page.host.querySelector(".stage-plan-draft")?.remove();
    dialog.className = "stage-plan-draft";
    dialog.innerHTML = html;
    page.host.append(dialog);
    dialog.querySelector("[data-closemodal]").onclick = event => { event.stopPropagation(); dialog.remove(); };
  }
  const form = dialog.querySelector("form"), description = form.elements.description;
  const status = form.querySelector('[role="status"]'), entry = form.querySelector(".plan-entry");
  const result = form.querySelector(".plan-result"), questions = form.querySelector(".plan-questions");
  const apply = form.querySelector("[data-apply-plan]");
  description.value = seed ?? (note.plan_template || note.has_agenda ? "" : ($("#ntext")?.value ?? note.text ?? ""));
  description.focus();
  let markdown = "", draftId = "", prompts = [], busy = false;

  function selectedAnswers() {
    return prompts.flatMap(({question, options}, i) => {
      const selected = questions.querySelector(`input[name="plan-q-${i}"]:checked`);
      return selected && selected.value !== "" ? [{question, choice: options[Number(selected.value)]}] : [];
    });
  }
  function updateApply() {
    apply.textContent = selectedAnswers().length ? L("按选择调整安排", "Update with my choices") : L("保存这份安排", "Save agenda");
  }
  function showProposal(reply) {
    markdown = reply.markdown;
    draftId = crypto.randomUUID();
    prompts = reply.questions || [];
    result.querySelector("article").innerHTML = md(markdown);
    questions.innerHTML = prompts.length ? `<h3>${L("可选补充", "Optional details")}</h3>
      ${prompts.map(({question, options}, i) => `<fieldset><legend>${esc(question)}</legend>
      ${[...options, L("按当前安排", "Keep as proposed")].map((option, j) => `<label><input type="radio" name="plan-q-${i}" value="${j === options.length ? "" : j}" ${j === options.length ? "checked" : ""}><span>${esc(option)}</span></label>`).join("")}</fieldset>`).join("")}` : "";
    updateApply();
    entry.hidden = true; result.hidden = false;
    dialog.scrollTop = 0;
    status.textContent = "";
  }
  questions.onchange = updateApply;
  async function generate(answers = []) {
    const paragraph = description.value.trim();
    if (!paragraph) { status.textContent = L("写下明天想做的事。", "Describe what you want to do tomorrow."); return; }
    const body = {description: paragraph, lang: EN ? "en" : "zh"};
    if (note.date) body.plan_date = note.date;
    if (answers.length) Object.assign(body, {answers, previous: markdown});
    const reply = await api(`/v1/users/${S.uid}/plans/draft`, {body});
    if (dialog.isConnected) showProposal(reply);
  }
  async function run(action, message) {
    if (busy) return;
    busy = true;
    const controls = form.querySelectorAll("textarea, input, button:not([data-closemodal])");
    controls.forEach(control => { control.disabled = true; });
    status.textContent = message;
    try { await action(); }
    catch (err) { status.textContent = err.message; }
    finally { busy = false; controls.forEach(control => { control.disabled = false; }); }
  }
  const generating = L("正在拆解任务、估时并排程…", "Preparing the schedule…");
  form.onsubmit = event => { event.preventDefault(); run(() => generate(), generating); };
  form.querySelector("[data-rewrite]").onclick = () => {
    entry.hidden = false; result.hidden = true; status.textContent = ""; description.focus();
  };
  apply.onclick = () => {
    const answers = selectedAnswers();
    if (answers.length) { run(() => generate(answers), generating); return; }
    if (!markdown || (page ? !page.host.isConnected : S.view !== "notes" || S.note !== note.id)) return;
    run(async () => {
      await flushNote(note.id);
      const saved = await api(`/v1/notes/${note.id}`, {method: "PUT", body: {text: markdown, append: true, draft_id: draftId}});
      const current = S.notes?.find(row => row.id === note.id);
      if (current) Object.assign(current, saved, {chars: saved.text.length});
      syncStagePlan(saved);
      page?.host.showPreview?.(true);
      if (S.view === "notes" && S.note === note.id) { S.nprev = true; renderNotes(); }
      dialog.remove();
    }, L("正在保存…", "Saving…"));
  };
}

// Page snapshots keep only the plan ID, date/project title and window geometry.
const stagePlanData = new WeakMap();
function showStagePlan(plan, source, seed) {
  const pages = stWins();
  let n = pages.find(w => w.planId === plan.id);
  if (!n) {
    stFreezeWidths();
    n = {id: stId(), type: "win", memo: "plan:" + plan.id, planId: plan.id, planProject: plan.project || "",
      title: plan.title, bw: stHalfWidth(), creationGroup: source && stGroupOf(source), openedAt: Date.now()};
    const anchor = pages.indexOf(source);
    pages.splice(anchor < 0 ? pages.length : anchor + 1, 0, n);
    pages.forEach((w, i) => { w.ord = i; if (w.overviewOrder != null) w.overviewOrder = i; });
    ST.nodes.push(n);
  }
  stagePlanData.set(n, plan);
  if (n.el && !planSaves.has(plan.id)) syncStagePlan(plan);
  (ST.stageOpen ||= new Set()).add(n.id);
  stFocus(n.id, true);
  stShow(n.id, true);
  stSave();
  const host = n.el?.querySelector(".stage-plan");
  if (seed?.trim() && host?.openDraft) host.openDraft(seed);
}

function syncStagePlan(saved) {
  const node = typeof ST !== "undefined" && ST.nodes.find(n => n.planId === saved.id);
  if (!node) return;
  const renamed = node.title !== saved.title;
  node.title = saved.title;
  if (renamed) { stSave(); stMap(); }
  const title = node.el?.querySelector(".memot");
  if (title) title.textContent = saved.title;
  node.el?.querySelector(".stage-plan")?.showSaved?.(saved);
}

async function mountStagePlan(node, el) {
  const host = el.querySelector(".memob");
  host.className = "stage-plan";
  host.textContent = L("正在打开计划…", "Opening plan…");
  let row = stagePlanData.get(node);
  try {
    row ??= (await api(`/v1/users/${S.uid}/notes`)).find(r => r.id === node.planId);
    if (!row) throw Error(L("这份计划已删除。", "This plan has been deleted."));
  } catch (err) { host.textContent = err.message; return; }
  if (!host.isConnected) return;
  const pending = planSaves.get(row.id);
  if (pending) Object.assign(row, pending.body);
  stagePlanData.set(node, row);
  host.innerHTML = `<div class="nhd"><input data-plan-title aria-label="${L("计划标题", "Plan title")}">
    <span data-plan-status role="status"></span>
    <button class="sm primary" data-plan-ai>${L("AI 排程", "AI schedule")}</button>
    <button class="sm" data-plan-preview>${L("预览", "Preview")}</button></div>
    <textarea data-plan-text aria-label="${L("计划内容", "Plan contents")}"></textarea><div class="nprev md plan-paper" hidden></div>`;
  const title = host.querySelector("[data-plan-title]"), text = host.querySelector("textarea");
  const preview = host.querySelector(".nprev"), toggle = host.querySelector("[data-plan-preview]"), status = host.querySelector("[role=status]");
  host.showSaved = saved => {
    Object.assign(row, saved);
    if (text.value !== row.text) text.value = row.text || "";
    if (title.value !== row.title) title.value = row.title;
    if (!preview.hidden) preview.innerHTML = md(row.text || "");
    status.textContent = L("已保存", "Saved");
  };
  host.showSaved(row);
  if (pending) { pending.row = row; pending.status = status; status.textContent = L("正在保存…", "Saving…"); }
  title.oninput = text.oninput = () => saveNoteSoon(row, {title: title.value, text: text.value}, status);
  host.showPreview = visible => {
    text.hidden = visible; preview.hidden = !visible;
    if (visible) preview.innerHTML = md(text.value);
    toggle.textContent = visible ? L("编辑", "Edit") : L("预览", "Preview");
  };
  toggle.onclick = () => host.showPreview(!text.hidden);
  host.openDraft = seed => planDraftDialog(seed ?? (row.plan_template || row.has_agenda ? "" : text.value), {row, host});
  host.querySelector("[data-plan-ai]").onclick = () => host.openDraft();
  if (row.has_agenda) host.showPreview(true);
  if (row.plan_template && !pending) host.openDraft();
}
