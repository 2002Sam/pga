// The PGA server's API. In the app it is the same origin (pga://app/v1/… is passed on by the native shell); with
// `npm run dev` Vite passes /v1 on. The account comes from the shell (or ?uid= in a browser).
const Q = new URLSearchParams(location.search);
export const page = { ...(window.PGA_NATIVE || {}) };
for (const k of ["mode", "key", "uid"]) if (Q.get(k) && !page[k]) page[k] = Q.get(k);
export const uid = page.uid;

export async function api(path, { body, method } = {}) {
  const r = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && (data.detail?.message || data.detail)) || `HTTP ${r.status}`);
  return data;
}

export const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
};
