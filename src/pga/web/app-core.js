/* PGA app · state, the API, text helpers. Plain scripts sharing one global scope, loaded in order by app.html. */
const $ = (s, el = document) => el.querySelector(s);
const esc = PGATree.esc;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const Q = new URLSearchParams(location.search), AS_UID = Q.get("as");
const EMBED = !!Q.get("embed");   // a conversation in a window on the stage: its side rail is never shown (html.embed .rail: display none)
const LANG = Q.get("lang") || store.get("pga_lang") || "zh", EN = LANG === "en";
PGATree.setLang(LANG); document.documentElement.lang = EN ? "en" : "zh-CN";
const L = (zh, en) => (EN ? en : zh);
const S = { uid: AS_UID || store.get("pga_uid"), view: (Q.get("view") === "canvas" ? "stage" : Q.get("view")) || (Q.get("tree") ? "tree" : "stage"), aim: Q.get("tree"), node: Q.get("node"),
  mode: store.get("pga_tree_mode") || "thought", dir: store.get("pga_tree_dir") || "down", beh: {}, contRefs: [], bud: null, tree: null, detail: {}, tab: store.get("pga_drawer_tab") || "overview",
  drawer: false, search: "", seen: new Set(), agents: [], sending: false, op: null, showHidden: false, forest: null, draft: "", proc: null, live: [],
  chats: null, chat: Q.get("c"), chatTurns: {}, chatDraft: "", chatRefs: [], chatAgent: Q.get("agent") || store.get("pga_chat_agent") || "auto", planting: false };
/* Explicit choices belong to a conversation, never to the other open windows. */
const conversationDefaultAgent = S.chatAgent;
function chatChoiceKey() { return S.lineView ? S.lineTarget || '' : S.chat || S.imp?.key || ''; }
function chatChoiceStorage(key) { return 'pga_chat_choice:' + S.uid + ':' + key; }
function chatChoiceRead(key) {
  if (S.chatChoices?.[key]) return S.chatChoices[key];
  try { const p = JSON.parse(store.get(chatChoiceStorage(key)) || 'null');
    if (p && ['agent','model','effort'].every(k => typeof p[k] === 'string')) return p;
  } catch {}
  return null;
}
function chatChoiceSave(key = chatChoiceKey()) {
  const p = {agent: S.chatAgent || 'auto', model: S.chatModel?.[key] || '', effort: S.chatEffort?.[key] || ''};
  S.chatChoices = {...(S.chatChoices || {}), [key]: p};
  if (key) store.set(chatChoiceStorage(key), JSON.stringify(p));
  return p;
}
function chatChoiceRestore(key = chatChoiceKey()) {
  const p = chatChoiceRead(key) || S.chatLoadedChoices?.[key];
  if (p) {
    S.chatAgent = p.agent || 'auto';
    S.chatModel = {...(S.chatModel || {}), [key]: p.model || ''};
    S.chatEffort = {...(S.chatEffort || {}), [key]: p.effort || ''};
  } else if (S.chatChoiceActive !== key) S.chatAgent = conversationDefaultAgent;
  S.chatChoiceActive = key;
}
window.S = S;   // the stage reads each page's state (sending, chat) from outside its frame; a top-level const is not on window
const YOU = () => S.aim === "you";
const lq = (q) => (EN ? (q.includes("?") ? "&" : "?") + "lang=en" : "");
const treeApi = () => { const p = YOU() ? `/v1/users/${S.uid}/tree` : `/v1/aims/${S.aim}/tree`; return p + lq(p); };
const when = (iso) => iso ? new Date(iso).toLocaleString(EN ? "en-GB" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? L("刚刚", "just now") : s < 3600 ? L(`${Math.floor(s / 60)} 分钟前`, `${Math.floor(s / 60)}m ago`) : s < 86400 ? L(`${Math.floor(s / 3600)} 小时前`, `${Math.floor(s / 3600)}h ago`) : L(`${Math.floor(s / 86400)} 天前`, `${Math.floor(s / 86400)}d ago`); };
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 3400); }
/* The big lists every page refreshes (the forest, the chats, the time tree, the categories, the agents) are fetched once for
   the whole window: the stage and every conversation in a frame on it ask the top window, which fetches at most once per
   SHARED_MS and hands the same answer to all of them (when the server's answer did not change, the very same object, so a
   page can tell nothing changed). Anything that writes clears it, before and after, so what you just did shows at once. */
const SHARED_GET = /^\/v1\/(users\/[^/]+\/(forest|chats\?archived=true|timeline\?|conversation-projects$|console$)|agents$)/, SHARED_MS = 12000;
const pgaTop = (() => { try { const t = window.top; if (t !== window && t.location.origin === location.origin && t.__pgaShared) return t; } catch {} return window; })();
if (pgaTop === window) window.__pgaShared = (() => {
  const m = new Map();
  return {
    clear() { m.clear(); },
    get(path) {
      const e = m.get(path); if (e && (e.busy || Date.now() - e.at < SHARED_MS)) return e.p;
      const n = { at: Date.now(), busy: true, text: e?.text, data: e?.data };
      n.p = fetch(path).then(async (res) => {
        const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) throw new Error((data && (data.detail?.toString?.() || data.error)) || res.statusText);
        if (n.text === text) return n.data;                     // unchanged: the same object as last time
        n.text = text; n.data = data; return data;
      }).catch((err) => { m.delete(path); throw err; }).finally(() => { n.busy = false; n.at = Date.now(); });
      m.set(path, n); return n.p;
    },
  };
})();
async function api(path, opts = {}) {
  const method = opts.method || (opts.body ? "POST" : "GET");
  if (method === "GET" && SHARED_GET.test(path)) return pgaTop.__pgaShared.get(path);
  if (method !== "GET") pgaTop.__pgaShared?.clear();
  try {
    const res = await fetch(path, { method, headers: opts.body ? { "Content-Type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && (data.detail?.toString?.() || data.error)) || res.statusText);
    return data;
  } finally { if (method !== "GET") pgaTop.__pgaShared?.clear(); }
}
function localFileLink(href) {
  if (!href || href.startsWith("//") || href.startsWith("#")) return false;
  if (/^(file:|sandbox:|\/Users\/|\/tmp\/|\/private\/|\/mnt\/|~\/)/i.test(href)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(href) && /\.(pdf|docx?|rtf|odt|ods|odp|xlsx?|xlsm|pptx?|csv|tsv|txt|md|tex|png|jpe?g|gif|webp|svg|zip|py|js|ts|jsx|tsx|html|css|json|ya?ml|toml|xml|sql|swift|go|rs|cpp|java|sh|mjs|svelte|log|cjs|scss|less|vue|kt|rb|php|lua|scala|dart|cs|hpp|cc|c|h|zsh|bash|ini|cfg|conf|jsonl|ipynb|graphql|proto|bib|diff|patch)(?:[:#?]|$)/i.test(href);
}
let FILE_LINKS_ON = false;
function outputImage(href, title, alt = "", caption = "") {
  const local = localFileLink(href);
  if (!local && !/^(https?:\/\/|\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(href || "")) return esc(alt);
  const img = `<img class="pga-output-image" ${local ? `data-local-image="${esc(href)}"` : `src="${esc(href)}"`} alt="${esc(alt)}" loading="lazy" decoding="async">`;
  return `<a class="pga-image-link" href="${local ? "#" : esc(href)}" ${local ? `data-local-file="${esc(href)}"` : `data-zoom="${esc(href)}"`} title="${esc(title || alt || href)}">${img}<span class="pga-image-caption">${caption || esc(alt || L("查看图片", "View image"))}</span></a>`;
}
function fileLinkExtensions() {
  if (FILE_LINKS_ON) return;
  FILE_LINKS_ON = true;
  marked.use({ renderer: { link(href, title, text) {
    if (/\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(href || "") && !/<img\b/i.test(text || "")) return outputImage(href, title, "", text);
    if (!localFileLink(href)) return false;
    return `<a href="#" data-local-file="${esc(href)}" title="${esc(title || href)}">${text}</a>`;
  }, image(href, title, text) {
    // Keep the renderer valid inside a Markdown image link (no nested anchors).
    if (localFileLink(href)) return `<img class="pga-output-image" data-local-image="${esc(href)}" alt="${esc(text || "")}" title="${esc(title || text || href)}" loading="lazy" decoding="async">`;
    if (!/^(https?:\/\/|\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(href || "")) return esc(text || "");
    return `<img class="pga-output-image" src="${esc(href)}" alt="${esc(text || "")}" title="${esc(title || text || "")}" loading="lazy" decoding="async">`;
  } } });
}
const md = (t) => (window.marked && window.DOMPurify ? (fileLinkExtensions(), typeof mathExtensions === "function" && mathExtensions(), DOMPurify.sanitize(marked.parse(String(t || "").replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>"), { breaks: true, gfm: true }))) : esc(t));
const asq = AS_UID ? `?as=${encodeURIComponent(AS_UID)}` : "";
const qs = () => {
  const q = new URLSearchParams();
  if (S.view === "tree" && S.aim) { q.set("tree", S.aim); if (S.node) q.set("node", S.node); }
  if (S.view === "chats") { q.set("view", "chats"); if (S.chat) q.set("c", S.chat); }
  const manager = S.view === "chats" && window.pmProjectFor?.(S.chat);
  if (manager) q.set("manager", manager);
  if (["notes", "looks", "graph", "home"].includes(S.view)) q.set("view", S.view);
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const s = q.toString(); return s ? "?" + s : location.pathname;
};
document.querySelectorAll("[data-l]").forEach((el) => { const [zh, en] = el.dataset.l.split("|"); el.textContent = L(zh, en); });
PGAShell.mount($("#shell")); $("#toAgents").href = "/agents" + asq; $("#home").href = "/" + asq;

