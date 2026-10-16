/* The thought tree (思考树), drawn — shared by the workbench and the tree page.
   The motivation is the root, at the bottom; the dialogue grows upward in nodes, one line of thought each. A node that
   continues its parent grows straight on (the trunk); one that splits off bends into a lane of its own (a branch).
   Sampled answers are twigs, ideas only one sample had are buds; a light rises from the root to the growing tip. */
(function () {
  const ROW = 50;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function visible(T, showHidden) {
    const all = (T?.nodes || []).filter((n) => n.kind !== "bud"), by = new Map(all.map((n) => [n.id, n]));
    if (showHidden) return { nodes: all, folded: new Map() };
    const gone = (n) => { for (let x = n, i = 0; x && i < 400; x = by.get(x.parent), i++) if (x.hidden) return true; return false; };
    const keep = all.filter((n) => !gone(n)), folded = new Map();
    for (const n of all) if (n.hidden && !gone(by.get(n.parent))) { const p = n.parent || "root"; folded.set(p, (folded.get(p) || 0) + 1); }
    return { nodes: keep, folded };
  }
  function layout(T, W, row = ROW, labelW = 0, showHidden = false) {
    const vis = visible(T, showHidden);
    const list = vis.nodes.sort((a, b) => a.seq - b.seq).map((n, i) => ({ ...n, row: i }));
    const by = new Map(list.map((n) => [n.id, n]));
    const pid = (n) => (n.parent && by.has(n.parent) ? n.parent : "root");
    const kids = new Map(); for (const n of list) { const p = pid(n); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
    const lane = new Map([["root", 0]]), depth = new Map([["root", 0]]), busy = new Map([[0, (kids.get("root") || [])[0]?.row ?? -1]]);
    for (const n of list) {
      const p = pid(n), pl = lane.get(p) ?? 0;
      let l = pl;
      if ((kids.get(p) || [])[0] !== n) {                             // a branch: the nearest lane that is free from here on
        for (let k = 1; k < 60; k++) { const c = n.row % 2 ? [pl + k, pl - k] : [pl - k, pl + k]; const f = c.find((x) => (busy.get(x) ?? -2) < n.row); if (f !== undefined) { l = f; break; } }
      }
      lane.set(n.id, l); depth.set(n.id, (depth.get(p) || 0) + 1);
      const fk = (kids.get(n.id) || [])[0];
      busy.set(l, Math.max(busy.get(l) ?? -2, n.row, fk ? fk.row : n.row));
    }
    const maxL = Math.max(1, ...[...lane.values()].map(Math.abs)), gap = Math.max(26, Math.min(66, (W / 2 - (labelW || 170)) / maxL));
    const H = (list.length + 1) * row + 150, cx = W / 2, y0 = H - 120;
    for (const n of list) { n.lane = lane.get(n.id); n.depth = depth.get(n.id); n.x = cx + n.lane * gap; n.y = y0 - (n.row + 1) * row; n.p = pid(n); }
    return { list, by, kids, H, W, cx, y0, row, folded: vis.folded };
  }

  function focusPath(T) {
    const s = new Set(), by = new Map((T?.nodes || []).map((n) => [n.id, n]));
    for (let n = by.get(T?.focus), i = 0; n && i < 400; n = by.get(n.parent), i++) s.add(n.id);
    return s;
  }

  /* opts: { sel: {id, bud}, seen: Set (ids already drawn: no growth animation), aimText, row } → the layout */
  function draw(svg, T, W, opts = {}) {
    const L = layout(T, W, opts.row || ROW, (opts.labelChars || 22) * 12.5 + 20, !!opts.showHidden), row = L.row;
    const seen = opts.seen || new Set(), first = !seen.size, sel = opts.sel || {}, foc = focusPath(T);
    let fresh = 0;
    const delay = (n) => (seen.has(n.id) ? null : (first ? n.row * 45 : (fresh++) * 160));
    const P = (n) => (n.p === "root" ? { x: L.cx, y: L.y0 } : L.by.get(n.p));
    const sap = [], onTip = new Set();
    for (let x = L.list.find((n) => n.tip) || L.list[L.list.length - 1]; x; x = x.p === "root" ? null : L.by.get(x.p)) onTip.add(x.id);
    let roots = "", edges = "", twigs = "", dots = "", labels = "";
    for (let i = 0; i < 7; i++) {
      const a = -1 + i / 3, len = 34 + (i % 3) * 16;
      roots += `<path class="root" d="M ${L.cx} ${L.y0} C ${L.cx + a * 18} ${L.y0 + 22}, ${L.cx + a * 46} ${L.y0 + len * .6}, ${L.cx + a * 70} ${L.y0 + len}"/>`;
    }
    for (const n of L.list) {
      const p = P(n), w = Math.max(1.1, 6.4 - n.depth * .42), d = delay(n), focus = foc.has(n.id), mine = n.kind === "user";
      let path;
      if ((n.p !== "root" && L.by.get(n.p)?.lane === n.lane) || (n.p === "root" && n.lane === 0)) {
        const wob = ((n.row * 37) % 7 - 3) * 1.6;                     // straight on: the trunk, with a little life in it
        path = `M ${p.x} ${p.y} C ${p.x + wob} ${p.y - (p.y - n.y) * .35}, ${n.x - wob} ${n.y + (p.y - n.y) * .35}, ${n.x} ${n.y}`;
      } else if (p.y - n.y <= row * 1.2) {
        path = `M ${p.x} ${p.y} C ${p.x} ${p.y - row * .55}, ${n.x} ${n.y + row * .5}, ${n.x} ${n.y}`;
      } else {                                                         // a branch: leaves its parent, bends out, rises into its own lane
        const dy = p.y - n.y;
        path = `M ${p.x} ${p.y} C ${p.x} ${p.y - Math.min(dy * .3, row * 1.6)}, ${n.x} ${p.y - Math.min(dy * .45, row * 2.2)}, ${n.x} ${p.y - Math.min(dy * .7, row * 3)} S ${n.x} ${n.y + row * .3}, ${n.x} ${n.y}`;
      }
      if (onTip.has(n.id)) sap.push(`<path class="sap" d="${path}" pathLength="1" style="animation-delay:${(sap.length * .32).toFixed(2)}s"/>`);
      edges += `<path class="br ${focus ? "focus" : ""} ${mine ? "mine" : ""} ${d !== null ? "grow" : ""}" d="${path}" pathLength="1" style="stroke-width:${w.toFixed(2)}${d !== null ? `;animation-delay:${d}ms` : ""}"/>`;
      const side = n.lane >= 0 ? -1 : 1;                               // twigs and buds on the side away from the label
      if (n.sampled) {
        const k = Math.min(5, Math.max(2, Math.round(n.samples / Math.max(1, n.sampled)))), span = .5 + (n.spread || .3) * 1.3;
        for (let j = 0; j < k; j++) {
          const ang = -Math.PI / 2 + side * (.35 + span * j / Math.max(1, k - 1)), len = 11 + (j % 2) * 5;
          const ex = n.x + Math.cos(ang) * len, ey = n.y + Math.sin(ang) * len;
          twigs += `<path class="twig ${d !== null ? "grow" : ""}" pathLength="1" d="M ${n.x} ${n.y} Q ${(n.x + ex) / 2 + side * 3} ${(n.y + ey) / 2 - 3}, ${ex} ${ey}" style="${d !== null ? `animation-delay:${d + 350}ms` : ""}"/><circle class="twigend" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="1.3"/>`;
        }
      }
      const buds = n.buds || [], off = Math.max(0, buds.length - 3);
      buds.slice(-3).forEach((b, j) => {
        const bx = n.x + side * (16 + j * 11), by2 = n.y + 10 - j * 4, on = sel.id === n.id && sel.bud === j + off;
        twigs += `<path class="twig" d="M ${n.x} ${n.y} Q ${n.x + side * 8} ${n.y + 8}, ${bx} ${by2}"/>
          <ellipse class="bud ${on ? "on" : ""} ${d !== null ? "pop" : ""}" data-tbud="${n.id}|${j + off}" cx="${bx.toFixed(1)}" cy="${by2.toFixed(1)}" rx="3.6" ry="2.3" transform="rotate(${side * -30} ${bx.toFixed(1)} ${by2.toFixed(1)})" style="${d !== null ? `animation-delay:${d + 500}ms` : ""}"><title>灵感：${esc(b.idea)}</title></ellipse>`;
      });
      const r = Math.max(4, Math.min(11, 3.4 + Math.sqrt(n.turns || 1) * .62));
      dots += `<g class="tn ${n.kind} ${n.tip ? "tip" : ""} ${sel.id === n.id && sel.bud == null ? "sel" : ""} ${focus ? "focus" : ""} ${d !== null ? "pop" : ""}" data-tnode="${n.id}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" style="${d !== null ? `animation-delay:${d + 280}ms` : ""}">
        <circle class="halo" r="${(r + 7).toFixed(1)}"/><circle class="body" r="${r.toFixed(1)}"/>${n.open ? `<circle class="open" r="${Math.min(2.6, r - 1.5).toFixed(1)}"/>` : ""}<title>${esc(n.title)}</title></g>`;
      const right = n.lane >= 0, lx = n.x + (right ? r + 9 : -(r + 9)), max = opts.labelChars || 22, short = n.title.length > max ? n.title.slice(0, max - 1) + "…" : n.title;
      const B = n.behavior || {}, beh = opts.mode === "behavior";
      if (beh && (B.runs || B.commits)) {                              // what the agents did here: a little ring of actions
        const kinds = [["read", "#6fa8d8"], ["search", "#5fc4b8"], ["web", "#a58be0"], ["command", "#e9a94b"], ["edit", "#f08a7a"], ["commits", "#ffd27a"]];
        const tot = kinds.reduce((a, [k]) => a + (B[k] || 0), 0) || 1; let a0 = -Math.PI / 2;
        for (const [k, col] of kinds) {
          const v = B[k] || 0; if (!v) continue;
          const a1 = a0 + v / tot * Math.PI * 2, R = r + 4.5, large = a1 - a0 > Math.PI ? 1 : 0;
          dots += `<path class="bring" d="M ${(n.x + Math.cos(a0) * R).toFixed(1)} ${(n.y + Math.sin(a0) * R).toFixed(1)} A ${R} ${R} 0 ${large} 1 ${(n.x + Math.cos(a1 - .001) * R).toFixed(1)} ${(n.y + Math.sin(a1 - .001) * R).toFixed(1)}" stroke="${col}"/>`;
          a0 = a1;
        }
      }
      const behMeta = beh ? [B.runs ? `${B.runs} 次运行` : "", B.read ? `读 ${B.read}` : "", B.search ? `查 ${B.search}` : "", B.command ? `命令 ${B.command}` : "",
        B.edit ? `改 ${B.edit}` : "", B.commits ? `提交 ${B.commits}` : ""].filter(Boolean) : null;
      const meta = behMeta ? (behMeta.join(" · ") || "没有记录到动作") : [n.kind === "exchange" ? "交流" : "", n.codes?.length ? n.codes.join("–") : "", `${n.turns} 轮`, n.samples ? `${n.samples} 次生成` : "", n.git?.commits ? `⎇ ${n.git.commits}` : "",
        n.dataset ? "已沉淀" : "", L.folded.get(n.id) ? `收起 ${L.folded.get(n.id)}` : "", n.hidden ? "已隐藏" : ""].filter(Boolean).join(" · ");
      labels += `<text class="tl ${n.kind} ${sel.id === n.id ? "sel" : ""} ${d !== null ? "pop" : ""}" data-tnode="${n.id}" x="${lx.toFixed(1)}" y="${(n.y - 1).toFixed(1)}" text-anchor="${right ? "start" : "end"}" style="${d !== null ? `animation-delay:${d + 320}ms` : ""}">${esc(short)}<tspan class="tm" x="${lx.toFixed(1)}" dy="13">${esc(meta)}</tspan></text>`;
    }
    let arcs = "";
    for (const n of L.list) if (n.kind === "exchange" && n.with && L.by.has(n.with)) {
      const o = L.by.get(n.with), mx = (n.x + o.x) / 2 + (n.lane >= o.lane ? 60 : -60), my = (n.y + o.y) / 2;
      arcs += `<path class="xarc" d="M ${n.x} ${n.y} Q ${mx} ${my}, ${o.x} ${o.y}"><title>交流：${esc(n.title)}</title></path>`;
    }
    const aimText = opts.aimText || T?.aim?.text || "", short = aimText.length > 26 ? aimText.slice(0, 25) + "…" : aimText;
    svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`); svg.setAttribute("width", L.W); svg.setAttribute("height", L.H);
    svg.innerHTML = `<defs><radialGradient id="seedGlow"><stop offset="0" stop-color="#e9a94b" stop-opacity=".55"/><stop offset="1" stop-color="#e9a94b" stop-opacity="0"/></radialGradient>
        <linearGradient id="ground" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      <line x1="${L.cx - 230}" x2="${L.cx + 230}" y1="${L.y0 + 4}" y2="${L.y0 + 4}" stroke="url(#ground)"/>
      <g class="roots">${roots}</g><g>${edges}</g><g>${arcs}</g><g>${sap.reverse().join("")}</g><g>${twigs}</g>
      <g class="seed"><circle r="26" cx="${L.cx}" cy="${L.y0}" fill="url(#seedGlow)"/><circle class="seedbody" r="9" cx="${L.cx}" cy="${L.y0}"/></g>
      <text class="rootlbl" x="${L.cx}" y="${L.y0 + 74}" text-anchor="middle">${esc(short)}<tspan class="tm" x="${L.cx}" dy="14">根 · 这个抱负</tspan></text>
      <g>${dots}</g><g>${labels}</g>`;
    L.list.forEach((n) => seen.add(n.id));
    return L;
  }

  const CSS = `
.treewrap .root { fill: none; stroke: rgba(233,169,75,.25); stroke-width: 1.1; stroke-linecap: round; }
.treewrap .br { fill: none; stroke: rgba(222,230,234,.42); stroke-linecap: round; }
.treewrap .br.mine { stroke: rgba(150,214,160,.7); } .treewrap .br.focus { stroke: rgba(233,169,75,.9); filter: drop-shadow(0 0 4px rgba(233,169,75,.5)); }
.treewrap .grow { stroke-dasharray: 1; stroke-dashoffset: 1; animation: pgaGrow .9s cubic-bezier(.3,.6,.3,1) forwards; }
@keyframes pgaGrow { to { stroke-dashoffset: 0; } }
.treewrap .sap { fill: none; stroke: rgba(255,214,150,.9); stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: .05 .95; stroke-dashoffset: 1;
  animation: pgaSap 2.8s linear infinite; filter: drop-shadow(0 0 3px rgba(233,169,75,.9)); pointer-events: none; }
@keyframes pgaSap { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.treewrap .xarc { fill: none; stroke: rgba(156,195,230,.6); stroke-width: 1.2; stroke-dasharray: 4 4; }
.treewrap .tn.exchange .body { stroke: #9cc3e6; } .treewrap text.exchange { fill: #b6d3ec; }
.treewrap .bring { fill: none; stroke-width: 2.6; stroke-linecap: butt; pointer-events: none; }
.treewrap .twig { fill: none; stroke: rgba(222,230,234,.26); stroke-width: .8; } .treewrap .twigend { fill: rgba(222,230,234,.45); }
.treewrap .bud { fill: rgba(5,5,5,.8); stroke: #e9a94b; stroke-width: 1; cursor: pointer; } .treewrap .bud:hover, .treewrap .bud.on { fill: #e9a94b; }
.treewrap .pop { opacity: 0; animation: pgaPop .55s ease forwards; }
@keyframes pgaPop { from { opacity: 0; } to { opacity: 1; } }
.treewrap .tn { cursor: pointer; } .treewrap .tn .halo { fill: transparent; }
.treewrap .tn .body { fill: #0b0d10; stroke: rgba(232,236,238,.85); stroke-width: 1.3; transition: fill .2s; }
.treewrap .tn.user .body { stroke: rgba(150,214,160,.95); } .treewrap .tn.focus .body { stroke: #e9a94b; }
.treewrap .tn:hover .body { fill: #1b2026; } .treewrap .tn.sel .body { fill: #e9a94b; stroke: #e9a94b; }
.treewrap .tn.sel .halo { fill: rgba(233,169,75,.14); }
.treewrap .tn .open { fill: #e9a94b; }
.treewrap .tn.tip .halo { fill: rgba(233,169,75,.1); animation: pgaTip 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes pgaTip { 0%, 100% { transform: scale(.8); opacity: .3; } 50% { transform: scale(1.35); opacity: 1; } }
.treewrap .seedbody { fill: #000; stroke: #e9a94b; stroke-width: 1.5; }
.treewrap text { font: 12px "Inter", -apple-system, "PingFang SC", sans-serif; fill: rgba(232,236,238,.82); paint-order: stroke; stroke: rgba(5,6,8,.92); stroke-width: 4px; stroke-linejoin: round; cursor: pointer; }
.treewrap text.user { fill: rgba(170,224,178,.95); } .treewrap text.sel { fill: #e9a94b; }
.treewrap text .tm { font: 10px "JetBrains Mono", ui-monospace, Menlo, monospace; fill: rgba(160,168,172,.7); }
.treewrap .rootlbl { font-size: 12.5px; fill: #e9a94b; cursor: default; }`;
  if (!document.getElementById("pgaTreeCss")) { const st = document.createElement("style"); st.id = "pgaTreeCss"; st.textContent = CSS; document.head.appendChild(st); }

  /* the turns of a node as a group chat: agents on the left (each its own colour), you on the right, findings and
     ideas as small cards in the middle, a time line where the dialogue paused */
  const HUES = [205, 160, 32, 280, 345, 95, 190, 250];
  const hue = (name) => { let h = 0; for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
  const KIND = { question: "提问", answer: "回答", insight: "发现", reflect: "回顾", correction: "指正", checkpoint: "检查点", evolve: "进化", summary: "总结", plan: "计划" };
  const ROLE = { lead: "主持", researcher: "研究员", critic: "审阅" };
  const when = (iso) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function samples(d) {
    if (!d.samples?.length) return "";
    return `<details class="cs"><summary>${d.samples.length} 次生成 · 分歧 ${(d.divergence ?? 0).toFixed(2)}${d.ideas?.length ? ` · ${d.ideas.length} 个新想法` : ""}</summary>
      <div class="spread"><i style="width:${Math.round((d.divergence ?? 0) * 100)}%"></i></div>
      ${(d.agreed || []).length ? `<div class="agreed">共识：${esc(d.agreed.join("；"))}</div>` : ""}
      ${(d.ideas || []).map((x) => `<div class="idea">✦ ${esc(x.idea)}</div>`).join("")}
      <div class="smps">${d.samples.map((x) => `<div class="smp1"><div class="sh"><b>样本 ${x.n}</b> ${esc(x.agent)} · ${esc(x.angle || "")} · 把握 ${Math.round((x.confidence ?? .5) * 100)}%</div><div class="sx">${esc(x.answer)}</div></div>`).join("")}</div></details>`;
  }
  function chat(notes, opts = {}) {
    const md = opts.md || esc;
    let out = "", last = null, lastQ = null;
    for (const x of notes || []) {
      const d = x.data || {}, at = new Date(x.at);
      if (!last || at - last > 25 * 60 * 1000) out += `<div class="ctime">${esc(when(x.at))}</div>`;
      last = at;
      const me = x.agent === "you" || x.kind === "correction";
      if (x.kind === "conversation") {                                   // a whole conversation imported from another app
        const name = x.agent || d.vendor || "对话", h = hue(name), [title, ...rest] = String(x.text || "").split("\n");
        out += `<div class="cmsg conv"><div class="cav" style="--h:${h}">${esc(name.slice(0, 1).toUpperCase())}</div><div class="cbody">
          <div class="cwho"><b style="color:hsl(${h} 60% 72%)">${esc(name)}</b> · <span>导入的对话${d.messages ? ` · ${d.messages} 条消息` : ""}${d.project ? ` · ${esc(d.project)}` : ""}</span></div>
          <div class="cb"><div class="ct"><b>${esc(title)}</b>${rest.join(" ").trim() ? `\n${esc(rest.join("\n").trim())}` : ""}</div></div></div></div>`;
        continue;
      }
      if (!me && !["question", "answer"].includes(x.kind)) {                // findings, ideas, reviews: a card in the middle
        const insp = d.inspiration, icon = insp ? "✦" : { insight: "◇", reflect: "↺", checkpoint: "⏸", evolve: "⚙", summary: "≡", plan: "☰" }[x.kind] || "·";
        out += `<div class="cnote ${insp ? "insp" : x.kind}"><span class="ci">${icon} ${esc(insp ? "灵感" : KIND[x.kind] || x.kind)}${x.agent ? ` · ${esc(x.agent)}` : ""}</span><div>${esc(x.text)}</div></div>`;
        continue;
      }
      const name = me ? "你" : (x.agent || ROLE[x.role] || "agent"), h = hue(name);
      const tag = `${KIND[x.kind] || x.kind}${d.code ? " " + d.code : ""}`;
      const quote = x.kind === "answer" && d.question && lastQ !== d.code ? `<div class="cq">↪ ${esc(d.question)}</div>` : "";
      if (x.kind === "question") lastQ = d.code;
      const subs = [];
      if (x.kind === "question" && d.why) subs.push(`为什么问：${esc(d.why)}`);
      if (x.kind === "question" && x.status && x.status !== "answered") subs.push({ open: "待研究", for_you: "等你回答", dropped: "已放下" }[x.status] || x.status);
      if (x.kind === "answer" && d.confidence != null) subs.push(`把握 ${Math.round(d.confidence * 100)}%`);
      if (d.proposal) subs.push(`提出改进 ${esc(d.proposal)}`);
      if ((d.evidence || []).length) subs.push(`依据 ${d.evidence.slice(0, 4).map((e) => `<code>${esc(e)}</code>`).join(" ")}${d.evidence.length > 4 ? " …" : ""}`);
      out += `<div class="cmsg ${me ? "me" : ""} ${x.kind}">
        ${me ? "" : `<div class="cav" style="--h:${h}" title="${esc(name)}">${esc(name.slice(0, 1).toUpperCase())}</div>`}
        <div class="cbody"><div class="cwho">${me ? "" : `<b style="color:hsl(${h} 60% 72%)">${esc(name)}</b>${x.role ? ` ${esc(ROLE[x.role] || x.role)}` : ""} · `}<span>${esc(tag)}</span></div>
          <div class="cb">${quote}<div class="ct ${x.kind === "answer" ? "md" : ""}">${x.kind === "answer" ? md(x.text) : esc(x.text)}</div>
            ${subs.length ? `<div class="csub">${subs.join(" · ")}</div>` : ""}${samples(d)}</div></div></div>`;
    }
    return `<div class="chat">${out || `<div class="ctime">还没有对话</div>`}</div>`;
  }
  const CHAT_CSS = `
.chat { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.chat .ctime { align-self: center; font-size: 11px; color: #777; background: rgba(255,255,255,.04); padding: 1px 10px; border-radius: 10px; }
.chat .cmsg { display: flex; gap: 10px; align-items: flex-start; max-width: 92%; }
.chat .cmsg.me { align-self: flex-end; flex-direction: row-reverse; }
.chat .cav { flex: none; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; font: 600 14px/1 "Inter", sans-serif;
  color: #0b0d10; background: hsl(var(--h) 55% 68%); }
.chat .cbody { min-width: 0; display: flex; flex-direction: column; }
.chat .cmsg.me .cbody { align-items: flex-end; }
.chat .cwho { font-size: 11.5px; color: #8a8a8a; margin: 0 4px 3px; } .chat .cwho span { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10.5px; }
.chat .cb { position: relative; background: #15191e; border: 1px solid rgba(255,255,255,.07); border-radius: 4px 14px 14px 14px; padding: 9px 13px; line-height: 1.7; font-size: 13.5px; color: #e6e9eb; }
.chat .cmsg.question .cb { background: #12161b; border-color: rgba(222,230,234,.14); }
.chat .cmsg.answer .cb { background: #151b22; }
.chat .cmsg.conv .cb { background: #12171a; border-style: dashed; }
.chat .cmsg.me .cb { background: #2b4a33; border-color: rgba(150,214,160,.35); border-radius: 14px 4px 14px 14px; color: #eef6ef; }
.chat .ct { white-space: pre-wrap; word-break: break-word; } .chat .ct.md { white-space: normal; } .chat .ct.md p { margin: .35em 0; }
.chat .ct.md ul, .chat .ct.md ol { padding-left: 20px; margin: .3em 0; } .chat .ct.md code, .chat code { font: 11.5px "JetBrains Mono", ui-monospace, monospace; background: rgba(255,255,255,.06); padding: 0 4px; }
.chat .ct.md pre { background: rgba(0,0,0,.35); padding: 8px; overflow: auto; }
.chat .cq { font-size: 12px; color: #9aa4ab; border-left: 2px solid rgba(255,255,255,.18); padding-left: 8px; margin-bottom: 6px; }
.chat .csub { margin-top: 6px; font-size: 11.5px; color: #8f989e; }
.chat .cnote { align-self: center; max-width: 86%; font-size: 12.5px; line-height: 1.65; color: #cfd6da; background: rgba(255,255,255,.035);
  border: 1px dashed rgba(255,255,255,.14); border-radius: 10px; padding: 7px 12px; }
.chat .cnote .ci { display: block; font-size: 11px; color: #9aa4ab; margin-bottom: 2px; }
.chat .cnote.insp { border-color: rgba(233,169,75,.55); color: #f1d3a3; } .chat .cnote.insp .ci { color: #e9a94b; }
.chat .cs { margin-top: 8px; } .chat .cs summary { cursor: pointer; font-size: 12px; color: #e9a94b; }
.chat .spread { height: 3px; background: rgba(255,255,255,.08); margin: 6px 0; } .chat .spread i { display: block; height: 100%; background: linear-gradient(90deg, #6fa8d8, #e9a94b, #f08a7a); }
.chat .agreed { font-size: 12px; color: #9aa4ab; } .chat .idea { color: #e9a94b; font-size: 12.5px; margin: 3px 0; }
.chat .smps { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; margin-top: 6px; }
.chat .smp1 { border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 7px 9px; font-size: 12.5px; background: rgba(0,0,0,.2); }
.chat .smp1 .sh { font-size: 11px; color: #9aa4ab; margin-bottom: 3px; } .chat .smp1 .sh b { color: #e6e9eb; font-weight: 500; } .chat .smp1 .sx { white-space: pre-wrap; }`;
  if (!document.getElementById("pgaChatCss")) { const st = document.createElement("style"); st.id = "pgaChatCss"; st.textContent = CHAT_CSS; document.head.appendChild(st); }

  /* a node's summary, written as 问 / 发现 / 定 lines, shown as labelled rows */
  function summary(text) {
    const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const lab = /^(问|发现|定|下一步|Asked|Found|Next)\s*[:：]\s*/;
    if (lines.length && lines.every((l) => lab.test(l)))
      return `<div class="rsum">${lines.map((l) => { const m = l.match(lab); return `<div class="rl"><span class="rk">${esc(m[1])}</span><span>${esc(l.slice(m[0].length))}</span></div>`; }).join("")}</div>`;
    return `<div class="rsum plain">${esc(text || "")}</div>`;
  }
  const SUM_CSS = `.rsum { display: grid; gap: 8px; } .rsum .rl { display: grid; grid-template-columns: 44px 1fr; gap: 10px; line-height: 1.7; font-size: 14px; }
.rsum .rk { font-size: 12px; color: #e9a94b; border: 1px solid rgba(233,169,75,.4); border-radius: 4px; text-align: center; height: 22px; line-height: 20px; margin-top: 2px; }
.rsum.plain { line-height: 1.8; font-size: 14px; }`;
  if (!document.getElementById("pgaSumCss")) { const st = document.createElement("style"); st.id = "pgaSumCss"; st.textContent = SUM_CSS; document.head.appendChild(st); }

  const AK = { read: ["读", "#6fa8d8", "◉"], search: ["查", "#5fc4b8", "⌕"], web: ["网上查", "#a58be0", "◍"], command: ["命令", "#e9a94b", "▸"],
                edit: ["改", "#f08a7a", "✎"], delegate: ["派出", "#c9c9c9", "⇢"], other: ["其他", "#999", "·"] };
  function behaviorTree(B, node) {
    if (!B) return "";
    const T = B.totals || {};
    const pills = Object.entries(AK).filter(([k]) => T[k]).map(([k, [zh, col]]) => `<span class="bp" style="--c:${col}">${zh} ${T[k]}</span>`).join("")
      + (B.commits?.length ? `<span class="bp" style="--c:#ffd27a">提交 ${B.commits.length}</span>` : "") + (B.proposals?.length ? `<span class="bp" style="--c:#e9a94b">改进提案 ${B.proposals.length}</span>` : "");
    const run = (r) => {
      const st = r.status === "SUCCEEDED" ? "ok" : r.status === "STOPPED" ? "stop" : "bad";
      return `<li class="bt-run ${st}"><details ${r.actions.length && r.actions.length <= 12 ? "open" : ""}><summary><span class="bt-step">${esc(r.step_zh)}</span>${r.code ? `<span class="bt-code">${esc(r.code)}</span>` : ""}
        <span class="bt-st">${r.status === "SUCCEEDED" ? "完成" : esc(r.status)}</span><span class="bt-t">${r.seconds ? `${r.seconds}s` : ""} · ${esc(when(r.at))}</span>${r.actions.length ? `<span class="bt-n">${r.actions.length + r.more} 个动作</span>` : ""}</summary>
        ${r.error ? `<div class="bt-err">${esc(r.error)}</div>` : ""}
        ${r.actions.length ? `<ul>${r.actions.map((a) => { const [zh, col, ic] = AK[a.kind] || AK.other; return `<li class="bt-act"><span class="bt-ic" style="color:${col}">${ic}</span><span class="bt-tool" style="color:${col}">${esc(a.tool)}</span><code>${esc(a.target)}</code></li>`; }).join("")}${r.more ? `<li class="bt-act dim">…还有 ${r.more} 个</li>` : ""}</ul>` : `<div class="bt-none">这次运行没有记录到工具动作${r.step === "think" || r.step === "aggregate" ? "（思考和合成只写文字）" : ""}</div>`}</details></li>`;
    };
    const agents = (B.agents || []).map((a) => { const h = hue(a.agent);
      return `<li class="bt-agent"><div class="bt-ah"><span class="cav" style="--h:${h}">${esc(a.agent.slice(0, 1).toUpperCase())}</span><b>${esc(a.agent)}</b><span>${a.runs.length} 次运行 · 成功 ${a.ok}${a.failed ? ` · 失败 ${a.failed}` : ""} · ${Math.round(a.seconds)}s</span></div><ul>${a.runs.map(run).join("")}</ul></li>`; }).join("");
    const code = (B.commits || []).length || (B.proposals || []).length ? `<li class="bt-agent"><div class="bt-ah"><span class="cav" style="--h:45">⎇</span><b>代码</b><span>提案和提交</span></div><ul>
        ${(B.proposals || []).map((p) => `<li class="bt-act"><span class="bt-ic" style="color:#e9a94b">◆</span><span class="bt-tool" style="color:#e9a94b">提案</span><code>${esc(p)}</code></li>`).join("")}
        ${(B.commits || []).map((c) => `<li class="bt-act"><span class="bt-ic" style="color:#ffd27a">⎇</span><a href="${esc(c.url || "#")}" target="_blank" rel="noopener"><code>${esc(c.sha.slice(0, 7))}</code></a><span>${esc(c.subject)}</span></li>`).join("")}</ul></li>` : "";
    return `<div class="bt"><div class="bt-pills">${pills || `<span class="dim">这一段没有记录到具体动作</span>`}</div>
      <div class="bt-note">${B.runs} 次运行${B.traced < B.runs ? ` · 其中 ${B.traced} 次留下了工具记录（较早的运行只记录了结果）` : ""}</div>
      <ul class="bt-root"><li><div class="bt-ah root"><span class="cav" style="--h:40">✦</span><b>${esc(node?.title || "节点")}</b></div><ul>${agents}${code}</ul></li></ul></div>`;
  }
  const BT_CSS = `
.bt-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; } .bt-pills .bp { font-size: 12px; padding: 1px 9px; border: 1px solid var(--c); color: var(--c); border-radius: 10px; }
.bt-note { font-size: 11.5px; color: #8a8a8a; margin-bottom: 12px; }
.bt ul { list-style: none; margin: 0; padding-left: 22px; position: relative; } .bt ul.bt-root { padding-left: 0; }
.bt li { position: relative; } .bt ul ul > li::before { content: ""; position: absolute; left: -14px; top: 0; bottom: 0; border-left: 1px solid rgba(255,255,255,.14); }
.bt ul ul > li:last-child::before { bottom: auto; height: 14px; } .bt ul ul > li::after { content: ""; position: absolute; left: -14px; top: 14px; width: 11px; border-top: 1px solid rgba(255,255,255,.14); }
.bt-ah { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 12.5px; } .bt-ah b { font-weight: 500; } .bt-ah span:last-child { color: #8a8a8a; font-size: 11.5px; }
.bt-ah .cav { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font: 600 11px/1 "Inter", sans-serif; color: #0b0d10; background: hsl(var(--h) 55% 68%); flex: none; }
.bt-run summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; padding: 3px 0; font-size: 12.5px; list-style: none; } .bt-run summary::-webkit-details-marker { display: none; }
.bt-step { color: #e6e9eb; } .bt-code { font: 11px "JetBrains Mono", monospace; color: #e9a94b; } .bt-st { font-size: 11px; color: #96d6a0; } .bt-run.bad .bt-st { color: #f08a7a; } .bt-run.stop .bt-st { color: #c9c9c9; }
.bt-t, .bt-n { font-size: 11px; color: #8a8a8a; } .bt-err { font-size: 11.5px; color: #f08a7a; margin: 2px 0 4px; } .bt-none { font-size: 11.5px; color: #777; padding: 2px 0 6px; }
.bt-act { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; font-size: 12px; } .bt-act code { font: 11.5px "JetBrains Mono", monospace; color: #c9d0d4; word-break: break-all; }
.bt-ic { width: 12px; text-align: center; } .bt-tool { font-size: 11.5px; min-width: 42px; }`;
  if (!document.getElementById("pgaBtCss")) { const st = document.createElement("style"); st.id = "pgaBtCss"; st.textContent = BT_CSS; document.head.appendChild(st); }

  window.PGATree = { behaviorTree, AK, layout, draw, esc, ROW, chat, summary, hue };
})();
