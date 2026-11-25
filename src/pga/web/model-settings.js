/* ---------------------------------------------------------------- settings → models & API (standardized harness pipeline) */
const MTYPE = {
  openai: "OpenAI 兼容（/chat/completions）",
  anthropic: "Anthropic Messages API",
  claude_cli: "Claude Code CLI（官方 Harness）",
  gemini_cli: "Gemini CLI（官方 Harness）",
  fake: "离线假模型（测试）",
};
const MTIER = {
  1: ["一档 · 轻量", "分类 / 日常"],
  2: ["二档 · 标准", "默认主力"],
  3: ["三档 · 高级", "深度研究"],
};
const MAPPROVAL = [
  ["default", "每次确认（default）"],
  ["auto_edit", "自动编辑（auto_edit）"],
  ["yolo", "完全放行（yolo）"],
];
const MCATS = [
  ["serious", "严肃问题"],
  ["code", "代码"],
  ["quick", "日常快速"],
  ["office", "办公"],
];
const M = { data: null, edit: null, keys: {}, hermes: null, models: {}, probes: {}, tested: {} };

function mIsHarness(type) {
  return (M.data?.harness_types || ["gemini_cli", "claude_cli"]).includes(type);
}
function mDefaultHarness(type, p = {}) {
  const pr = M.data?.presets?.[type]?.harness || {};
  const fallbackBin = type === "gemini_cli" ? "gemini" : "claude";
  const fallbackAgent = type === "gemini_cli" ? "gemini" : "claude";
  const fallbackAdapter = type === "gemini_cli" ? "gemini_local" : "claude_local";
  return {
    enabled: pr.enabled ?? true,
    agent_id: pr.agent_id || fallbackAgent,
    adapter: pr.adapter || fallbackAdapter,
    role: pr.role || p.name || fallbackAgent,
    command: p.command || pr.command || fallbackBin,
    approval_mode: pr.approval_mode || "auto_edit",
    sandbox: !!pr.sandbox,
    mcp: pr.mcp ?? true,
    capabilities: Array.isArray(pr.capabilities) ? [...pr.capabilities] : ["research", "review", "code", "general"],
    categories: Array.isArray(pr.categories) ? [...pr.categories] : ["serious", "code"],
    timeout_s: pr.timeout_s || 600,
    max_turns: pr.max_turns || 30,
    max_concurrent: pr.max_concurrent || 3,
  };
}
function mEnsureHarness(p) {
  if (!mIsHarness(p?.type)) return null;
  if (!p.harness || typeof p.harness !== "object") p.harness = mDefaultHarness(p.type, p);
  if (!p.command) p.command = p.harness.command || (p.type === "gemini_cli" ? "gemini" : "claude");
  return p.harness;
}
function mAddProvider(presetKey) {
  const d = M.data;
  if (!d) return;
  const base = presetKey === "__new" ? "custom" : presetKey;
  let id = base, n = 2;
  while (d.providers[id]) id = base + "-" + n++;
  const pr = d.presets[base] || d.presets.custom;
  d.providers[id] = {
    name: pr.name,
    type: pr.type,
    base_url: pr.base_url || "",
    key_env: pr.key_env || "",
    command: pr.command || "",
    tiers: Object.assign({}, pr.tiers || {}),
    ...(pr.harness ? { harness: JSON.parse(JSON.stringify(pr.harness)) } : {}),
    key_set: false,
    key_hint: "",
  };
  M.edit = id;
  renderModels();
  if (mIsHarness(pr.type)) {
    mStatus("已添加官方 CLI 通道，正在探测本机 Harness 环境…", "");
    mProbe(id);
  } else {
    mStatus("已添加，填好后点「保存」", "");
  }
}

async function loadModels() {
  const box = $("#modelsBox");
  try { M.data = await api("/v1/models"); } catch (e) { box.innerHTML = `<p class="small muted">读取失败：${esc(e.message)}</p>`; return; }
  if (!M.data.providers[M.edit]) M.edit = M.data.model.provider;
  M.keys = {};
  M.probes = {};
  for (const [pid, p] of Object.entries(M.data.providers || {})) {
    if (p.pipeline) M.probes[pid] = p.pipeline;
  }
  try { M.hermes = await api("/v1/models/hermes"); } catch { M.hermes = null; }
  renderModels();
}
function mStatus(text, cls = "") { const el = $("#mStatus"); if (el) { el.textContent = text; el.className = "m-status " + cls; } }

function renderPipeline(id, p) {
  const h = mEnsureHarness(p);
  const probe = M.probes[id] || p.pipeline || {};
  const tiers = p.tiers || {};
  const step1Ok = Boolean(p.name && (tiers[1] || tiers[2] || tiers[3]));
  const cliOk = Boolean(probe.cli_found);
  const authOk = Boolean(probe.auth_ready || p.key_set || (p.key_env && M.keys[p.key_env]));
  const step2Ok = cliOk && authOk;
  const tested = M.tested[id];
  const step3Ok = Boolean(tested?.ok);
  const step4Ok = Boolean(probe.agent_synced);
  const cats = new Set(Array.isArray(h.categories) ? h.categories : []);
  const cls = (ok, warn = false) => (ok ? "ok" : warn ? "warn" : "");
  return `
    <section class="m-pipeline" aria-label="标准化 Harness 接入流水线">
      <div class="m-pipe-head">
        <strong>标准化接入流水线 · ${esc(p.type === "gemini_cli" ? "Gemini CLI" : "Claude Code CLI")}</strong>
        <span class="m-pipe-sub">${step4Ok ? `已接入 Agent 池（${esc(probe.agent_id || h.agent_id)}）` : "配置 → 探测 → 测试 → 一键同步到 PGA Agent 池"}</span>
      </div>
      <ol class="m-pipe-steps">
        <li class="m-pipe-step ${cls(step1Ok)}"><b>1. 通道与档位</b><span>${step1Ok ? esc(tiers[2] || tiers[1] || tiers[3]) : "待填写模型"}</span></li>
        <li class="m-pipe-step ${cls(step2Ok, !cliOk || !authOk)}"><b>2. CLI 与凭据</b><span>${cliOk ? (probe.version || "已检测到 CLI") : "未检测到命令"}${authOk ? " · 凭据就绪" : " · 待登录/填 Key"}</span></li>
        <li class="m-pipe-step ${cls(step3Ok, tested && !tested.ok)}"><b>3. 连通测试</b><span>${tested ? (tested.ok ? `通过 · ${tested.ms}ms` : "测试未通过") : "点击「测试连接」"}</span></li>
        <li class="m-pipe-step ${cls(step4Ok)}"><b>4. 接入 PGA</b><span>${step4Ok ? `已同步 · ${esc((probe.agent_categories || []).join(" / ") || h.agent_id)}` : "待同步至 agents.yaml"}</span></li>
      </ol>
      ${!cliOk && probe.install_hint ? `<div class="m-pipe-hint">未在本机找到 <code>${esc(probe.command || h.command)}</code>，可先运行 <code>${esc(probe.install_hint)}</code>，或在下方填写 CLI 绝对路径后点「探测环境」。</div>` : ""}
      ${cliOk && !authOk ? `<div class="m-pipe-hint">${esc(probe.auth_detail || "请填写 API Key，或在终端完成官方 CLI 登录。")}</div>` : ""}
      <div class="m-harness">
        <label class="mf"><span>CLI 命令 / 路径</span><input type="text" data-mh="command" value="${esc(h.command || p.command || "")}" placeholder="${p.type === "gemini_cli" ? "gemini 或 /opt/homebrew/bin/gemini" : "claude"}" spellcheck="false"></label>
        <label class="mf"><span>Agent 池 ID <small>agents.yaml</small></span><input type="text" data-mh="agent_id" value="${esc(h.agent_id || "")}" placeholder="${p.type === "gemini_cli" ? "gemini" : "claude"}" spellcheck="false"></label>
        <label class="mf"><span>Harness 审批模式</span><select data-mh="approval_mode">${MAPPROVAL.map(([v, lbl]) => `<option value="${v}" ${v === h.approval_mode ? "selected" : ""}>${esc(lbl)}</option>`).join("")}</select></label>
        <label class="mf"><span>角色名称 <small>对话栏显示</small></span><input type="text" data-mh="role" value="${esc(h.role || "")}" placeholder="Gemini CLI · 官方 Harness"></label>
        <label class="mf"><span>超时（秒）</span><input type="number" min="30" max="7200" data-mh="timeout_s" value="${esc(h.timeout_s ?? 600)}"></label>
        <label class="mf"><span>最大并发数</span><input type="number" min="1" max="16" data-mh="max_concurrent" value="${esc(h.max_concurrent ?? 3)}"></label>
        <div class="mf wide m-checks">
          <span>Harness 选项</span>
          <div class="m-check-row">
            <label><input type="checkbox" data-mhb="enabled" ${h.enabled !== false ? "checked" : ""}> 同步启用到 Agent 池</label>
            <label><input type="checkbox" data-mhb="sandbox" ${h.sandbox ? "checked" : ""}> 启用沙箱（-s）</label>
            <label><input type="checkbox" data-mhb="mcp" ${h.mcp !== false ? "checked" : ""}> 允许 MCP</label>
          </div>
        </div>
        <div class="mf wide m-checks">
          <span>接入 PGA 路由分类（自动加入对应任务池）</span>
          <div class="m-check-row">
            ${MCATS.map(([ck, lbl]) => `<label><input type="checkbox" data-mhcat="${ck}" ${cats.has(ck) ? "checked" : ""}> ${esc(lbl)}</label>`).join("")}
          </div>
        </div>
      </div>
    </section>`;
}

function renderModels() {
  const d = M.data, act = d.model.provider, id = M.edit, p = d.providers[id] || {};
  const presets = Object.entries(d.presets).filter(([k]) => !d.providers[k]).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("");
  const isHarness = mIsHarness(p.type);
  const needsUrl = p.type === "openai" || p.type === "anthropic";
  const needsKey = p.type === "openai" || p.type === "anthropic" || p.type === "gemini_cli";
  const hasGemini = Object.values(d.providers).some((x) => x.type === "gemini_cli");
  const list = M.models[id] || p.models || [];
  const h = M.hermes && M.hermes.found ? M.hermes : null, hp = h ? Object.keys(h.providers || {}) : [];
  const keyPlaceholder = p.key_set ? "留空 = 保持不变" : (p.type === "gemini_cli" ? "留空 = 使用本机 Google 登录" : "粘贴密钥");
  $("#modelsBox").innerHTML = `
    <div class="m-top-bar">
      <label class="m-add-provider"><strong>＋ 添加通道</strong> <select data-madd aria-label="添加通道"><option value="">选择服务商…</option>${presets}<option value="__new">空白 · OpenAI 兼容</option></select></label>
      ${!hasGemini && d.presets?.gemini_cli ? `<button type="button" class="small m-quick-add" data-mquick="gemini_cli">✦ 一键接入 Gemini CLI（官方 Harness）</button>` : ""}
    </div>
    <div class="m-chips">${Object.keys(d.providers).map((k) => {
      const pv = d.providers[k];
      const badge = mIsHarness(pv.type) && (M.probes[k]?.agent_synced || pv.pipeline?.agent_synced) ? `<em class="m-chip-pipe">Harness</em>` : "";
      return `<button type="button" class="m-chip ${k === id ? "on" : ""} ${k === act ? "act" : ""}" data-mp="${esc(k)}">${esc(pv.name || k)}${badge}${k === act ? "<i>使用中</i>" : ""}</button>`;
    }).join("")}
</div>
    <div class="m-card">
      <div class="m-form">
        <label class="mf"><span>名称</span><input type="text" data-mf="name" value="${esc(p.name || "")}"></label>
        <label class="mf"><span>接口类型</span><select data-mf="type">${d.types.map((t) => `<option value="${t}" ${t === p.type ? "selected" : ""}>${MTYPE[t] || t}</option>`).join("")}</select></label>
        ${needsUrl ? `<label class="mf wide"><span>base_url${p.type === "anthropic" ? "<small>留空 = 官方地址</small>" : ""}</span><input type="text" data-mf="base_url" value="${esc(p.base_url || "")}" placeholder="https://…/v1" spellcheck="false"></label>` : ""}
        ${needsKey ? `<label class="mf"><span>环境变量名 <small>.env</small></span><input type="text" data-mf="key_env" value="${esc(p.key_env || "")}" placeholder="${p.type === "gemini_cli" ? "GEMINI_API_KEY" : "MY_PROVIDER_API_KEY"}" spellcheck="false"></label>
        <label class="mf"><span>API Key ${p.key_set ? `<em>已设置 ${esc(p.key_hint)}</em>` : `<em>${p.type === "gemini_cli" ? "可选 · 留空走本机登录" : p.key_env ? "未设置" : "本机服务可留空"}</em>`}</span><input type="password" data-mkey placeholder="${keyPlaceholder}" autocomplete="off" spellcheck="false" value="${esc(M.keys[p.key_env] || "")}"></label>` : ""}
        <div class="m-tiers">${[1, 2, 3].map((t) => `<label class="mf"><span>${MTIER[t][0]}<small>${MTIER[t][1]}</small></span><input type="text" data-mt="${t}" list="mlist" value="${esc((p.tiers || {})[t] || "")}" placeholder="模型 id" spellcheck="false"></label>`).join("")}</div>
        <datalist id="mlist">${list.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      </div>
    </div>
    ${isHarness ? renderPipeline(id, p) : ""}
    <div class="actions">
      ${id !== act ? `<button type="button" class="small" data-mact="use">设为使用中</button>` : ""}
      ${isHarness ? `<button type="button" class="small" data-mact="probe">探测环境</button>` : ""}
      <button type="button" class="small" data-mact="test">测试连接</button>
      ${p.type !== "fake" ? `<button type="button" class="ghost small" data-mact="discover">获取模型列表</button>` : ""}
      ${id !== act ? `<button type="button" class="ghost small" data-mact="remove">删除此通道</button>` : ""}
      <span class="grow"></span>
      ${isHarness ? `<button type="button" class="ghost small" data-mact="save">仅保存</button><button type="button" class="small primary" data-mact="sync">保存并接入流水线</button>` : `<button type="button" class="small primary" data-mact="save">保存</button>`}
    </div>
    <div class="m-status" id="mStatus">${d.configured ? "" : "还没有 models.yaml：当前显示 policy.yaml 默认配置，点击「保存」后生成。"}</div>
    ${h ? `<div class="m-hermes">检测到 Hermes Agent 配置（<span class="mono">~/.hermes/config.yaml</span>）：主模型 <b>${esc(h.model.default || "—")}</b> · 通道 <b>${esc(h.model.provider || "—")}</b>${h.model.api_mode ? `（${esc(h.model.api_mode)}，需 Hermes 自己的登录，不能直接用）` : ""}。
      ${hp.length ? `可导入的 OpenAI 兼容通道：<b>${hp.map(esc).join("、")}</b>。
      <div class="actions"><button type="button" class="ghost small" data-mact="hermes">导入这些通道</button>
      <label class="m-hermes-check"><input type="checkbox" id="mHermesKeys"> 同时把对应密钥复制到 PGA 的 .env</label></div>` : "没有可导入的自定义通道。"}</div>` : ""}
    <div class="m-file mono">${esc(d.file)}</div>`;
}
function mCurrent() {                                                     // the provider being edited, without display-only fields
  const p = Object.assign({}, M.data.providers[M.edit]);
  delete p.key_set; delete p.key_hint; delete p.pipeline;
  return p;
}
function mBody() {
  const d = M.data, providers = {};
  for (const [k, v] of Object.entries(d.providers)) {
    const c = Object.assign({}, v);
    delete c.key_set; delete c.key_hint; delete c.pipeline;
    providers[k] = c;
  }
  const act = providers[d.model.provider] || {};
  return { model: { provider: d.model.provider, default: (act.tiers || {})[2] || "", tiers: act.tiers || {} }, providers, keys: M.keys };
}
async function mRefreshAfterChange() {
  window.refreshProvider?.();
  try {
    if (typeof loadAgents === "function") await loadAgents();
    else if (typeof S === "object" && S) {
      const av = await api("/v1/agents");
      if (av?.agents) {
        S.agents = Object.entries(av.agents).map(([name, cfg]) => ({ name, ...cfg, ...(av.status?.[name] || {}) }));
        S.agentOpts = {};
      }
    }
  } catch {}
}
async function mSave(msg = "已保存") {
  try {
    M.data = await api("/v1/models", { method: "PUT", body: mBody() });
    M.keys = {};
    for (const [pid, p] of Object.entries(M.data.providers || {})) if (p.pipeline) M.probes[pid] = p.pipeline;
    renderModels();
    mStatus(msg, "ok");
    mRefreshAfterChange();
    return true;
  } catch (e) { mStatus("保存失败：" + e.message, "bad"); return false; }
}
async function mProbe(id = M.edit) {
  const p = M.data?.providers?.[id];
  if (!p || !mIsHarness(p.type)) return;
  const clean = Object.assign({}, p);
  delete clean.key_set; delete clean.key_hint; delete clean.pipeline;
  try {
    const r = await api("/v1/models/pipeline/probe", { body: { id, provider: clean, key: M.keys[clean.key_env] || undefined } });
    M.probes[id] = r;
    renderModels();
    if (r.cli_found) mStatus(`已检测到 ${r.exe}${r.version ? `（${r.version}）` : ""} · ${r.auth_detail}`, r.auth_ready ? "ok" : "");
    else mStatus(`未找到 ${r.command}：可先执行 ${r.install_hint}，或填写 CLI 路径`, "bad");
  } catch (err) {
    mStatus("探测失败：" + err.message, "bad");
  }
}
async function mSyncPipeline() {
  const id = M.edit;
  const p = mCurrent();
  if (!mIsHarness(p.type)) return mSave();
  mStatus("正在保存配置并同步到 Agent 池（agents.yaml）…");
  try {
    const res = await api("/v1/models/pipeline/sync", { method: "POST", body: { id, ...mBody() } });
    const sync = res.sync || {};
    delete res.sync;
    M.data = res;
    M.keys = {};
    for (const [pid, pv] of Object.entries(M.data.providers || {})) if (pv.pipeline) M.probes[pid] = pv.pipeline;
    renderModels();
    mStatus(`已接入 PGA 流水线：Agent「${sync.agent_id || id}」（${sync.adapter || ""}）已写入 agents.yaml${sync.categories?.length ? ` · 分类：${sync.categories.join("、")}` : ""}`, "ok");
    mRefreshAfterChange();
    return true;
  } catch (err) {
    mStatus("接入失败：" + err.message, "bad");
    return false;
  }
}

function bindModels() {
  const box = $("#modelsBox");
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) e.preventDefault(); });   // Enter would close the dialog
  box.addEventListener("input", (e) => {
    const el = e.target, p = M.data?.providers[M.edit]; if (!p) return;
    if (el.dataset.mf && el.tagName === "INPUT") p[el.dataset.mf] = el.value.trim();
    if (el.dataset.mt) { p.tiers = Object.assign({}, p.tiers); if (el.value.trim()) p.tiers[el.dataset.mt] = el.value.trim(); else delete p.tiers[el.dataset.mt]; }
    if (el.dataset.mh) {
      const h = mEnsureHarness(p);
      if (h) {
        const k = el.dataset.mh;
        if (k === "timeout_s" || k === "max_concurrent" || k === "max_turns") h[k] = Number(el.value) || h[k];
        else h[k] = el.value.trim();
        if (k === "command") p.command = h.command;
      }
    }
    if (el.hasAttribute("data-mkey")) {
      if (!p.key_env) { p.key_env = M.edit.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY"; const k = box.querySelector('[data-mf="key_env"]'); if (k) k.value = p.key_env; }
      M.keys[p.key_env] = el.value.trim(); if (!el.value.trim()) delete M.keys[p.key_env];
    }
  });
  box.addEventListener("change", (e) => {
    const el = e.target, d = M.data; if (!d) return;
    const p = d.providers[M.edit];
    if (el.dataset.mf === "type" && p) {
      p.type = el.value;
      if (mIsHarness(p.type)) {
        mEnsureHarness(p);
        if (p.type === "gemini_cli" && !p.key_env) p.key_env = "GEMINI_API_KEY";
      }
      renderModels();
      if (mIsHarness(p.type)) mProbe(M.edit);
      return;
    }
    if (el.dataset.mh && p) {
      const h = mEnsureHarness(p);
      if (h) h[el.dataset.mh] = el.value;
      return;
    }
    if (el.dataset.mhb && p) {
      const h = mEnsureHarness(p);
      if (h) h[el.dataset.mhb] = Boolean(el.checked);
      return;
    }
    if (el.dataset.mhcat && p) {
      const h = mEnsureHarness(p);
      if (h) {
        const set = new Set(Array.isArray(h.categories) ? h.categories : []);
        if (el.checked) set.add(el.dataset.mhcat); else set.delete(el.dataset.mhcat);
        h.categories = [...set];
      }
      return;
    }
    if (el.hasAttribute("data-madd") && el.value) mAddProvider(el.value);
  });
  box.addEventListener("click", async (e) => {
    const quick = e.target.closest("[data-mquick]");
    if (quick) { mAddProvider(quick.dataset.mquick); return; }
    const chip = e.target.closest("[data-mp]"); if (chip) { M.edit = chip.dataset.mp; renderModels(); return; }
    const b = e.target.closest("[data-mact]"); if (!b) return;
    const act = b.dataset.mact, d = M.data, p = mCurrent();
    if (act === "save") return mSave();
    if (act === "sync") { b.disabled = true; try { await mSyncPipeline(); } finally { b.disabled = false; } return; }
    if (act === "probe") { b.disabled = true; try { await mProbe(M.edit); } finally { b.disabled = false; } return; }
    if (act === "use") { const prev = d.model.provider; d.model.provider = M.edit; if (!(await mSave(`已切换到 ${p.name || M.edit}`))) d.model.provider = prev; return; }
    if (act === "remove") { delete d.providers[M.edit]; M.edit = d.model.provider; return mSave("已删除通道"); }
    if (act === "test") {
      const model = (p.tiers || {})[1] || (p.tiers || {})[2] || (p.tiers || {})[3];
      if (!model && p.type !== "fake") return mStatus("先填一个模型 id", "bad");
      mStatus(`正在用 ${model || "fake"} 测试…`); b.disabled = true;
      try {
        const r = await api("/v1/models/test", { body: { id: M.edit, provider: p, model, key: M.keys[p.key_env] || undefined } });
        M.tested[M.edit] = r;
        renderModels();
        mStatus(r.ok ? `连接正常 · ${r.ms} ms · ${r.model} 回复「${r.reply}」` : `连接失败：${r.error}`, r.ok ? "ok" : "bad");
      } catch (err) {
        M.tested[M.edit] = { ok: false, error: err.message };
        renderModels();
        mStatus("连接失败：" + err.message, "bad");
      } finally { b.disabled = false; }
    }
    if (act === "discover") {
      mStatus("正在获取模型列表…"); b.disabled = true;
      try { const r = await api("/v1/models/discover", { body: { id: M.edit, provider: p, key: M.keys[p.key_env] || undefined } }); M.models[M.edit] = r.models; const keep = Object.assign({}, M.keys); renderModels(); M.keys = keep; mStatus(`找到 ${r.models.length} 个模型，在三档输入框里可直接选`, "ok"); }
      catch (err) { mStatus(err.message, "bad"); } finally { b.disabled = false; }
    }
    if (act === "hermes") {
      try { M.data = await api(`/v1/models/hermes/import?copy_keys=${$("#mHermesKeys")?.checked ? "true" : "false"}`, { method: "POST" }); renderModels(); mStatus("已从 Hermes 导入通道（使用中的通道没有改变）", "ok"); }
      catch (err) { mStatus("导入失败：" + err.message, "bad"); }
    }
  });
}

function openModelSettings() {
  const dialog = $("#modelSettings");
  if (!dialog.dataset.bound) { bindModels(); dialog.dataset.bound = "1"; }
  $("#modelsBox").textContent = L("正在读取配置…", "Loading settings…");
  dialog.showModal();
  loadModels();
}

if (location.hash === "#model-settings" && $("#modelSettings")) openModelSettings();
