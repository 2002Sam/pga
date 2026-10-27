import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener"); } });

// An agent's words as safe HTML (what it wrote may contain any markup).
export const md = (s) => DOMPurify.sanitize(marked.parse(String(s || "")));

// The live trace an agent writes while it works: "→ Tool target", "$ command", "（搜索）query" lines are steps, the rest are words.
export function trace(text) {
  const steps = [], words = [];
  for (const l of String(text || "").split("\n")) {
    let m;
    if ((m = l.match(/^→ (\S+)\s*(.*)$/))) steps.push({ tool: m[1], target: m[2] });
    else if ((m = l.match(/^\$ (.*)$/))) steps.push({ tool: "Bash", target: m[1] });
    else if ((m = l.match(/^（搜索）(.*)$/))) steps.push({ tool: "WebSearch", target: m[1] });
    else words.push(l);
  }
  return { steps, words: words.join("\n").trim() };
}
