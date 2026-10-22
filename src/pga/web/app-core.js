/* PGA app · state, the API, text helpers. Plain scripts sharing one global scope, loaded in order by app.html. */
const $ = (s, el = document) => el.querySelector(s);
const esc = PGATree.esc;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const Q = new URLSearchParams(location.search), AS_UID = Q.get("as");
const LANG = Q.get("lang") || store.get("pga_lang") || "zh", EN = LANG === "en";
PGATree.setLang(LANG); document.documentElement.lang = EN ? "en" : "zh-CN";
const L = (zh, en) => (EN ? en : zh);
const S = { uid: AS_UID || store.get("pga_uid"), view: Q.get("view") || (Q.get("tree") ? "tree" : "canvas"), aim: Q.get("tree"), node: Q.get("node"),
  mode: store.get("pga_tree_mode") || "thought", dir: store.get("pga_tree_dir") || "down", beh: {}, contRefs: [], bud: null, tree: null, detail: {}, tab: store.get("pga_drawer_tab") || "overview",
  drawer: false, search: "", seen: new Set(), agents: [], sending: false, op: null, showHidden: false, forest: null, draft: "", proc: null, live: [],
  chats: null, chat: Q.get("c"), chatTurns: {}, chatDraft: "", chatRefs: [], chatAgent: store.get("pga_chat_agent") || "auto", planting: false };
const YOU = () => S.aim === "you";
const lq = (q) => (EN ? (q.includes("?") ? "&" : "?") + "lang=en" : "");
const treeApi = () => { const p = YOU() ? `/v1/users/${S.uid}/tree` : `/v1/aims/${S.aim}/tree`; return p + lq(p); };
const when = (iso) => iso ? new Date(iso).toLocaleString(EN ? "en-GB" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? L("刚刚", "just now") : s < 3600 ? L(`${Math.floor(s / 60)} 分钟前`, `${Math.floor(s / 60)}m ago`) : s < 86400 ? L(`${Math.floor(s / 3600)} 小时前`, `${Math.floor(s / 3600)}h ago`) : L(`${Math.floor(s / 86400)} 天前`, `${Math.floor(s / 86400)}d ago`); };
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 3400); }
async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: opts.body ? { "Content-Type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && (data.detail?.toString?.() || data.error)) || res.statusText);
  return data;
}
const md = (t) => (window.marked && window.DOMPurify ? (typeof mathExtensions === "function" && mathExtensions(), DOMPurify.sanitize(marked.parse(String(t || "").replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>"), { breaks: true, gfm: true }))) : esc(t));
const asq = AS_UID ? `?as=${encodeURIComponent(AS_UID)}` : "";
const qs = () => {
  const q = new URLSearchParams();
  if (S.view === "tree" && S.aim) { q.set("tree", S.aim); if (S.node) q.set("node", S.node); }
  if (S.view === "chats") { q.set("view", "chats"); if (S.chat) q.set("c", S.chat); }
  if (["notes", "looks", "graph", "home"].includes(S.view)) q.set("view", S.view);
  if (S.view === "canvas" && typeof CV !== "undefined" && CV.world && CV.world !== "top") q.set("b", CV.world);
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const s = q.toString(); return s ? "?" + s : location.pathname;
};
document.querySelectorAll("[data-l]").forEach((el) => { const [zh, en] = el.dataset.l.split("|"); el.textContent = L(zh, en); });
PGAShell.mount($("#shell")); $("#toAgents").href = "/agents" + asq; $("#home").href = "/" + asq;

