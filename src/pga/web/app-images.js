/* Resolve image references in the enclosing conversation's folder, through the existing file API. */
const OUTPUT_IMAGE_CACHE = new Map(), OUTPUT_IMAGES_SEEN = new WeakSet();
async function loadOutputImage(img) {
  if (OUTPUT_IMAGES_SEEN.has(img)) return;
  OUTPUT_IMAGES_SEEN.add(img);
  const path = img.dataset.localImage;
  if (!path) return;
  const key = img.closest('[data-file-key]')?.dataset.fileKey || S.chat || S.imp?.key || "";
  const uid = S.uid, cacheKey = JSON.stringify([uid, key, path]);
  let entry = OUTPUT_IMAGE_CACHE.get(cacheKey);
  if (!entry || Date.now() - entry.at > 60000) {
    entry = {at: Date.now(), promise: api(`/v1/users/${uid}/files/view`, {body: {path, key}})};
    OUTPUT_IMAGE_CACHE.set(cacheKey, entry);
    while (OUTPUT_IMAGE_CACHE.size > 64) OUTPUT_IMAGE_CACHE.delete(OUTPUT_IMAGE_CACHE.keys().next().value);
  }
  try {
    const info = await entry.promise;
    if (info.kind !== "image" || !info.url) throw new Error(L("此文件无法作为图片显示", "Cannot display this file as an image"));
    if (!img.isConnected) return;
    img.addEventListener("error", () => {
      OUTPUT_IMAGE_CACHE.delete(cacheKey);
      img.alt = L("图片加载失败，点击重新打开", "Image unavailable; click to reopen");
    }, {once: true});
    img.src = info.url;
  } catch (err) {
    if (OUTPUT_IMAGE_CACHE.get(cacheKey) === entry) OUTPUT_IMAGE_CACHE.delete(cacheKey);
    if (!img.isConnected) return;
    img.alt = L("图片暂不可用，点击查看", "Image unavailable; click to view");
    img.title = err.message;
  }
}
function loadOutputImages(root) {
  if (root.nodeType !== 1) return;
  if (root.matches('img[data-local-image]')) loadOutputImage(root);
  root.querySelectorAll('img[data-local-image]').forEach(loadOutputImage);
}
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) loadOutputImages(node);
}).observe(document.body, {childList: true, subtree: true});
loadOutputImages(document.body);
document.addEventListener("click", async e => {
  const img = e.target.closest?.('img.pga-output-image');
  if (!img || img.closest('a')) return;
  e.preventDefault();
  if (img.dataset.localImage) {
    try {
      await openPgaFile(img.dataset.localImage,
        img.closest('[data-file-key]')?.dataset.fileKey || S.chat || S.imp?.key || "", S.uid);
    } catch (err) { toast(err.message); }
  } else if (img.src) modal(`<img class="zoomimg" src="${esc(img.src)}" alt="">`);
});
