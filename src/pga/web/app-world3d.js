/* PGA app · 世界树, its 星空 mode: the world tree as a sky in three dimensions, in the spirit of PGA's first sky — the world
   a lit body in the middle, broad activities and topics as solid bodies further out, every conversation a point of light on
   the outer sphere, thin lines of the tree between them, faint stars behind. Drag to turn it, scroll to come closer. Click a
   conversation and you are in it; click a topic to read it in the side panel. Three.js (loaded the first time, through the
   import map in app.html). The data, the side panel and the bar are app-world.js's. */
const W3 = { T: null, ready: null, scene: null, cam: null, ren: null, ctl: null, raf: 0, pick: [], labels: [], hover: null, root: null, objs: new Map(), t0: 0, tween: null };

function w3Load() {
  if (W3.ready) return W3.ready;
  W3.ready = (async () => {
    W3.T = await import("three");
    W3.Orbit = (await import("three/addons/controls/OrbitControls.js")).OrbitControls;
  })();
  return W3.ready;
}
function w3Pause() { cancelAnimationFrame(W3.raf); W3.raf = 0; $("#g3dlab").innerHTML = ""; }

function w3Dot() {                                 // a soft round point
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(.35, "rgba(255,255,255,.85)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new W3.T.CanvasTexture(c); return t;
}
const w3Hue = (n, l = 0.62, s = 0.6) => { const T = W3.T; if (n.kind === "root") return new T.Color(cssv("--text") || "#eee");
  if (n.kind === "aim") return new T.Color(cssv("--accent") || "#e2b46a"); return new T.Color().setHSL(((n.hue ?? 210) % 360) / 360, s, l); };

async function w3Build() {
  const box = $("#g3d"); if (!box || G.mode !== "3d") return;
  try { await w3Load(); } catch { box.innerHTML = `<div class="empty">${L("没能载入 3D 库（three.js）", "Could not load three.js")}</div>`; return; }
  const T = W3.T;
  if (!W3.ren) {
    W3.ren = new T.WebGLRenderer({ antialias: true, alpha: true }); W3.ren.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    box.appendChild(W3.ren.domElement);
    W3.cam = new T.PerspectiveCamera(50, 1, 1, 20000);
    W3.ctl = new W3.Orbit(W3.cam, W3.ren.domElement); W3.ctl.enableDamping = true; W3.ctl.dampingFactor = 0.08; W3.ctl.autoRotate = true; W3.ctl.autoRotateSpeed = 0.35;
    W3.ctl.addEventListener("start", () => { W3.ctl.autoRotate = false; });
    const el = W3.ren.domElement, ray = new T.Raycaster(), m = new T.Vector2();
    const hit = (e) => { const r = el.getBoundingClientRect(); m.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(m, W3.cam); ray.params.Points.threshold = 6 * (W3.cam.position.length() / 900);
      const xs = ray.intersectObjects(W3.pick, false); if (!xs.length) return null;
      const x = xs[0]; return x.object.isPoints ? x.object.userData.nodes[x.index] : x.object.userData.node; };
    let down = null;
    el.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", (e) => { const n = hit(e); W3.hover = n?.id || null; el.style.cursor = n ? "pointer" : "grab"; tip(n ? { ...n, label: n.title, type: n.type, sub: W.showGist && n.gist ? n.gist : n.summary || n.gist || "" } : null, e); });
    el.addEventListener("pointerleave", () => { W3.hover = null; tip(null); });
    el.addEventListener("click", (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; const n = hit(e);
      if (!n) { G.sel = null; drawWorldSide(); return; }
      if (n.kind === "leaf") { openLeaf(n); return; }
      G.sel = n.id; drawWorldSide(); w3FlyTo(n); });
    new ResizeObserver(() => w3Size()).observe(box);
  }
  w3Scene(); w3Size();
  if (!W3.raf) W3.raf = requestAnimationFrame(w3Frame);
}
function w3Size() { const box = $("#g3d"); if (!box || !W3.ren) return; const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; W3.ren.setSize(w, h); W3.cam.aspect = w / h; W3.cam.updateProjectionMatrix(); }

/* positions: conversations on a sphere in tree order (Fibonacci spiral, so a topic's conversations sit together), each
   topic toward the middle of its conversations, deeper topics further out */
function w3Layout() {
  const top = W.nodes.find((n) => n.kind === "root"); if (!top) return null;
  const T = W3.T, show = (n) => !n.hidden && (W.showAgent || n.who !== "agent");
  const kids = (id) => W.nodes.filter((n) => n.parent === id && (n.kind !== "leaf" || show(n)));
  const leaves = [];
  (function dfs(n) { const ks = kids(n.id); ks.filter((k) => k.kind !== "leaf").forEach(dfs); ks.filter((k) => k.kind === "leaf").forEach((k) => leaves.push(k)); if (!ks.length && n.kind !== "root" && n.kind !== "leaf") leaves.push(n); })(top);
  const N = Math.max(leaves.length, 1), R = Math.max(380, Math.sqrt(N) * 46), phi = (Math.sqrt(5) - 1) / 2;
  const dir = new Map();
  // each broad activity gets a slice of the sphere (like the segments of an orange) in proportion to its conversations;
  // inside its slice, its topics are bands from pole to pole, in tree order — so what belongs together sits together
  const groupOf = (n) => { let x = n; while (x.parent && W.byId.get(x.parent) && W.byId.get(x.parent).kind !== "root") x = W.byId.get(x.parent); return x.id; };
  const groups = new Map(); leaves.forEach((n) => { const g = groupOf(n); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); });
  let lon0 = 0;
  for (const [, ls] of groups) {
    const span = (ls.length / N) * Math.PI * 2, m = ls.length;
    ls.forEach((n, j) => { const y = 0.92 - ((j + 0.5) / m) * 1.84, r = Math.sqrt(1 - y * y), th = lon0 + span * (0.08 + 0.84 * ((j * phi) % 1));
      dir.set(n.id, new T.Vector3(Math.cos(th) * r, y, Math.sin(th) * r)); });
    lon0 += span;
  }
  const RING = [0, 0.36, 0.58, 0.76, 0.86];
  const depthOf = (n) => { let d = 0, x = n; while (x.parent && W.byId.get(x.parent)) { d++; x = W.byId.get(x.parent); } return d; };
  (function up(n) { const ks = kids(n.id); if (!ks.length) return dir.get(n.id) || new T.Vector3(0, 1, 0);
    const v = new T.Vector3(); ks.forEach((k) => v.add(up(k))); if (v.lengthSq() < 1e-6) v.set(0, 1, 0); v.normalize(); if (!dir.has(n.id)) dir.set(n.id, v); return v; })(top);
  // the top-level activities get their hue round the sky
  const tops = kids(top.id).filter((k) => k.kind !== "leaf"); tops.forEach((k, i) => { k.hue = Math.round((i / Math.max(1, tops.length)) * 300 + 20); });
  const hueOf = (n) => { let x = n; while (x.parent && W.byId.get(x.parent) && W.byId.get(x.parent).kind !== "root") x = W.byId.get(x.parent); return x.hue; };
  const pos = new Map();
  for (const n of W.nodes) {
    if (n.kind === "leaf" && !show(n)) continue;
    if (!dir.has(n.id) && n.kind !== "root") continue;
    const d = depthOf(n); n.depth3 = d; n.hue = n.kind === "root" ? null : hueOf(n);
    const r = n.kind === "root" ? 0 : n.kind === "leaf" ? R : R * RING[Math.min(d, 4)];
    pos.set(n.id, n.kind === "root" ? new T.Vector3() : dir.get(n.id).clone().multiplyScalar(r));
  }
  return { pos, leaves, R, kids, top };
}

function w3Scene() {
  const T = W3.T, L3 = w3Layout(); if (!L3) return;
  if (W3.scene) W3.scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  const sc = W3.scene = new T.Scene(); W3.pick = []; W3.labels = []; W3.objs = new Map(); W3.L = L3;
  sc.fog = new T.Fog(new T.Color(cssv("--bg") || "#06060a"), L3.R * 1.6, L3.R * 5);
  sc.add(new T.AmbientLight(0xffffff, 0.45));
  const key = new T.DirectionalLight(0xffffff, 1.1); key.position.set(1, 1.4, 1.2); sc.add(key);
  const core = new T.PointLight(new T.Color(cssv("--accent") || "#e2b46a"), 2.2, L3.R * 2.2, 1.2); sc.add(core);
  // stars far behind (the sky)
  { const g = new T.BufferGeometry(), n = 1600, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new T.Vector3().randomDirection().multiplyScalar(L3.R * (2.6 + Math.random() * 2.2)); a.set([v.x, v.y, v.z], i * 3); }
    g.setAttribute("position", new T.BufferAttribute(a, 3));
    sc.add(new T.Points(g, new T.PointsMaterial({ size: 2.2, sizeAttenuation: false, color: 0xffffff, transparent: true, opacity: .35, depthWrite: false }))); }
  // the tree's lines: gentle curves bowing outwards
  const lines = [], cols = [], segs = [];
  for (const n of W.nodes) {
    const p = L3.pos.get(n.id), q = n.parent && L3.pos.get(n.parent); if (!p || !q) continue;
    const mid = p.clone().add(q).multiplyScalar(0.5); const bow = mid.clone().normalize().multiplyScalar(p.distanceTo(q) * 0.12); mid.add(bow);
    const c = new T.QuadraticBezierCurve3(q, mid, p).getPoints(n.kind === "leaf" ? 6 : 12);
    const col = w3Hue(n, n.kind === "leaf" ? 0.55 : 0.6, 0.5);
    for (let i = 0; i < c.length - 1; i++) { lines.push(c[i].x, c[i].y, c[i].z, c[i + 1].x, c[i + 1].y, c[i + 1].z); cols.push(col.r, col.g, col.b, col.r, col.g, col.b); segs.push(n.id, n.id); }
  }
  { const g = new T.BufferGeometry(); g.setAttribute("position", new T.Float32BufferAttribute(lines, 3)); g.setAttribute("color", new T.Float32BufferAttribute(cols, 3));
    g.setAttribute("alpha", new T.Float32BufferAttribute(new Float32Array(segs.length).fill(.32), 1));
    W3.lines = new T.LineSegments(g, new T.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true,
      vertexShader: "attribute float alpha; varying vec3 vC; varying float vA; void main(){ vC = color; vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "varying vec3 vC; varying float vA; void main(){ gl_FragColor = vec4(vC, vA); }" }));
    W3.lines.userData.segs = segs; sc.add(W3.lines); }
  // conversations: points of light
  { const ls = W.nodes.filter((n) => n.kind === "leaf" && L3.pos.has(n.id)), g = new T.BufferGeometry(), a = new Float32Array(ls.length * 3), c = new Float32Array(ls.length * 3), sz = new Float32Array(ls.length);
    ls.forEach((n, i) => { const p = L3.pos.get(n.id); a.set([p.x, p.y, p.z], i * 3); const col = w3Hue(n, n.who === "agent" ? 0.45 : 0.7, n.who === "agent" ? 0.25 : 0.65); c.set([col.r, col.g, col.b], i * 3); sz[i] = 7 + Math.min(10, (n.turns || 1) / 6); });
    g.setAttribute("position", new T.BufferAttribute(a, 3)); g.setAttribute("color", new T.BufferAttribute(c, 3)); g.setAttribute("size", new T.BufferAttribute(sz, 1));
    g.setAttribute("alpha", new T.BufferAttribute(new Float32Array(ls.length).fill(1), 1));
    const mat = new T.ShaderMaterial({ transparent: true, depthWrite: false, vertexColors: true, uniforms: { map: { value: w3Dot() }, scale: { value: 1 } },
      vertexShader: "attribute float size; attribute float alpha; varying vec3 vC; varying float vA; void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * (900.0 / -mv.z) * (0.6 + 0.4 * alpha); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a * vA < .02) discard; gl_FragColor = vec4(vC, t.a * vA); }" });
    const pts = new T.Points(g, mat); pts.userData.nodes = ls; sc.add(pts); W3.pick.push(pts); W3.points = pts; }
  // topics, motivations and the world: solid lit bodies
  for (const n of W.nodes) {
    if (n.kind === "leaf" || !L3.pos.has(n.id)) continue;
    const r = n.kind === "root" ? 22 : n.kind === "aim" ? 11 : Math.max(5, 15 - (n.depth3 || 1) * 3 + Math.min(8, Math.sqrt(n.count || 1) * 1.3));
    const col = w3Hue(n);
    const mat = n.kind === "plan" ? new T.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: .7 })
      : new T.MeshStandardMaterial({ color: col, roughness: .45, metalness: .15, emissive: col.clone().multiplyScalar(n.kind === "root" ? .9 : .18), transparent: true });
    const m = new T.Mesh(new T.SphereGeometry(r, 32, 16), mat); m.position.copy(L3.pos.get(n.id)); m.userData.node = n; sc.add(m); W3.pick.push(m); W3.objs.set(n.id, m);
    if (n.kind === "root") { const halo = new T.Mesh(new T.SphereGeometry(r * 1.9, 32, 16), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: .07, depthWrite: false })); m.add(halo); }
    if ((n.depth3 || 0) <= 2 || n.kind === "aim") W3.labels.push({ n, r });
  }
  W3.lastSel = undefined;
  const R = L3.R; if (!W3.placed) { W3.placed = true; W3.cam.position.set(R * 0.4, R * 0.7, R * 2.7); W3.ctl.target.set(0, 0, 0); }
}

function w3Hops(id) {                     // tree distance from the selected node to every other (parent and child links)
  const adj = new Map(), add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const n of W.nodes) if (n.parent && W3.L.pos.has(n.id)) { add(n.id, n.parent); add(n.parent, n.id); }
  const d = new Map([[id, 0]]), q = [id];
  while (q.length) { const x = q.shift(); for (const y of adj.get(x) || []) if (!d.has(y)) { d.set(y, d.get(x) + 1); q.push(y); } }
  return d;
}
const w3Alpha = (h) => (h == null ? 0.04 : h <= 1 ? 1 : h === 2 ? 0.9 : h === 3 ? 0.7 : Math.max(0.04, 0.7 * Math.pow(0.45, h - 3)));
function w3Focus(sel) {
  W3.lastSel = sel; W3.hops = sel ? w3Hops(sel) : null;
  const A = (id) => (W3.hops ? w3Alpha(W3.hops.get(id)) : 1);
  if (W3.points) { const at = W3.points.geometry.getAttribute("alpha"); W3.points.userData.nodes.forEach((n, i) => { at.array[i] = A(n.id); }); at.needsUpdate = true; }
  if (W3.lines) { const at = W3.lines.geometry.getAttribute("alpha"), segs = W3.lines.userData.segs;
    for (let i = 0; i < segs.length; i++) { const n = W.byId.get(segs[i]), a = W3.hops ? Math.min(A(segs[i]), A(n?.parent)) : .32; at.array[i] = W3.hops ? Math.max(.03, a * .85) : .32; } at.needsUpdate = true; }
  for (const [id, m] of W3.objs) { const a = A(id); if (m.material) { m.material.opacity = a; m.material.depthWrite = a > .5; } }
}
function w3FlyTo(n) {
  const p = W3.L?.pos.get(n.id); if (!p) return;
  const from = W3.cam.position.clone(), fromT = W3.ctl.target.clone(), dirv = p.clone().normalize();
  const to = p.clone().add(dirv.multiplyScalar(W3.L.R * 0.9)).add(new W3.T.Vector3(0, W3.L.R * .12, 0));
  W3.tween = { t0: performance.now(), from, to, fromT, toT: p.clone().multiplyScalar(0.6) }; W3.ctl.autoRotate = false;
}
function w3Frame(now) {
  W3.raf = requestAnimationFrame(w3Frame);
  if (S.view !== "graph" || G.mode !== "3d" || !W3.scene) return;
  if (W3.tween) { const k = Math.min(1, (now - W3.tween.t0) / 900), e = 1 - Math.pow(1 - k, 3);
    W3.cam.position.lerpVectors(W3.tween.from, W3.tween.to, e); W3.ctl.target.lerpVectors(W3.tween.fromT, W3.tween.toT, e); if (k >= 1) W3.tween = null; }
  W3.ctl.update();
  const focus = G.sel || W3.hover;
  if (W3.lastSel !== (G.sel || null)) w3Focus(G.sel || null);
  for (const [id, m] of W3.objs) { const on = id === G.sel; m.scale.setScalar(on ? 1.35 + Math.sin(now / 300) * .06 : 1); }
  W3.ren.render(W3.scene, W3.cam);
  // labels: topics (and the hovered or selected body) as text beside them, fading with distance
  const box = $("#g3dlab"), w = W3.ren.domElement.clientWidth, h = W3.ren.domElement.clientHeight, v = new W3.T.Vector3();
  const items = W3.labels.slice(); if (W3.hops && W3.points) W3.points.userData.nodes.forEach((n) => { if ((W3.hops.get(n.id) ?? 99) <= 2) items.push({ n, r: 3 }); }); const hn = W3.hover && W.byId.get(W3.hover); if (hn && !items.some((x) => x.n.id === hn.id)) items.push({ n: hn, r: 4 });
  let html = ""; const taken = [];
  const cands = items.map(({ n, r }) => { const p = W3.L.pos.get(n.id); if (!p) return null; v.copy(p).project(W3.cam); if (v.z > 1) return null;
    return { n, r, x: (v.x * .5 + .5) * w, y: (-v.y * .5 + .5) * h, dist: W3.cam.position.distanceTo(p) }; }).filter(Boolean)
    .sort((a, b) => ((a.n.id === focus) ? -1 : 0) - ((b.n.id === focus) ? -1 : 0) || (a.n.depth3 || 0) - (b.n.depth3 || 0) || a.dist - b.dist);
  for (const { n, r, x, y, dist } of cands) {
    const p = W3.L.pos.get(n.id), a = Math.max(0.35, Math.min(1, 2.4 - dist / (W3.L.R * 2.2))) * (W3.hops ? w3Alpha(W3.hops.get(n.id)) : 1);
    if (W3.hops && (W3.hops.get(n.id) ?? 99) > 3 && n.id !== focus) continue;           // far from the selection: no label
    if ((n.depth3 || 0) >= 2 && n.id !== focus && dist > W3.L.R * 2.2) continue;          // deeper topics show as you come closer
    const lw = Math.min(220, (n.title || "").length * 12 + 10), lh = 18, ly = y + r * 0.6 * (h / dist);
    if (n.id !== focus && taken.some((t) => Math.abs(t.x - x) < (t.w + lw) / 2 && Math.abs(t.y - ly) < lh)) continue;
    taken.push({ x, y: ly, w: lw });
    const on = n.id === focus, text = n.kind === "leaf" ? (W.showGist && n.gist ? n.gist : n.title) : n.kind === "root" ? L("世界", "World") : n.title;
    html += `<span class="w3l d${Math.min(3, n.depth3 || 0)} ${on ? "on" : ""}" style="left:${x.toFixed(0)}px;top:${ly.toFixed(0)}px;opacity:${on ? 1 : a.toFixed(2)}">${esc(text.length > 22 ? text.slice(0, 21) + "…" : text)}${W.showGist && n.kind !== "leaf" && n.gist ? `<em>${esc(n.gist)}</em>` : ""}</span>`;
  }
  box.innerHTML = html;
}
window.addEventListener("pga:look", () => { if (G.mode === "3d" && W3.scene) w3Scene(); });
window.addEventListener("pga:theme", () => { if (G.mode === "3d" && W3.scene) w3Scene(); });
