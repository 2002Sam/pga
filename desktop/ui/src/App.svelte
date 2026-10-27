<script>
  import { page, uid } from "./lib/api.js";
  import Home from "./Home.svelte";
  import Float from "./Float.svelte";
</script>

{#if !uid}
  <p class="none">没有账号：在 ~/Library/Application Support/PGA Desktop/config.json 里填上 uid。</p>
{:else if page.mode === "float"}
  <Float />
{:else}
  <Home />
{/if}

<style>
  .none { padding: 24px; color: var(--muted); }
</style>
