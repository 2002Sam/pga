/* The user avatar belongs to the signed-in user on this device. */
(() => {
  const defaultColor = '#51535c';
  const key = () => 'pga_user_avatar_v1:' + S.uid;
  const face = '<span class="user-face" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20v-1a6.5 6.5 0 0 1 13 0v1"/></svg></span>';
  let loadedKey, saved = {};
  function paint(style, avatar) {
    const image = /^data:image\/(png|jpeg|gif);base64,[a-z0-9+/=]+$/i.test(avatar?.image) ? avatar.image : '';
    const color = /^#[a-f0-9]{6}$/i.test(avatar?.color) ? avatar.color : defaultColor;
    const mark = typeof avatar?.mark === 'string' ? avatar.mark.slice(0, 12).trim() : '';
    const [r,g,b] = color.slice(1).match(/../g).map(s => parseInt(s, 16));
    style.setProperty('--user-face-bg', color);
    style.setProperty('--user-face-ink', .299*r + .587*g + .114*b > 146 ? '#171717' : '#fff');
    style.setProperty('--user-face-image', image ? 'url("' + image + '")' : 'none');
    style.setProperty('--user-face-mark', JSON.stringify(image ? '' : mark));
    style.setProperty('--user-face-icon', image || mark ? 'none' : 'block');
  }
  function readAvatar() {
    loadedKey = key();
    try { saved = JSON.parse(localStorage.getItem(loadedKey)) || {}; } catch { saved = {}; }
    paint(document.documentElement.style, saved);
  }
  window.addEventListener('storage', e => { if (!e.key || e.key === key()) readAvatar(); });
  window.pgaUserAvatarButton = () => {
    if (!S.uid) return '';
    if (loadedKey !== key()) readAvatar();
    return `<button type="button" class="user-avatar" aria-haspopup="dialog" aria-label="${L('打开我的资料', 'Open my profile')}" title="${L('我的资料', 'My profile')}">${face}</button>`;
  };

  window.openUserProfile = function (uid, opener) {
    if (!uid || S.uid !== uid || document.querySelector('#userProfile')) return;
    readAvatar();
    const dialog = document.createElement('dialog');
    dialog.id = 'userProfile';
    dialog.setAttribute('aria-labelledby', 'userProfileTitle');
    const tabs = {prefs:L('偏好配置','Preferences'), files:L('个人文件','Personal files'), avatar:L('头像设计','Avatar design')};
    const look = PGAShell.looks.look();
    const fontSize = Number(look.fs) || 0;
    const sizes = [...new Set([0,12,14,16,18,20,24,fontSize])].sort((a,b) => a-b);
    dialog.innerHTML = `<header>${face}<h2 id="userProfileTitle">${L('我的资料','My profile')}</h2><button type="button" data-dismiss aria-label="${L('关闭','Close')}">×</button></header>
      <nav aria-label="${L('资料栏目','Profile sections')}">${Object.entries(tabs).map(([id,title]) => `<button type="button" data-section="${id}" aria-controls="profile-${id}" aria-pressed="${id==='prefs'}">${title}</button>`).join('')}</nav>
      <section id="profile-prefs"><label>${L('对话字号','Conversation font size')}<select data-size>${sizes.map(n => `<option value="${n}" ${n===fontSize?'selected':''}>${n ? n+' px' : L('默认','Default')}</option>`).join('')}</select></label>
        <label>${L('对话行距','Conversation spacing')}<select data-density>${[['compact',L('紧凑','Compact')],['normal',L('标准','Normal')],['roomy',L('宽松','Roomy')]].map(([id,name]) => `<option value="${id}" ${id===look.density?'selected':''}>${name}</option>`).join('')}</select></label></section>
      <section id="profile-files" hidden><div class="profile-file-head"><span>${L('已上传的知识库文档','Uploaded knowledge documents')}</span><button data-upload>${L('添加文件','Add files')}</button></div><div data-files aria-live="polite"></div><small data-upload-status role="status"></small></section>
      <section id="profile-avatar" hidden><div class="profile-design">${face}<div><label>${L('文字或表情','Initials or emoji')}<input data-mark maxlength="12"></label><label>${L('背景色','Background colour')}<input data-color type="color"></label></div></div>
        <div class="profile-actions"><button data-photo>${L('选择图片','Choose image')}</button><input data-image type="file" accept="image/*" hidden><button data-reset>${L('恢复默认','Reset')}</button><button data-save>${L('保存头像','Save avatar')}</button></div>
        <small data-notice role="status"></small></section>`;
    const find = sel => dialog.querySelector(sel);
    const draft = {...saved}, preview = find('.profile-design .user-face');
    function updatePreview() {
      paint(preview.style, draft);
      find('[data-mark]').value = draft.mark || '';
      find('[data-color]').value = draft.color || defaultColor;
    }
    let fileRequest = 0;
    async function listFiles(updatedForest) {
      if (!dialog.isConnected) return;
      const version = ++fileRequest, box = find('[data-files]');
      box.textContent = L('正在读取…','Loading…');
      try {
        const forest = updatedForest || await api(`/v1/users/${uid}/forest${EN ? '?lang=en' : ''}`);
        if (!dialog.isConnected || version !== fileRequest) return;
        const files = forest.knowledge.filter(item => item.source === 'upload').reverse();
        box.innerHTML = files.length ? files.map(f => `<button class="profile-file" data-file="${esc(f.id)}">${esc(f.title)}</button>`).join('') : L('还没有上传文档','No uploaded documents yet');
      } catch (err) { if (version === fileRequest) box.textContent = err.message; }
    }
    for (const tab of dialog.querySelectorAll('[data-section]')) tab.onclick = () => {
      for (const btn of dialog.querySelectorAll('[data-section]')) {
        btn.setAttribute('aria-pressed', String(btn === tab));
        find('#profile-' + btn.dataset.section).hidden = btn !== tab;
      }
      if (tab.dataset.section === 'files') void listFiles();
    };
    find('[data-size]').onchange = e => PGAShell.looks.setLook({...PGAShell.looks.look(), fs:Number(e.target.value)}, {mode:false});
    find('[data-density]').onchange = e => PGAShell.looks.setLook({...PGAShell.looks.look(), density:e.target.value}, {mode:false});
    find('[data-upload]').onclick = () => uploadDoc(null, listFiles, message => { find('[data-upload-status]').textContent = message; });
    find('[data-files]').onclick = e => {
      const file = e.target.closest('[data-file]');
      if (file) { dialog.close(); showDoc(file.dataset.file); }
    };
    updatePreview();
    let imageVersion = 0;
    find('[data-mark]').oninput = e => {
      ++imageVersion;
      find('[data-save]').disabled = false;
      draft.mark = e.target.value; draft.image = ''; paint(preview.style, draft);
    };
    find('[data-color]').oninput = e => { draft.color = e.target.value; paint(preview.style, draft); };
    find('[data-photo]').onclick = () => find('[data-image]').click();
    find('[data-image]').onchange = async e => {
      const version = ++imageVersion, file = e.target.files[0];
      if (!file) return;
      find('[data-save]').disabled = true;
      try {
        const image = await apfSquare(file);
        if (version === imageVersion) { draft.image = image; updatePreview(); }
      } catch (err) { find('[data-notice]').textContent = err.message; }
      finally { if (version === imageVersion) find('[data-save]').disabled = false; }
      e.target.value = '';
    };
    find('[data-reset]').onclick = () => {
      ++imageVersion; Object.assign(draft, {image:'',mark:'',color:defaultColor});
      find('[data-save]').disabled = false; updatePreview();
    };
    find('[data-save]').onclick = () => {
      try {
        localStorage.setItem(key(), JSON.stringify(draft)); readAvatar();
        find('[data-notice]').textContent = L('头像已保存到此设备','Avatar saved on this device');
      } catch (err) { find('[data-notice]').textContent = err.message; }
    };
    find('[data-dismiss]').onclick = () => dialog.close();
    dialog.addEventListener('keydown', e => e.stopPropagation());
    dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus({preventScroll:true}); });
    document.body.appendChild(dialog);
    dialog.showModal();
  };
  document.addEventListener('click', e => {
    const button = e.target.closest('.user-avatar');
    if (!button) return;
    let host = window;
    try { if (window.top.openUserProfile && window.top.S?.uid === S.uid) host = window.top; } catch {}
    host.openUserProfile(S.uid, button);
  });
})();
