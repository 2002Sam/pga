/* A simple file viewer using the conversation's typography and colors. */
const FILE_PANEL = { entries: new Map(), active: null, host: null };
function filePanel() {
  if (FILE_PANEL.host) return FILE_PANEL.host;
  const panel = document.createElement('section');
  panel.id = 'pgaFilePanel'; panel.hidden = true; panel.setAttribute('aria-label', L('文件查看器', 'File viewer'));
  panel.innerHTML = `<header><b>${L('文件查看', 'File viewer')}</b><span class="grow"></span>
    <button data-file-system>${L('用系统应用打开', 'Open externally')}</button>
    <button data-file-expand title="${L('展开 / 还原', 'Expand / restore')}">⛶</button>
    <button data-file-hide title="${L('收起', 'Hide')}">✕</button></header>
    <nav class="filetabs" aria-label="${L('打开的文件', 'Open files')}"></nav><div class="filepath"></div><div class="fileframes"></div>`;
  panel.querySelector('[data-file-hide]').onclick = () => { panel.hidden = true; };
  panel.querySelector('[data-file-expand]').onclick = () => panel.classList.toggle('expanded');
  panel.querySelector('[data-file-system]').onclick = async () => {
    const entry = FILE_PANEL.entries.get(FILE_PANEL.active); if (!entry) return;
    try { await api(`/v1/users/${entry.uid}/files/open`, { body: { path: entry.path, key: entry.key } }); }
    catch (err) { toast(err.message); }
  };
  document.body.append(panel); FILE_PANEL.host = panel;
  return panel;
}
function selectFile(id) {
  const panel = filePanel(), entry = FILE_PANEL.entries.get(id); if (!entry) return;
  FILE_PANEL.active = id; panel.hidden = false;
  for (const [key, item] of FILE_PANEL.entries) { item.tab.classList.toggle('on', key === id); item.body.hidden = key !== id; }
  panel.querySelector('.filepath').textContent = entry.path;
  panel.querySelector('[data-file-system]').hidden = /\.(py|js|ts|jsx|tsx|html|css|json|yaml|yml|toml|xml|sql|swift|go|rs|c|h|cpp|java|sh|mjs|svelte|log)$/i.test(entry.path);
}
async function openPgaFile(path, key, uid = S.uid) {
  // Conversation cards are frames: open in the surrounding PGA window rather than inside a tiny card.
  try { if (window.top !== window && typeof window.top.openPgaFile === 'function') return window.top.openPgaFile(path, key, uid); } catch {}
  const panel = filePanel(); panel.hidden = false;
  let info;
  try { info = await api(`/v1/users/${uid}/files/view`, { body: { path, key } }); }
  catch (err) { toast(err.message); if (!FILE_PANEL.entries.size) panel.hidden = true; return; }
  const id = `${uid}:${info.path}`;
  if (FILE_PANEL.entries.has(id)) { selectFile(id); return; }
  const tab = document.createElement('button'); tab.textContent = info.name; tab.title = info.path; tab.onclick = () => selectFile(id);
  panel.querySelector('.filetabs').append(tab);
  const body = document.createElement('div'); body.className = 'fileview';
  if (info.kind === 'external') {
    const notice = document.createElement('p'); notice.className = 'filehint'; notice.textContent = info.message; body.append(notice);
  } else if (info.kind === 'image') {
    const img = document.createElement('img'); img.src = info.url; img.alt = info.name; body.append(img);
  } else if (info.kind === 'text') {
    const content = document.createElement(info.markdown ? 'article' : 'pre');
    content.className = info.markdown ? 'filecontent md' : 'filecontent filetext';
    if (info.markdown) content.innerHTML = md(info.text); else content.textContent = info.text;
    body.append(content);
  } else {
    const frame = document.createElement('iframe'); frame.title = info.name;
    frame.src = info.url;
    if (info.text_only) {
      const note = document.createElement('div'); note.className = 'filehint'; note.textContent = L('Word 文字预览 · 完整排版请用系统应用打开', 'Word text preview · open externally for full formatting'); body.append(note);
    }
    body.append(frame);
  }
  panel.querySelector('.fileframes').append(body);
  FILE_PANEL.entries.set(id, { ...info, uid, key, tab, body }); selectFile(id);
}
