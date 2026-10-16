/* The thought tree (思考树), drawn — shared by the workbench and the tree page.
   The motivation is the root, at the bottom; the dialogue grows upward in nodes, one line of thought each. A node that
   continues its parent grows straight on (the trunk); one that splits off bends into a lane of its own (a branch).
   Sampled answers are twigs, ideas only one sample had are buds; a light rises from the root to the growing tip. */
(function () {
  const ROW = 50;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function layout(T, W, row = ROW, labelW = 0) {
    const list = (T?.nodes || []).filter((n) => n.kind !== "bud").sort((a, b) => a.seq - b.seq).map((n, i) => ({ ...n, row: i }));
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
    return { list, by, kids, H, W, cx, y0, row };
  }

  function focusPath(T) {
    const s = new Set(), by = new Map((T?.nodes || []).map((n) => [n.id, n]));
    for (let n = by.get(T?.focus), i = 0; n && i < 400; n = by.get(n.parent), i++) s.add(n.id);
    return s;
  }

  /* opts: { sel: {id, bud}, seen: Set (ids already drawn: no growth animation), aimText, row } → the layout */
  function draw(svg, T, W, opts = {}) {
    const L = layout(T, W, opts.row || ROW, (opts.labelChars || 22) * 12.5 + 20), row = L.row;
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
      const meta = [n.codes?.length ? n.codes.join("–") : "", `${n.turns} 轮`, n.samples ? `${n.samples} 次生成` : "", n.git?.commits ? `⎇ ${n.git.commits}` : ""].filter(Boolean).join(" · ");
      labels += `<text class="tl ${n.kind} ${sel.id === n.id ? "sel" : ""} ${d !== null ? "pop" : ""}" data-tnode="${n.id}" x="${lx.toFixed(1)}" y="${(n.y - 1).toFixed(1)}" text-anchor="${right ? "start" : "end"}" style="${d !== null ? `animation-delay:${d + 320}ms` : ""}">${esc(short)}<tspan class="tm" x="${lx.toFixed(1)}" dy="13">${esc(meta)}</tspan></text>`;
    }
    const aimText = opts.aimText || T?.aim?.text || "", short = aimText.length > 26 ? aimText.slice(0, 25) + "…" : aimText;
    svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`); svg.setAttribute("width", L.W); svg.setAttribute("height", L.H);
    svg.innerHTML = `<defs><radialGradient id="seedGlow"><stop offset="0" stop-color="#e9a94b" stop-opacity=".55"/><stop offset="1" stop-color="#e9a94b" stop-opacity="0"/></radialGradient>
        <linearGradient id="ground" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      <line x1="${L.cx - 230}" x2="${L.cx + 230}" y1="${L.y0 + 4}" y2="${L.y0 + 4}" stroke="url(#ground)"/>
      <g class="roots">${roots}</g><g>${edges}</g><g>${sap.reverse().join("")}</g><g>${twigs}</g>
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

  window.PGATree = { layout, draw, esc, ROW };
})();
