<script>
  // Every conversation, newest first. A click floats it out over the desktop.
  import { onMount } from "svelte";
  import { api, uid, ago } from "./lib/api.js";
  import { post } from "./lib/native.js";

  let chats = $state([]);
  let q = $state("");
  let error = $state("");
  const shown = $derived(q ? chats.filter((c) => (c.title + " " + (c.last || "")).toLowerCase().includes(q.toLowerCase())) : chats);

  async function load() {
    try { chats = (await api(`/v1/users/${uid}/chats?limit=300`)) || []; error = ""; }
    catch (e) { error = e.message; }
  }
  onMount(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); });
</script>

<div class="home">
  <header>
    <h1>所有对话</h1>
    <span class="n">{chats.length}</span>
    <span class="grow"></span>
    <button class="new" onclick={() => post("new")}>＋ 新对话 <kbd>⌥ Space</kbd></button>
  </header>
  <input class="q" placeholder="搜对话…" bind:value={q} />
  {#if error}<p class="err">连不上 PGA：{error}</p>{/if}
  <div class="list">
    {#each shown as c (c.key)}
      <button class="row" onclick={() => post("open", { key: c.key, title: c.title })} title="点一下，浮出到桌面最上层">
        <b>{c.title || "新对话"}</b>
        <span class="last">{(c.last || "").replace(/[*`#>]+/g, "").replace(/\s+/g, " ").slice(0, 120)}</span>
        <span class="meta">{[c.agent, ago(c.last_at)].filter(Boolean).join(" · ")}</span>
      </button>
    {:else}
      {#if !error}<p class="dim">{q ? "没有找到" : "还没有对话"}</p>{/if}
    {/each}
  </div>
</div>

<style>
  .home { height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr); padding: 34px 20px 0; gap: 10px; }
  header { display: flex; align-items: baseline; gap: 8px; -webkit-user-select: none; user-select: none; }
  h1 { font-size: 18px; margin: 0; } .n { color: var(--dim); font-size: 12px; } .grow { flex: 1; }
  .new { padding: 6px 12px; border-radius: 10px; background: var(--accent); color: white; font-size: 13px; }
  kbd { font: 11px ui-monospace, monospace; opacity: .75; margin-left: 4px; }
  .q { width: 100%; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); outline: none; }
  .q:focus { border-color: var(--accent); }
  .list { overflow-y: auto; padding-bottom: 16px; }
  .row { display: grid; width: 100%; text-align: left; padding: 9px 10px; border-radius: 10px; gap: 1px; }
  .row:hover { background: var(--soft); }
  .row b { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .last { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { color: var(--dim); font-size: 11.5px; }
  .err { color: var(--danger); } .dim { color: var(--dim); }
</style>
