/* The thought tree (思考树), drawn — shared by the forest, the tree page (and the archived workbench).
   The root is at the bottom; the dialogue grows upward in nodes, one line of thought each. A node that continues its
   parent grows straight on (the trunk); one that splits off bends into a lane of its own (a branch). Sampled answers
   are twigs, ideas only one sample had are buds, conclusions not taken when it forked are shadow paths (dashed).
   Everything that is text goes through L(zh, en): the pages set the language with PGATree.setLang. */
(function () {
  const ROW = 50;
  let LANG = "zh";
  const L = (zh, en) => (LANG === "en" ? en : zh);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const C = { ink: "var(--t1)", soft: "rgba(var(--ti),.55)", faint: "rgba(var(--ti),.22)", accent: "#d6a75c", blue: "#8fb4ff", green: "#7fcf9f", bg: "var(--tbg)" };

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
    const maxL = Math.max(1, ...[...lane.values()].map(Math.abs)), gap = Math.max(26, Math.min(64, (W / 2 - (labelW || 170)) / maxL));
    const H = (list.length + 1) * row + 150, cx = W / 2, y0 = H - 112;
    for (const n of list) { n.lane = lane.get(n.id); n.depth = depth.get(n.id); n.x = cx + n.lane * gap; n.y = y0 - (n.row + 1) * row; n.p = pid(n);
      if (n.pos) { n.x += n.pos.dx || 0; n.y += n.pos.dy || 0; } }                // where you dragged it
    return { list, by, kids, H, W, cx, y0, row, folded: vis.folded };
  }
  function focusPath(T) {
    const s = new Set(), by = new Map((T?.nodes || []).map((n) => [n.id, n]));
    for (let n = by.get(T?.focus), i = 0; n && i < 400; n = by.get(n.parent), i++) s.add(n.id);
    return s;
  }

  /* opts: { sel: {id, bud}, seen, aimText, labelChars, showHidden, mode: "thought" | "behavior" } → the layout */
  function draw(svg, T, W, opts = {}) {
    const L0 = layout(T, W, opts.row || ROW, (opts.labelChars || 22) * (LANG === "en" ? 7 : 12.5) + 20, !!opts.showHidden), row = L0.row;
    const seen = opts.seen || new Set(), first = !seen.size, sel = opts.sel || {}, foc = focusPath(T);
    const flip = opts.dir === "down", Y = (y) => (flip ? L0.H - y : y);      // "down": the root on top, growing downward (drawn flipped; text stays upright)
    L0.flip = flip; L0.list.forEach((n) => { n.sy = Y(n.y); });
    let fresh = 0;
    const delay = (n) => (seen.has(n.id) ? null : (first ? n.row * 40 : (fresh++) * 150));
    const P = (n) => (n.p === "root" ? { x: L0.cx, y: L0.y0 } : L0.by.get(n.p));
    const sap = [], onTip = new Set();
    for (let x = L0.list.find((n) => n.tip) || L0.list[L0.list.length - 1]; x; x = x.p === "root" ? null : L0.by.get(x.p)) onTip.add(x.id);
    let roots = "", edges = "", twigs = "", dots = "", labels = "", hits = "";
    for (let i = 0; i < 7; i++) {
      const a = -1 + i / 3, len = 30 + (i % 3) * 14;
      roots += `<path class="root" d="M ${L0.cx} ${L0.y0} C ${L0.cx + a * 16} ${L0.y0 + 20}, ${L0.cx + a * 42} ${L0.y0 + len * .6}, ${L0.cx + a * 64} ${L0.y0 + len}"/>`;
    }
    for (const n of L0.list) {
      const p = P(n), w = Math.max(1, 5.2 - n.depth * .36), d = delay(n), focus = foc.has(n.id), mine = n.kind === "user";
      let path;
      if ((n.p !== "root" && L0.by.get(n.p)?.lane === n.lane) || (n.p === "root" && n.lane === 0)) {
        const wob = ((n.row * 37) % 7 - 3) * 1.4;
        path = `M ${p.x} ${p.y} C ${p.x + wob} ${p.y - (p.y - n.y) * .35}, ${n.x - wob} ${n.y + (p.y - n.y) * .35}, ${n.x} ${n.y}`;
      } else if (p.y - n.y <= row * 1.2) {
        path = `M ${p.x} ${p.y} C ${p.x} ${p.y - row * .55}, ${n.x} ${n.y + row * .5}, ${n.x} ${n.y}`;
      } else {
        const dy = p.y - n.y;
        path = `M ${p.x} ${p.y} C ${p.x} ${p.y - Math.min(dy * .3, row * 1.6)}, ${n.x} ${p.y - Math.min(dy * .45, row * 2.2)}, ${n.x} ${p.y - Math.min(dy * .7, row * 3)} S ${n.x} ${n.y + row * .3}, ${n.x} ${n.y}`;
      }
      if (onTip.has(n.id)) sap.push(`<path class="sap" d="${path}" pathLength="1" style="animation-delay:${(sap.length * .34).toFixed(2)}s"/>`);
      if (n.p !== "root") hits += `<path class="hit" data-edge="${n.id}" d="${path}"><title>${esc(L("划过或点击：剪断（挂回根上）", "Swipe or click: cut (it moves onto the root)"))}</title></path>`;
      edges += `<path class="br ${focus ? "focus" : ""} ${mine ? "mine" : ""} ${d !== null ? "grow" : ""}" d="${path}" pathLength="1" style="stroke-width:${w.toFixed(2)}${d !== null ? `;animation-delay:${d}ms` : ""}"/>`;
      const side = n.lane >= 0 ? -1 : 1;
      if (n.sampled) {
        const k = Math.min(5, Math.max(2, Math.round(n.samples / Math.max(1, n.sampled)))), span = .5 + (n.spread || .3) * 1.3;
        for (let j = 0; j < k; j++) {
          const ang = -Math.PI / 2 + side * (.35 + span * j / Math.max(1, k - 1)), len = 10 + (j % 2) * 5;
          const ex = n.x + Math.cos(ang) * len, ey = n.y + Math.sin(ang) * len;
          twigs += `<path class="twig ${d !== null ? "grow" : ""}" pathLength="1" d="M ${n.x} ${n.y} Q ${(n.x + ex) / 2 + side * 3} ${(n.y + ey) / 2 - 3}, ${ex} ${ey}" style="${d !== null ? `animation-delay:${d + 350}ms` : ""}"/>`;
        }
      }
      (n.shadows || []).filter((x) => x.status !== "dropped").slice(-2).forEach((x, j) => {   // the paths not taken
        const sx = n.x + side * (26 + j * 14), sy = n.y - 14 - j * 10, live = x.status === "promoted";
        twigs += `<path class="shadow ${live ? "live" : ""}" d="M ${n.x} ${n.y} Q ${n.x + side * 10} ${n.y - 4}, ${sx} ${sy}"/>
          <rect class="shadowend ${live ? "live" : ""}" x="${(sx - 3).toFixed(1)}" y="${(sy - 3).toFixed(1)}" width="6" height="6" transform="rotate(45 ${sx.toFixed(1)} ${sy.toFixed(1)})" data-tnode="${n.id}"><title>${esc(L("影子路线 ", "Shadow path ") + (x.alt || "") + " · " + x.conclusion)}</title></rect>`;
      });
      const buds = n.buds || [], off = Math.max(0, buds.length - 3);
      buds.slice(-3).forEach((b, j) => {
        const bx = n.x + side * (15 + j * 10), by2 = n.y + 10 - j * 4, on = sel.id === n.id && sel.bud === j + off;
        twigs += `<path class="twig" d="M ${n.x} ${n.y} Q ${n.x + side * 8} ${n.y + 8}, ${bx} ${by2}"/>
          <ellipse class="bud ${on ? "on" : ""} ${d !== null ? "pop" : ""}" data-tbud="${n.id}|${j + off}" cx="${bx.toFixed(1)}" cy="${by2.toFixed(1)}" rx="3.3" ry="2.1" transform="rotate(${side * -30} ${bx.toFixed(1)} ${by2.toFixed(1)})" style="${d !== null ? `animation-delay:${d + 500}ms` : ""}"><title>${esc(L("灵感：", "Idea: ") + b.idea)}</title></ellipse>`;
      });
      const r = Math.max(3.6, Math.min(9.5, 3.2 + Math.sqrt(n.turns || 1) * .55));
      const B = n.behavior || {}, beh = opts.mode === "behavior";
      if (beh && (B.runs || B.commits)) {
        const kinds = [["read", "#7aa7e6"], ["search", "#6cc4b6"], ["web", "#a48ee0"], ["command", "#d6a75c"], ["edit", "#e58c7e"], ["commits", "#f0d38c"]];
        const tot = kinds.reduce((a, [k]) => a + (B[k] || 0), 0); let a0 = -Math.PI / 2;
        if (!tot) dots += `<circle class="bring idle" cx="${n.x}" cy="${n.y}" r="${r + 4}"/>`;
        for (const [k, col] of kinds) {
          const v = B[k] || 0; if (!v) continue;
          const a1 = a0 + v / tot * Math.PI * 2, R = r + 4, large = a1 - a0 > Math.PI ? 1 : 0;
          dots += `<path class="bring" d="M ${(n.x + Math.cos(a0) * R).toFixed(1)} ${(n.y + Math.sin(a0) * R).toFixed(1)} A ${R} ${R} 0 ${large} 1 ${(n.x + Math.cos(a1 - .001) * R).toFixed(1)} ${(n.y + Math.sin(a1 - .001) * R).toFixed(1)}" stroke="${col}"/>`;
          a0 = a1;
        }
      }
      dots += `<g class="tn ${n.kind} ${n.tip ? "tip" : ""} ${sel.id === n.id && sel.bud == null ? "sel" : ""} ${focus ? "focus" : ""} ${d !== null ? "pop" : ""}" data-tnode="${n.id}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" style="${d !== null ? `animation-delay:${d + 280}ms` : ""}">
        <circle class="halo" r="${(r + 8).toFixed(1)}"/><circle class="body" r="${r.toFixed(1)}"/>${n.open ? `<circle class="open" r="${Math.min(2.2, r - 1.6).toFixed(1)}"/>` : ""}<title>${esc(n.title)}</title></g>`;
      const right = n.lane >= 0, lx = n.x + (right ? r + 9 : -(r + 9)), max = opts.labelChars || 22, short = n.title.length > max ? n.title.slice(0, max - 1) + "…" : n.title;
      const behMeta = beh ? [B.runs ? L(`${B.runs} 次运行`, `${B.runs} runs`) : "", B.read ? L(`读 ${B.read}`, `read ${B.read}`) : "", B.search ? L(`查 ${B.search}`, `search ${B.search}`) : "",
        B.command ? L(`命令 ${B.command}`, `cmd ${B.command}`) : "", B.edit ? L(`改 ${B.edit}`, `edit ${B.edit}`) : "", B.commits ? L(`提交 ${B.commits}`, `commit ${B.commits}`) : ""].filter(Boolean) : null;
      const meta = behMeta ? (behMeta.join(" · ") || L("没有记录到动作", "no actions recorded"))
        : [n.kind === "exchange" ? L("交流", "exchange") : "", n.codes?.length ? n.codes.join("–") : "", L(`${n.turns} 轮`, `${n.turns} turns`),
           n.samples ? L(`${n.samples} 次生成`, `${n.samples} samples`) : "", (n.shadows || []).filter((x) => x.status !== "dropped").length ? L(`影子 ${(n.shadows || []).filter((x) => x.status !== "dropped").length}`, `${(n.shadows || []).filter((x) => x.status !== "dropped").length} shadow`) : "",
           n.dataset ? L("已沉淀", "distilled") : "", L0.folded.get(n.id) ? L(`收起 ${L0.folded.get(n.id)}`, `${L0.folded.get(n.id)} folded`) : "", n.hidden ? L("已隐藏", "hidden") : ""].filter(Boolean).join(" · ");
      labels += `<text class="tl ${n.kind} ${sel.id === n.id ? "sel" : ""} ${d !== null ? "pop" : ""}" data-tnode="${n.id}" x="${lx.toFixed(1)}" y="${(Y(n.y) - 1).toFixed(1)}" text-anchor="${right ? "start" : "end"}" style="${d !== null ? `animation-delay:${d + 320}ms` : ""}">${esc(short)}<tspan class="tm" x="${lx.toFixed(1)}" dy="14">${esc(meta)}</tspan></text>`;
    }
    let arcs = "";
    for (const n of L0.list) if (n.kind === "exchange" && n.with && L0.by.has(n.with)) {
      const o = L0.by.get(n.with), mx = (n.x + o.x) / 2 + (n.lane >= o.lane ? 60 : -60), my = (n.y + o.y) / 2;
      arcs += `<path class="xarc" d="M ${n.x} ${n.y} Q ${mx} ${my}, ${o.x} ${o.y}"><title>${esc(L("交流：", "Exchange: ") + n.title)}</title></path>`;
    }
    let links = "";
    for (const n of L0.list) for (const o of (n.links || []).map((i) => L0.by.get(i)).filter(Boolean)) {   // links you drew between two nodes
      const mx = (n.x + o.x) / 2 + (Math.abs(n.x - o.x) < 30 ? 70 : 0), my = (n.y + o.y) / 2 - 20, d = `M ${n.x} ${n.y} Q ${mx} ${my}, ${o.x} ${o.y}`;
      links += `<path class="lnk" d="${d}"/>`;
      hits += `<path class="hit lk" data-link="${n.id}|${o.id}" d="${d}"><title>${esc(L("链接：", "Link: ") + n.title + " ↔ " + o.title + L(" · 划过或点击剪断", " · swipe or click to cut"))}</title></path>`;
    }
    const sn = opts.plus && L0.by.get(sel.id);                                        // the + by the selected node: a new node, right away
    const plus = sn ? (() => { const r = Math.max(3.6, Math.min(9.5, 3.2 + Math.sqrt(sn.turns || 1) * .55)), px = sn.x + (sn.lane >= 0 ? -(r + 15) : r + 15);
      return `<g class="plus" data-plus="${sn.id}" transform="translate(${px.toFixed(1)},${sn.y.toFixed(1)})"><circle r="9"/><path d="M -4 0 H 4 M 0 -4 V 4"/><title>${esc(L("新建一个子节点", "Add a child node"))}</title></g>`; })() : "";
    const aimText = opts.aimText || T?.aim?.text || "", short = aimText.length > 30 ? aimText.slice(0, 29) + "…" : aimText;
    svg.setAttribute("viewBox", `0 0 ${L0.W} ${L0.H}`); svg.setAttribute("width", L0.W); svg.setAttribute("height", L0.H);
    svg.innerHTML = `<defs><radialGradient id="seedGlow"><stop offset="0" stop-color="${C.accent}" stop-opacity=".35"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
        <linearGradient id="ground" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      <line x1="${L0.cx - 220}" x2="${L0.cx + 220}" y1="${Y(L0.y0 + 4)}" y2="${Y(L0.y0 + 4)}" stroke="url(#ground)"/>
      <g ${flip ? `transform="translate(0 ${L0.H}) scale(1 -1)"` : ""}><g class="roots">${roots}</g><g>${edges}</g><g>${arcs}</g><g>${sap.reverse().join("")}</g><g>${twigs}</g>
      <g class="seed"><circle r="22" cx="${L0.cx}" cy="${L0.y0}" fill="url(#seedGlow)"/><circle class="seedbody" r="7.5" cx="${L0.cx}" cy="${L0.y0}"/></g>
      <g>${links}</g><g class="hits">${hits}</g><g>${dots}</g>${plus}</g>
      <text class="rootlbl" x="${L0.cx}" y="${flip ? L0.H - L0.y0 - 52 : L0.y0 + 64}" text-anchor="middle">${esc(short)}<tspan class="tm" x="${L0.cx}" dy="15">${esc(L("根", "Root"))}</tspan></text>
      <g>${labels}</g>`;
    L0.list.forEach((n) => seen.add(n.id));
    return L0;
  }

  const CSS = `
.treewrap .root { fill: none; stroke: rgba(214,167,92,.22); stroke-width: 1; stroke-linecap: round; }
.treewrap .br { fill: none; stroke: rgba(var(--ti),.34); stroke-linecap: round; }
.treewrap .br.mine { stroke: rgba(127,207,159,.62); } .treewrap .br.focus { stroke: rgba(214,167,92,.85); }
.treewrap .grow { stroke-dasharray: 1; stroke-dashoffset: 1; animation: pgaGrow 1s cubic-bezier(.3,.6,.3,1) forwards; }
@keyframes pgaGrow { to { stroke-dashoffset: 0; } }
.treewrap .sap { fill: none; stroke: rgba(240,210,160,.75); stroke-width: 1.8; stroke-linecap: round; stroke-dasharray: .04 .96; stroke-dashoffset: 1;
  animation: pgaSap 3.2s linear infinite; pointer-events: none; }
@keyframes pgaSap { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.treewrap .xarc { fill: none; stroke: rgba(143,180,255,.5); stroke-width: 1; stroke-dasharray: 3 4; }
.treewrap .shadow { fill: none; stroke: rgba(var(--ti),.28); stroke-width: .9; stroke-dasharray: 2 3; } .treewrap .shadow.live { stroke: rgba(214,167,92,.7); }
.treewrap .shadowend { fill: var(--tbg); stroke: rgba(var(--ti),.5); stroke-width: .9; cursor: pointer; } .treewrap .shadowend.live { stroke: #d6a75c; fill: rgba(214,167,92,.25); }
.treewrap .tn.exchange .body { stroke: #8fb4ff; } .treewrap text.exchange { fill: #b9cdf6; }
.treewrap .bring { fill: none; stroke-width: 2.2; pointer-events: none; } .treewrap .bring.idle { stroke: rgba(var(--ti),.14); stroke-dasharray: 2 3; }
.treewrap .twig { fill: none; stroke: rgba(var(--ti),.2); stroke-width: .8; }
.treewrap .bud { fill: var(--tbg); stroke: #d6a75c; stroke-width: .9; cursor: pointer; } .treewrap .bud:hover, .treewrap .bud.on { fill: #d6a75c; }
.treewrap .pop { opacity: 0; animation: pgaPop .6s ease forwards; } @keyframes pgaPop { to { opacity: 1; } }
.treewrap .tn { cursor: pointer; } .treewrap .tn .halo { fill: transparent; }
.treewrap .tn .body { fill: var(--tbg); stroke: rgba(var(--ti),.78); stroke-width: 1.2; transition: fill .2s, stroke .2s; }
.treewrap .tn.user .body { stroke: rgba(127,207,159,.9); } .treewrap .tn.focus .body { stroke: #d6a75c; }
.treewrap .tn:hover .body { fill: var(--tb2); } .treewrap .tn.sel .body { fill: var(--t1); stroke: var(--t1); } .treewrap .tn.sel .halo { fill: rgba(var(--ti),.07); }
.treewrap .tn .open { fill: #d6a75c; } .treewrap .tn.sel .open { fill: var(--tbg); }
.treewrap .tn.tip .halo { fill: rgba(214,167,92,.08); animation: pgaTip 3s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes pgaTip { 0%, 100% { transform: scale(.85); opacity: .35; } 50% { transform: scale(1.25); opacity: 1; } }
.treewrap .seedbody { fill: var(--tbg); stroke: #d6a75c; stroke-width: 1.2; }
.treewrap text { font: 500 12px/1 "Inter", -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; fill: rgba(var(--ti),.86); paint-order: stroke;
  stroke: rgba(var(--tbgr),.94); stroke-width: 4px; stroke-linejoin: round; cursor: pointer; letter-spacing: -.005em; }
.treewrap text.user { fill: rgba(var(--tgr),.95); } .treewrap text.sel { fill: var(--t1); font-weight: 600; }
.treewrap text .tm { font: 400 10.5px "Inter", -apple-system, "PingFang SC", sans-serif; fill: rgba(var(--t3r),.75); font-variant-numeric: tabular-nums; }
.treewrap .hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke;
  cursor: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26'><text x='3' y='20' font-size='19'>✂</text></svg>") 13 13, crosshair; }
.treewrap .hit:hover, .treewrap .hit.cut { stroke: rgba(229,140,126,.35); }
.treewrap .lnk { fill: none; stroke: rgba(214,167,92,.7); stroke-width: 1.4; stroke-dasharray: 5 4; pointer-events: none; }
.treewrap .plus { cursor: pointer; } .treewrap .plus circle { fill: var(--tbg); stroke: #d6a75c; stroke-width: 1.3; } .treewrap .plus path { stroke: #d6a75c; stroke-width: 1.6; stroke-linecap: round; }
.treewrap .plus:hover circle { fill: #d6a75c; } .treewrap .plus:hover path { stroke: var(--tbg); }
.treewrap .tn.drag { opacity: .35; } .treewrap .tn.drop .body { stroke: #d6a75c; stroke-width: 2.4; }
.treewrap .rootlbl { font-size: 12.5px; fill: rgba(214,167,92,.9); cursor: default; }`;
const THEME = `
:root { --ti: 236,236,239; --tf: 255,255,255; --tbgr: 9,9,11; --t3r: 161,161,170; --tgr: 150,220,178; --t1: #ececef; --t2: #a1a1aa; --t3: #71717a; --tbg: #0b0b0e; --tb1: #141418; --tb2: #1a1a20; }
[data-theme=light] { --ti: 24,24,27; --tf: 0,0,0; --tbgr: 255,255,255; --t3r: 82,82,91; --tgr: 34,139,84; --t1: #18181b; --t2: #52525b; --t3: #71717a; --tbg: #ffffff; --tb1: #f4f4f5; --tb2: #eef2ff; }`;
  const add = (id, css) => { if (!document.getElementById(id)) { const st = document.createElement("style"); st.id = id; st.textContent = css; document.head.appendChild(st); } };
  add("pgaThemeCss", THEME);
  add("pgaTreeCss", CSS);

  /* ---------------------------------------------------------------- names: a different person for each agent at each role */
  const NAMES = ["Ada", "Basil", "Clio", "Dorian", "Elio", "Faye", "Gideon", "Hana", "Ines", "Jonah", "Kira", "Leon", "Mira", "Nico", "Odile",
                 "Pavel", "Quinn", "Rhea", "Soren", "Talia", "Umar", "Vera", "Wren", "Yusuf", "Zora"];
  const ROLE = { lead: ["主持", "Lead"], researcher: ["研究员", "Researcher"], critic: ["审阅", "Critic"] };
  const roleName = (r) => (ROLE[r] ? L(...ROLE[r]) : r || "");
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
  function cast(notes) {
    const ids = [], who = new Map(), used = new Set();
    for (const x of notes || []) if (x.agent && x.agent !== "you" && x.kind !== "correction") { const k = `${x.agent}/${x.role || ""}`; if (!ids.includes(k)) ids.push(k); }
    for (const k of ids) { let i = hash(k) % NAMES.length; while (used.has(NAMES[i]) && used.size < NAMES.length) i = (i + 1) % NAMES.length; used.add(NAMES[i]); who.set(k, NAMES[i]); }
    return (x) => who.get(`${x.agent}/${x.role || ""}`) || x.agent || "agent";
  }
  const HUES = [212, 168, 34, 276, 340, 96, 192, 248, 14, 130];
  const hue = (name) => HUES[hash(name) % HUES.length];
  const when = (iso) => new Date(iso).toLocaleString(LANG === "en" ? "en-GB" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const KIND = { question: ["提问", "Question"], answer: ["回答", "Answer"], insight: ["发现", "Finding"], reflect: ["回顾", "Review"], correction: ["指正", "Guidance"],
                 checkpoint: ["检查点", "Checkpoint"], evolve: ["进化", "Evolution"], summary: ["总结", "Summary"], plan: ["计划", "Plan"], alternative: ["影子路线", "Shadow path"] };
  const kindName = (k) => (KIND[k] ? L(...KIND[k]) : k);

  function samples(d) {
    if (!d.samples?.length) return "";
    const f = d.fork || {};
    return `<details class="cs"><summary>${L(`${d.samples.length} 次生成`, `${d.samples.length} samples`)} · ${L("分歧", "spread")} ${(d.divergence ?? 0).toFixed(2)}${d.groups > 1 ? L(` · ${d.groups} 种结论`, ` · ${d.groups} conclusions`) : ""}${d.ideas?.length ? L(` · ${d.ideas.length} 个新想法`, ` · ${d.ideas.length} ideas`) : ""}</summary>
      ${f.score != null ? `<div class="fork">${L("为什么生成这么多次", "Why this many")}: P(fork) = ${f.score.toFixed(2)} — U ${f.U} · D ${f.D} · I ${f.I} · C ${f.C}</div>` : ""}
      <div class="spread"><i style="width:${Math.round((d.divergence ?? 0) * 100)}%"></i></div>
      ${(d.agreed || []).length ? `<div class="agreed">${L("共识", "Agreed")}: ${esc(d.agreed.join(L("；", "; ")))}</div>` : ""}
      ${(d.ideas || []).map((x) => `<div class="idea">${esc(x.idea)}</div>`).join("")}
      <div class="smps">${d.samples.map((x) => `<div class="smp1"><div class="sh"><b>${L("样本", "Sample")} ${x.n}</b><span>${esc(x.agent)}</span><span>${esc(x.angle || "")}</span><span>${Math.round((x.confidence ?? .5) * 100)}%</span></div><div class="sx" data-i18n="1">${esc(x.answer)}</div></div>`).join("")}</div></details>`;
  }

  /* the turns of a node: whoever hands out the task speaks from the right, whoever takes it on answers from the left; you are
     on the right too (in your colour); findings, reviews and shadow paths sit in the middle */
  function chat(notes, opts = {}) {
    const md = opts.md || esc, name = opts.name || cast(notes);
    let out = "", last = null, lastQ = null;
    for (const x of notes || []) {
      const d = x.data || {}, at = new Date(x.at);
      if (!last || at - last > 25 * 60 * 1000) out += `<div class="ctime">${esc(when(x.at))}</div>`;
      last = at;
      const me = x.agent === "you" || x.kind === "correction";
      if (x.kind === "conversation") {
        const nm = x.agent || d.vendor || "AI", h = hue(nm), [title, ...rest] = String(x.text || "").split("\n");
        const turns = convTurns(rest.join("\n"));
        out += `<div class="cconv"><span>${L("导入的对话", "Imported conversation")} · <b>${esc(nm)}</b>${d.messages ? L(` · ${d.messages} 条消息`, ` · ${d.messages} messages`) : ""}${d.project ? ` · ${esc(d.project)}` : ""}</span><div class="cct" data-i18n="1">${esc(title.replace(/^\[[^\]]*\]\s*/, ""))}</div></div>`;
        if (!turns.length && rest.join("").trim()) out += `<div class="cmsg left conv"><div class="cav" style="--h:${h}">${esc(nm.slice(0, 1).toUpperCase())}</div><div class="cbody"><div class="cb"><div class="ct md" data-i18n="1">${md(rest.join("\n").trim())}</div></div></div></div>`;
        for (const t of turns) {
          if (t.gap) { out += `<div class="ctime">${esc(t.gap)}</div>`; continue; }
          const you = t.who === "user";
          out += `<div class="cmsg ${you ? "right me" : "left"} conv"><div class="cav" style="--h:${h}">${you ? L("你", "Y") : esc(nm.slice(0, 1).toUpperCase())}</div><div class="cbody">
            <div class="cb"><div class="ct md" data-i18n="1">${md(t.text)}</div></div></div></div>`;
        }
        continue;
      }
      if (!me && !["question", "answer"].includes(x.kind)) {
        const insp = d.inspiration, alt = x.kind === "alternative";
        const label = alt ? `${L("影子路线", "Shadow path")} ${d.alt || ""} · ${{ shadow: L("待重新考虑", "kept for later"), promoted: L("已被提上来", "promoted"), dropped: L("已放下", "dropped") }[x.status] || ""}`
          : insp ? L("灵感", "Idea") : d.promoted ? L("重新考虑", "Reconsidered") : kindName(x.kind);
        out += `<div class="cnote ${insp ? "insp" : alt ? "alt" : x.kind}"><span class="ci">${esc(label)}${x.agent ? ` · ${esc(name(x))}` : ""}</span>
          <div class="ct md" data-i18n="1">${md(x.text)}</div>${alt && d.assumption ? `<div class="asm"><span>${L("前提", "Assumption")}</span><span data-i18n="1">${esc(d.assumption)}</span></div>` : ""}${alt && d.why ? `<div class="asm"><span>${L("回顾", "Review")}</span><span data-i18n="1">${esc(d.why)}</span></div>` : ""}</div>`;
        continue;
      }
      // who hands out the task (asks) sits on the right; who takes it on (answers) on the left
      const right = me || x.kind === "question";
      const nm = me ? L("你", "You") : name(x), h = hue(nm);
      const tag = `${kindName(x.kind)}${d.code ? " " + d.code : ""}`;
      const quote = x.kind === "answer" && d.question && lastQ !== d.code ? `<div class="cq" data-i18n="1">${esc(d.question)}</div>` : "";
      if (x.kind === "question") lastQ = d.code;
      const subs = [];
      if (x.kind === "question" && d.why) subs.push(`<span data-i18n="1">${esc(d.why)}</span>`);
      if (x.kind === "question" && x.status && !["answered", "done"].includes(x.status)) subs.push({ open: L("待研究", "open"), for_you: L("等你回答", "waiting for you"), dropped: L("已放下", "dropped") }[x.status] || x.status);
      if (x.kind === "answer" && d.confidence != null) subs.push(L(`把握 ${Math.round(d.confidence * 100)}%`, `confidence ${Math.round(d.confidence * 100)}%`));
      if (d.proposal) subs.push(L(`提出改进 ${esc(d.proposal)}`, `proposed ${esc(d.proposal)}`));
      if ((d.evidence || []).length) subs.push(d.evidence.slice(0, 4).map((e) => `<code>${esc(e)}</code>`).join(" ") + (d.evidence.length > 4 ? " …" : ""));
      out += `<div class="cmsg ${right ? "right" : "left"} ${me ? "me" : ""} ${x.kind}">
        <div class="cav" style="--h:${h}" title="${esc(nm)}">${esc(me ? L("你", "Y") : nm.slice(0, 1).toUpperCase())}</div>
        <div class="cbody"><div class="cwho"><b>${esc(nm)}</b>${!me && x.agent ? `<span>${esc(x.agent)}${x.role ? " · " + esc(roleName(x.role)) : ""}</span>` : ""}<span class="ck">${esc(tag)}</span></div>
          <div class="cb">${quote}<div class="ct md" data-i18n="1">${md(x.text)}</div>
            ${subs.length ? `<div class="csub">${subs.join(" · ")}</div>` : ""}${samples(d)}</div></div></div>`;
    }
    return `<div class="chat">${out || `<div class="ctime">${L("还没有对话", "No dialogue yet")}</div>`}</div>`;
  }
  /* an imported conversation's excerpt ("User: …" / "Assistant: …", "[... 3 more turns ...]") as its turns */
  function convTurns(text) {
    const out = []; let cur = null;
    for (const line of String(text || "").split("\n")) {
      const m = line.match(/^\s*(User|Human|用户|你|Assistant|AI|Claude|ChatGPT|助手|Model)\s*[:：]\s?(.*)$/i), gap = line.match(/^\s*\[\s*(?:\.\.\.|…)\s*(.*?)\s*(?:\.\.\.|…)?\s*\]\s*$/);
      if (m) { cur = { who: /^(user|human|用户|你)$/i.test(m[1]) ? "user" : "ai", text: m[2] }; out.push(cur); }
      else if (gap) { out.push({ gap: gap[1] ? L(`… ${gap[1].replace(/more turns?/i, "轮省略").trim()}`, `… ${gap[1]}`) : "…" }); cur = null; }
      else if (cur) cur.text += "\n" + line;
    }
    return out.filter((t) => t.gap || t.text.trim());
  }
  add("pgaChatCss", `
.chat .cconv { align-self: stretch; text-align: center; margin: 6px 0 2px; font-size: 11.5px; color: var(--t3); }
.chat .cconv b { color: var(--t2); font-weight: 600; } .chat .cconv .cct { font-size: 13px; color: var(--t1); font-weight: 600; margin-top: 2px; }
.chat .ct.md h1, .chat .ct.md h2, .chat .ct.md h3, .chat .ct.md h4 { font-size: 1em; margin: .6em 0 .3em; } .chat .ct.md strong { font-weight: 650; color: var(--t1); }
.chat .ct.md table { border-collapse: collapse; margin: .4em 0; font-size: 12.5px; } .chat .ct.md td, .chat .ct.md th { border: 1px solid rgba(var(--tf),.1); padding: 3px 7px; }
.chat .ct.md blockquote { margin: .4em 0; padding-left: 10px; border-left: 2px solid rgba(var(--tf),.15); color: var(--t2); }
.chat { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 8px; }
.chat .ctime { align-self: center; font-size: 11px; color: var(--t3); padding: 2px 0; letter-spacing: .02em; font-variant-numeric: tabular-nums; }
.chat .cmsg { display: flex; gap: 10px; align-items: flex-start; max-width: 88%; }
.chat .cmsg.right { align-self: flex-end; flex-direction: row-reverse; }
.chat .cav { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font: 600 12px/1 "Inter", -apple-system, sans-serif;
  color: hsl(var(--h) 45% 82%); background: hsl(var(--h) 25% 20%); box-shadow: inset 0 0 0 1px hsl(var(--h) 30% 32%); }
.chat .cmsg.me .cav { color: var(--tbg); background: #7fcf9f; box-shadow: none; font-size: 11px; }
.chat .cbody { min-width: 0; display: flex; flex-direction: column; } .chat .cmsg.right .cbody { align-items: flex-end; }
.chat .cwho { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: var(--t2); margin: 0 2px 4px; }
.chat .cwho b { color: var(--t1); font-weight: 600; } .chat .cwho .ck { color: var(--t3); font-size: 11px; font-variant-numeric: tabular-nums; }
.chat .cb { background: var(--tb1); border: 1px solid rgba(var(--tf),.06); border-radius: 12px; padding: 10px 14px; line-height: 1.7; font-size: 13.5px; color: var(--t1); }
.chat .cmsg.left .cb { border-top-left-radius: 4px; } .chat .cmsg.right .cb { border-top-right-radius: 4px; background: var(--tb2); }
.chat .cmsg.me .cb { background: rgba(127,207,159,.10); border-color: rgba(127,207,159,.22); }
.chat .cmsg.conv .cb { background: var(--tb1); border-style: dashed; }
.chat .ct { white-space: pre-wrap; word-break: break-word; } .chat .ct.md { white-space: normal; } .chat .ct.md p { margin: .35em 0; } .chat .ct.md > :first-child { margin-top: 0; }
.chat .ct.md ul, .chat .ct.md ol { padding-left: 20px; margin: .3em 0; } .chat code { font: 11.5px "JetBrains Mono", ui-monospace, monospace; background: rgba(var(--tf),.05); padding: 1px 5px; border-radius: 4px; }
.chat .ct.md pre { background: rgba(0,0,0,.35); padding: 10px; overflow: auto; border-radius: 8px; }
.chat .cq { font-size: 12px; color: var(--t2); border-left: 2px solid rgba(var(--tf),.14); padding-left: 9px; margin-bottom: 8px; }
.chat .csub { margin-top: 8px; font-size: 11.5px; color: var(--t3); line-height: 1.6; }
.chat .cnote { align-self: center; max-width: 82%; font-size: 12.5px; line-height: 1.65; color: var(--t2); background: rgba(var(--tf),.025);
  border: 1px solid rgba(var(--tf),.07); border-radius: 10px; padding: 9px 14px; }
.chat .cnote .ci { display: block; font-size: 10.5px; color: var(--t3); margin-bottom: 3px; letter-spacing: .03em; text-transform: uppercase; }
.chat .cnote.insp { border-color: rgba(214,167,92,.3); } .chat .cnote.insp .ci { color: #d6a75c; }
.chat .cnote.alt { border-style: dashed; border-color: rgba(var(--ti),.2); } .chat .cnote.alt .ci { color: var(--t2); }
.chat .asm { display: grid; grid-template-columns: auto 1fr; gap: 8px; margin-top: 5px; font-size: 12px; color: var(--t2); } .chat .asm span:first-child { color: var(--t3); }
.chat .cs { margin-top: 10px; } .chat .cs summary { cursor: pointer; font-size: 12px; color: #d6a75c; list-style: none; } .chat .cs summary::-webkit-details-marker { display: none; }
.chat .fork { font-size: 11.5px; color: var(--t3); margin: 6px 0; font-variant-numeric: tabular-nums; }
.chat .spread { height: 2px; background: rgba(var(--tf),.06); margin: 8px 0; border-radius: 2px; } .chat .spread i { display: block; height: 100%; background: linear-gradient(90deg, #7aa7e6, #d6a75c, #e58c7e); border-radius: 2px; }
.chat .agreed { font-size: 12px; color: var(--t2); } .chat .idea { color: #d6a75c; font-size: 12.5px; margin: 4px 0; }
.chat .smps { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin-top: 8px; }
.chat .smp1 { border: 1px solid rgba(var(--tf),.07); border-radius: 10px; padding: 9px 11px; font-size: 12.5px; background: rgba(0,0,0,.18); }
.chat .smp1 .sh { display: flex; gap: 8px; font-size: 11px; color: var(--t3); margin-bottom: 4px; } .chat .smp1 .sh b { color: var(--t1); font-weight: 600; } .chat .smp1 .sx { white-space: pre-wrap; }`);

  /* a node's summary (问 / 发现 / 定 lines, or Asked / Found / Next) as labelled rows */
  function summary(text) {
    const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const lab = /^(问|发现|定|下一步|Asked|Found|Next|Question|Finding|Decision)\s*[:：]\s*/i;
    const LBL = { "问": ["问", "Asked"], "发现": ["发现", "Found"], "定": ["定", "Next"], "下一步": ["下一步", "Next"] };
    if (lines.length && lines.every((l) => lab.test(l)))
      return `<div class="rsum">${lines.map((l) => { const m = l.match(lab); const k = LBL[m[1]] ? L(...LBL[m[1]]) : m[1]; return `<div class="rl"><span class="rk">${esc(k)}</span><span>${esc(l.slice(m[0].length))}</span></div>`; }).join("")}</div>`;
    return `<div class="rsum plain">${esc(text || "")}</div>`;
  }
  add("pgaSumCss", `.rsum { display: grid; gap: 10px; } .rsum .rl { display: grid; grid-template-columns: 52px 1fr; gap: 12px; line-height: 1.75; font-size: 14px; color: var(--t1); }
.rsum .rk { font-size: 11px; font-weight: 600; color: var(--t2); letter-spacing: .04em; text-transform: uppercase; padding-top: 3px; }
.rsum.plain { line-height: 1.8; font-size: 14px; color: var(--t1); }`);

  /* ---------------------------------------------------------------- 行为树: who did what */
  const AK = { read: [["读", "Read"], "#7aa7e6"], search: [["查", "Search"], "#6cc4b6"], web: [["网上查", "Web"], "#a48ee0"], command: [["命令", "Command"], "#d6a75c"],
               edit: [["改", "Edit"], "#e58c7e"], delegate: [["派出", "Delegate"], "var(--t2)"], other: [["其他", "Other"], "var(--t3)"] };
  const STEP = { think: ["思考", "Think"], investigate: ["研究", "Investigate"], aggregate: ["合成", "Aggregate"], evolve: ["进化", "Evolve"], reflect: ["回顾", "Review"],
                 checkpoint: ["检查点", "Checkpoint"], run: ["对话", "Chat"], answer: ["回答", "Answer"], review: ["审阅", "Review"] };
  function behaviorTree(B, node) {
    if (!B) return "";
    const T = B.totals || {};
    const pills = Object.entries(AK).filter(([k]) => T[k]).map(([k, [nm, col]]) => `<span class="bp" style="--c:${col}"><i></i>${L(...nm)} <b>${T[k]}</b></span>`).join("")
      + (B.commits?.length ? `<span class="bp" style="--c:#f0d38c"><i></i>${L("提交", "Commits")} <b>${B.commits.length}</b></span>` : "")
      + (B.proposals?.length ? `<span class="bp" style="--c:#d6a75c"><i></i>${L("改进提案", "Proposals")} <b>${B.proposals.length}</b></span>` : "");
    const run = (r) => {
      const st = r.status === "SUCCEEDED" ? "ok" : r.status === "STOPPED" ? "stop" : "bad";
      const stepName = STEP[r.step] ? L(...STEP[r.step]) : r.step_zh || r.step;
      return `<li class="bt-run ${st}"><details ${r.actions.length && r.actions.length <= 12 ? "open" : ""}><summary><span class="bt-dot"></span><span class="bt-step">${esc(stepName)}</span>${r.code ? `<span class="bt-code">${esc(r.code)}</span>` : ""}
        <span class="bt-t">${r.seconds ? `${r.seconds}s · ` : ""}${esc(when(r.at))}</span>${r.actions.length ? `<span class="bt-n">${L(`${r.actions.length + r.more} 个动作`, `${r.actions.length + r.more} actions`)}</span>` : ""}</summary>
        ${r.error ? `<div class="bt-err">${esc(r.error)}</div>` : ""}
        ${r.actions.length ? `<ul>${r.actions.map((a) => { const [nm, col] = AK[a.kind] || AK.other; return `<li class="bt-act"><span class="bt-tool" style="color:${col}">${esc(a.tool)}</span><code>${esc(a.target)}</code></li>`; }).join("")}${r.more ? `<li class="bt-act dim">${L(`…还有 ${r.more} 个`, `… ${r.more} more`)}</li>` : ""}</ul>`
          : `<div class="bt-none">${L("这次运行没有记录到工具动作", "No tool actions recorded for this run")}${r.step === "think" || r.step === "aggregate" ? L("（思考和合成只写文字）", " (thinking and aggregating only write)") : ""}</div>`}</details></li>`;
    };
    const agents = (B.agents || []).map((a) => { const h = hue(a.agent);
      return `<li class="bt-agent"><div class="bt-ah"><span class="cav" style="--h:${h}">${esc(a.agent.slice(0, 1).toUpperCase())}</span><b>${esc(a.agent)}</b><span>${L(`${a.runs.length} 次运行 · 成功 ${a.ok}${a.failed ? ` · 失败 ${a.failed}` : ""}`, `${a.runs.length} runs · ${a.ok} ok${a.failed ? ` · ${a.failed} failed` : ""}`)} · ${Math.round(a.seconds)}s</span></div><ul>${a.runs.map(run).join("")}</ul></li>`; }).join("");
    const code = (B.commits || []).length || (B.proposals || []).length ? `<li class="bt-agent"><div class="bt-ah"><span class="cav" style="--h:40">C</span><b>${L("代码", "Code")}</b><span>${L("提案和提交", "Proposals and commits")}</span></div><ul>
        ${(B.proposals || []).map((p) => `<li class="bt-act"><span class="bt-tool" style="color:#d6a75c">${L("提案", "Proposal")}</span><code>${esc(p)}</code></li>`).join("")}
        ${(B.commits || []).map((c) => `<li class="bt-act"><span class="bt-tool" style="color:#f0d38c">${L("提交", "Commit")}</span><a href="${esc(c.url || "#")}" target="_blank" rel="noopener"><code>${esc(c.sha.slice(0, 7))}</code></a><span>${esc(c.subject)}</span></li>`).join("")}</ul></li>` : "";
    return `<div class="bt"><div class="bt-pills">${pills || `<span class="dim">${L("这一段没有记录到具体动作", "No actions recorded in this stretch")}</span>`}</div>
      <div class="bt-note">${L(`${B.runs} 次运行`, `${B.runs} runs`)}${B.traced < B.runs ? L(` · 其中 ${B.traced} 次留下了工具记录（较早的运行只记录了结果）`, ` · ${B.traced} left tool traces (earlier runs only kept their results)`) : ""}</div>
      <ul class="bt-root"><li><div class="bt-ah root"><span class="cav" style="--h:40">·</span><b>${esc(node?.title || "")}</b></div><ul>${agents}${code}</ul></li></ul></div>`;
  }
  add("pgaBtCss", `
.bt-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.bt-pills .bp { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(var(--tf),.04); color: var(--t2); }
.bt-pills .bp i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); } .bt-pills .bp b { color: var(--t1); font-weight: 600; font-variant-numeric: tabular-nums; }
.bt-note { font-size: 12px; color: var(--t3); margin-bottom: 14px; }
.bt ul { list-style: none; margin: 0; padding-left: 22px; position: relative; } .bt ul.bt-root { padding-left: 0; }
.bt li { position: relative; } .bt ul ul > li::before { content: ""; position: absolute; left: -14px; top: 0; bottom: 0; border-left: 1px solid rgba(var(--tf),.08); }
.bt ul ul > li:last-child::before { bottom: auto; height: 15px; } .bt ul ul > li::after { content: ""; position: absolute; left: -14px; top: 15px; width: 10px; border-top: 1px solid rgba(var(--tf),.08); }
.bt-ah { display: flex; gap: 9px; align-items: center; padding: 5px 0; font-size: 13px; } .bt-ah b { font-weight: 600; color: var(--t1); } .bt-ah span:last-child { color: var(--t3); font-size: 12px; }
.bt-ah .cav { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font: 600 10.5px/1 "Inter", sans-serif; color: hsl(var(--h) 45% 82%); background: hsl(var(--h) 25% 20%); flex: none; }
.bt-run summary { cursor: pointer; display: flex; gap: 9px; align-items: center; padding: 4px 0; font-size: 12.5px; list-style: none; } .bt-run summary::-webkit-details-marker { display: none; }
.bt-dot { width: 6px; height: 6px; border-radius: 50%; background: #7fcf9f; flex: none; } .bt-run.bad .bt-dot { background: #e58c7e; } .bt-run.stop .bt-dot { background: var(--t3); }
.bt-step { color: var(--t1); } .bt-code { font-size: 11.5px; color: #d6a75c; font-variant-numeric: tabular-nums; }
.bt-t, .bt-n { font-size: 11.5px; color: var(--t3); font-variant-numeric: tabular-nums; } .bt-err { font-size: 12px; color: #e58c7e; margin: 2px 0 6px 15px; } .bt-none { font-size: 12px; color: var(--t3); padding: 2px 0 8px 15px; }
.bt-act { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; font-size: 12px; } .bt-act code { font: 11.5px "JetBrains Mono", ui-monospace, monospace; color: var(--t2); word-break: break-all; }
.bt-tool { font-size: 11.5px; min-width: 52px; }`);

  function setLang(l) { LANG = l === "en" ? "en" : "zh"; }
  window.PGATree = { behaviorTree, layout, draw, esc, ROW, chat, summary, hue, setLang, L: (zh, en) => L(zh, en), cast, roleName, kindName };
})();
