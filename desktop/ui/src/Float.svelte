<script>
  // One conversation in a floating window: what was said, what the agent is doing right now, and a composer.
  // Files dropped from Finder come in as paths (the agents run on this Mac and read them where they are).
  import { onMount, tick } from "svelte";
  import { api, uid, page } from "./lib/api.js";
  import { post, onNative } from "./lib/native.js";
  import { md, trace } from "./lib/md.js";

  let key = $state(page.key || null);
  let title = $state("");
  let turns = $state([]);
  let draft = $state("");
  let files = $state([]);
  let agents = $state([]);
  let agent = $state(localStorage.getItem("pgad_agent") || "auto");
  let sending = $state(false);
  let run = $state(null);                       // the agent's run for this conversation, while it works
  let error = $state("");
  let dragging = $state(false);
  let scroller, box;
  let since = 0;

  const report = () => post("state", { key: key || "", title });
  const nearBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  async function toBottom(force) { const stick = force || nearBottom(); await tick(); if (stick && scroller) scroller.scrollTop = scroller.scrollHeight; }

  async function load(force) {
    if (!key) return;
    try {
      const r = await api(`/v1/users/${uid}/chats/${encodeURIComponent(key)}`);
      const changed = (r.turns || []).length !== turns.length || r.title !== title;
      turns = r.turns || []; error = "";
      title = r.title || title || String(turns.find((t) => t.role === "user")?.text || "").replace(/\s+/g, " ").slice(0, 40);
      if (changed || force) { report(); toBottom(force); }
    } catch (e) { if (!String(e.message).includes("404")) error = e.message; }
  }

  // what is running for this conversation (sent from here or anywhere else)
  async function watch() {
    if (!key) return;
    try {
      const xs = await api(`/v1/agents/live`);
      const mine = xs.filter((r) => String(r.tags?.conversation || "").endsWith(":" + key) && r.started * 1000 >= since - 3000).pop()
        || xs.filter((r) => r.running && String(r.tags?.conversation || "").endsWith(":" + key)).pop();
      const was = run?.running;
      run = mine && (mine.running || sending) ? mine : null;
      if (run) toBottom();
      if (was && !mine?.running && !sending) load(true);
    } catch {}
  }

  async function send() {
    const words = draft.trim();
    if ((!words && !files.length) || sending) return;
    if (!key) key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const text = files.length ? `${words}\n\n${files.map((f) => "文件：" + f).join("\n")}`.trim() : words;
    const history = turns.slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
    turns = [...turns, { role: "user", text, at: new Date().toISOString() }];
    if (!title) title = words.slice(0, 40) || "文件";
    draft = ""; files = []; sending = true; error = ""; since = Date.now(); report(); toBottom(true);
    try {
      const r = await api(`/v1/users/${uid}/agents/ask`, { body: { text, agent, conversation: key, history, refs: [], images: [], files: [], web: false } });
      if (r?.error && !r?.text) error = r.error;
    } catch (e) { error = e.message; }
    sending = false; run = null;
    await load(true);
  }

  async function stop() { if (run?.id) { try { await api(`/v1/agents/live/${run.id}/stop`, { method: "POST" }); } catch {} } }

  function keydown(e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  }
  function grow() { if (!box) return; box.style.height = "auto"; box.style.height = Math.min(220, box.scrollHeight) + "px"; }

  onNative("dropped", (paths) => { files = [...new Set([...files, ...paths])]; box?.focus(); });
  onNative("dragging", (on) => { dragging = on; });
  onNative("focus", () => box?.focus());

  onMount(() => {
    api(`/v1/agents`).then((r) => { agents = Object.keys(r?.agents || {}); }).catch(() => {});
    load(true); watch();
    const a = setInterval(() => { if (sending || run) watch(); }, 700);
    const b = setInterval(() => { if (!sending && !run && document.visibilityState === "visible") { load(); watch(); } }, 8000);
    return () => { clearInterval(a); clearInterval(b); };
  });
  $effect(() => { localStorage.setItem("pgad_agent", agent); });

  const live = $derived(run ? trace(run.text) : null);
  const secs = (t) => (t?.how?.seconds ? `${Math.round(t.how.seconds)}s` : "");
</script>

<div class="float" class:dragging>
  <div class="talk" bind:this={scroller}>
    {#if !turns.length && !sending}
      <div class="hello">
        <b>问点什么</b>
        <span>Enter 发送，Shift+Enter 换行。把访达里的文件拖进来，agent 会按路径去读。</span>
      </div>
    {/if}
    {#each turns as t, i (i)}
      {#if t.role === "user"}
        <div class="you">{t.text}</div>
      {:else}
        <div class="agent">
          <div class="who">{t.agent || "agent"}{t.model ? " · " + t.model : ""}{secs(t) ? " · " + secs(t) : ""}</div>
          {#if t.error && !t.text}<div class="err">{t.error}</div>{:else}<div class="md">{@html md(t.text)}</div>{/if}
        </div>
      {/if}
    {/each}
    {#if sending || run}
      <div class="agent working">
        <div class="who"><i class="spin"></i>{run?.agent || "正在找 agent"}{run ? ` · ${Math.round(run.elapsed_s || 0)}s` : ""}
          {#if run?.running}<button class="stop" onclick={stop}>停止</button>{/if}</div>
        {#if live?.steps.length}
          <ul class="steps">
            {#each live.steps.slice(-4) as s, i (i)}<li class:now={i === Math.min(3, live.steps.length - 1)}><em>{s.tool}</em> {s.target}</li>{/each}
          </ul>
        {/if}
        {#if live?.words}<div class="md">{@html md(live.words)}</div>{/if}
      </div>
    {/if}
    {#if error}<div class="err">{error}</div>{/if}
  </div>

  <div class="composer">
    {#if files.length}
      <div class="files">
        {#each files as f (f)}<span class="chip" title={f}>📎 {f.split("/").pop()}<button onclick={() => (files = files.filter((x) => x !== f))}>×</button></span>{/each}
      </div>
    {/if}
    <textarea bind:this={box} bind:value={draft} rows="1" placeholder="写点什么…" onkeydown={keydown} oninput={grow}></textarea>
    <div class="bar">
      <select bind:value={agent} title="交给哪个 agent">
        <option value="auto">自动</option>
        {#each agents as a (a)}<option value={a}>{a}</option>{/each}
      </select>
      <span class="grow"></span>
      <button class="send" onclick={send} disabled={sending || (!draft.trim() && !files.length)}>{sending ? "…" : "发送"}</button>
    </div>
  </div>
  {#if dragging}<div class="drop">松手：把文件交给这段对话</div>{/if}
</div>

<style>
  .float { height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; position: relative; }
  .talk { overflow-y: auto; padding: 6px 14px 12px; display: flex; flex-direction: column; gap: 12px; }
  .hello { margin: auto 0; display: grid; gap: 4px; color: var(--muted); font-size: 13px; padding: 0 4px; }
  .hello b { color: var(--text); font-size: 15px; font-weight: 600; }
  .you { align-self: flex-end; max-width: 88%; background: var(--user); padding: 7px 11px; border-radius: 14px 14px 4px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .agent { max-width: 100%; }
  .who { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); margin-bottom: 2px; }
  .stop { margin-left: auto; font-size: 11.5px; color: var(--danger); padding: 1px 8px; border: 1px solid var(--line); border-radius: 8px; }
  .steps { list-style: none; margin: 2px 0 6px; padding: 0; font-size: 12px; color: var(--muted); }
  .steps li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .65; } .steps li.now { opacity: 1; }
  .steps em { font-style: normal; color: var(--accent); }
  .spin { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--accent); border-right-color: transparent; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: var(--danger); font-size: 13px; }
  .composer { margin: 0 10px 10px; padding: 8px 10px 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 6px 20px rgba(0,0,0,.08); }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  textarea { width: 100%; border: 0; outline: none; resize: none; background: transparent; padding: 2px 2px; line-height: 1.55; max-height: 220px; display: block; }
  .bar { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .grow { flex: 1; }
  select { border: 0; background: var(--soft); border-radius: 8px; padding: 3px 6px; font-size: 12px; color: var(--muted); max-width: 140px; }
  .send { padding: 4px 14px; border-radius: 10px; background: var(--accent); color: white; font-size: 13px; }
  .send:disabled { opacity: .4; cursor: default; }
  .files { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; background: var(--soft); border-radius: 8px; padding: 2px 4px 2px 8px; max-width: 100%; }
  .chip button { color: var(--dim); padding: 0 4px; }
  .drop { position: absolute; inset: 6px; border: 2px dashed var(--accent); border-radius: 14px; display: grid; place-items: center; color: var(--accent);
    background: color-mix(in srgb, var(--bg) 85%, transparent); font-size: 13px; pointer-events: none; }
</style>
