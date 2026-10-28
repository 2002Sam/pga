<script>
  // A node window: something a conversation can read, wired into it from this window's right dot.
  // note: what you write here; file: a file on this Mac (drop another one on it, or pick one); skill, document,
  // world-tree topic: what it says.
  import { onMount } from "svelte";
  import { page } from "./lib/api.js";
  import { post, onNative } from "./lib/native.js";
  import { md } from "./lib/md.js";

  const type = page.type || "note";
  let data = $state({ ...(page.data || {}) });
  let dragging = $state(false);
  let box, t;

  function save(d) { data = { ...data, ...d }; clearTimeout(t); t = setTimeout(() => post("state", { data: d }), 350); }
  onNative("data", (d) => { data = { ...d }; });
  onNative("dragging", (on) => { dragging = on; });
  onNative("dropped", (paths) => { if (type === "file" && paths[0]) { const p = paths[0]; save({ path: p, title: p.split("/").pop() }); } });
  onNative("focus", () => box?.focus());
  onMount(() => { if (type === "note") box?.focus(); });

  const body = $derived(type === "skill" ? data.body || data.text || "" : data.text || "");
</script>

<div class="node t-{type}" class:dragging>
  {#if type === "note"}
    <textarea bind:this={box} value={data.text || ""} oninput={(e) => save({ text: e.target.value })}
      placeholder="写下要给 agent 的话…（从右边的点拉一根线到一个对话窗口）"></textarea>
  {:else if type === "file"}
    <div class="file">
      <b>{data.title || "还没选文件"}</b>
      <span class="path">{data.path || "把访达里的文件拖到这里，或者"}</span>
      <button onclick={() => post("pickFile")}>{data.path ? "换一个…" : "选一个…"}</button>
    </div>
  {:else}
    <div class="text">
      <b>{data.title || ""}</b>
      {#if body}<div class="md">{@html md(body.slice(0, 6000))}</div>{:else}<span class="dim">（没有内容）</span>{/if}
    </div>
  {/if}
  {#if dragging}<div class="drop">松手：换成这个文件</div>{/if}
</div>

<style>
  .node { height: 100%; position: relative; border-top: 2px solid var(--tc); }
  .t-note { --tc: #a1a1aa; } .t-file { --tc: #5fc9c0; } .t-skill { --tc: #e9b35f; } .t-doc { --tc: #7fcf9f; } .t-topic { --tc: #d6a75c; }
  textarea { width: 100%; height: 100%; border: 0; outline: none; resize: none; background: transparent; padding: 10px 16px 10px 14px; line-height: 1.6; font-size: 13.5px; }
  .file { display: grid; gap: 4px; padding: 12px 16px; align-content: start; }
  .file .path { font: 11.5px ui-monospace, Menlo, monospace; color: var(--muted); overflow-wrap: anywhere; }
  .file button { justify-self: start; margin-top: 4px; padding: 3px 10px; border-radius: 8px; background: var(--soft); font-size: 12px; }
  .text { height: 100%; overflow-y: auto; padding: 10px 16px 12px 14px; font-size: 12.5px; display: grid; gap: 6px; align-content: start; }
  .text b { font-size: 13px; } .dim { color: var(--dim); }
  .drop { position: absolute; inset: 4px; border: 2px dashed var(--tc); border-radius: 10px; display: grid; place-items: center; color: var(--tc); font-size: 12px; pointer-events: none;
    background: color-mix(in srgb, var(--bg) 85%, transparent); }
</style>
