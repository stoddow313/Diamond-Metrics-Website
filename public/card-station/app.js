/* Diamond Metrics Player Card Station — app logic */
(() => {
  /* ======== EVENT SETTINGS — edit these ======== */
  const CONFIG = {
    year: String(new Date().getFullYear()), // shown on the front chip + back footer; '' to hide
    eventName: 'Gobbler Last Chance',       // shown on the back footer
    defaultTheme: 'blue',
    // Optional: URL that receives parent contact info as JSON (POST).
    // e.g. a Google Apps Script web app, Zapier/Make webhook, or Formspree endpoint.
    // Leave blank until the Apps Script web app is deployed.
    leadEndpoint: 'https://script.google.com/macros/s/AKfycbw1aST48E_YKzt7Up7iMnGL3QKUJbblNiqtLDfmAlRZtKtHv7FHuGhG3SWnuU5yLcB3sw/exec',
  };
  /* ============================================== */

  const R = window.CardRenderer;
  const $ = (id) => document.getElementById(id);
  const front = $('front'), back = $('back');
  const fctx = front.getContext('2d'), bctx = back.getContext('2d');

  const state = {
    theme: CONFIG.defaultTheme,
    side: 'front',
    photo: null,                 // a canvas holding the (downscaled) photo
    view: { zoom: 1, x: 0, y: -0.35 },
  };
  const assets = { photo: null, logo: null };

  /* ---------- fonts + logo, then first render ---------- */
  const FONT_URLS = {
    anton: 'assets/Anton-Regular.woff',
    medium: 'assets/BarlowCondensed-Medium.woff',
    semi: 'assets/BarlowCondensed-SemiBold.woff',
    bold: 'assets/BarlowCondensed-Bold.woff',
    heavyIt: 'assets/BarlowCondensed-ExtraBoldItalic.woff',
    logo: 'assets/logo-light.png',
  };
  async function loadFonts() {
    const faces = [
      new FontFace('Anton', `url(${FONT_URLS.anton})`, { weight: '400' }),
      new FontFace('Barlow Condensed', `url(${FONT_URLS.medium})`, { weight: '500' }),
      new FontFace('Barlow Condensed', `url(${FONT_URLS.semi})`, { weight: '600' }),
      new FontFace('Barlow Condensed', `url(${FONT_URLS.bold})`, { weight: '700' }),
      new FontFace('Barlow Condensed', `url(${FONT_URLS.heavyIt})`, { weight: '800', style: 'italic' }),
    ];
    await Promise.all(faces.map((f) => f.load().then((ff) => document.fonts.add(ff)).catch(() => {})));
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }

  /* ---------- rendering ---------- */
  const val = (id) => $(id).value;
  function data() {
    return {
      theme: state.theme, view: state.view,
      name: val('name'), number: val('number'), team: val('team'),
      position: val('position'), strengths: val('strengths'), song: val('song'),
      year: CONFIG.year, event: CONFIG.eventName,
    };
  }
  let queued = false;
  function render(both = false) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const d = data();
      if (both || state.side === 'front') R.drawFront(fctx, d, assets);
      if (both || state.side === 'back') R.drawBack(bctx, d, assets);
    });
  }
  function renderNow() {
    const d = data();
    R.drawFront(fctx, d, assets);
    R.drawBack(bctx, d, assets);
  }

  /* ---------- theme swatches ---------- */
  const sw = $('swatches');
  Object.entries(R.THEMES).forEach(([key, t]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.theme = key;
    b.setAttribute('role', 'radio');
    b.style.setProperty('--c', t.main);
    b.innerHTML = `<i></i>${t.name}`;
    sw.appendChild(b);
  });
  function setTheme(key) {
    state.theme = key;
    sw.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === key)));
    document.documentElement.style.setProperty('--theme', R.THEMES[key].main);
    render(true);
  }
  sw.addEventListener('click', (e) => { const b = e.target.closest('.swatch'); if (b) setTheme(b.dataset.theme); });

  /* ---------- side toggle ---------- */
  function setSide(side) {
    state.side = side;
    $('flipper').classList.toggle('flipped', side === 'back');
    document.querySelectorAll('.side-toggle button').forEach((b) => {
      const on = b.dataset.side === side; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
    });
    $('drag-hint').hidden = !(state.photo && side === 'front');
    render(true);
  }
  document.querySelectorAll('.side-toggle button').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));
  // Typing in a back-of-card field flips the preview so kids see it change.
  ['strengths', 'song'].forEach((id) => $(id).addEventListener('focus', () => setSide('back')));
  ['name', 'number', 'team', 'position'].forEach((id) => $(id).addEventListener('focus', () => { if (state.side !== 'front') setSide('front'); }));

  $('number').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); });
  $('card-form').addEventListener('input', () => render());
  $('card-form').addEventListener('change', () => render());

  /* ---------- photos ---------- */
  const status = $('photo-status');
  function toCanvas(src, w, h, mirror = false) {
    const max = 2400, s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const x = c.getContext('2d');
    if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function setPhoto(canvas, msg) {
    state.photo = canvas; assets.photo = canvas;
    state.view = { zoom: 1, x: 0, y: -0.35 };
    $('zoom').value = 1;
    $('photo-adjust').hidden = false;
    status.textContent = msg;
    setSide('front');
    render(true);
  }
  function clearPhoto() {
    state.photo = null; assets.photo = null;
    $('photo-adjust').hidden = true; $('drag-hint').hidden = true;
    $('photo-file').value = '';
    status.textContent = 'Use a photo from the waist up for the best card.';
    render(true);
  }
  $('remove-photo').addEventListener('click', clearPhoto);
  $('recenter').addEventListener('click', () => { state.view = { zoom: 1, x: 0, y: -0.35 }; $('zoom').value = 1; render(true); });
  $('zoom').addEventListener('input', (e) => { state.view.zoom = +e.target.value; render(true); });

  $('photo-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) { status.textContent = 'That file isn’t a photo. Try another.'; return; }
    status.textContent = 'Loading photo…';
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { setPhoto(toCanvas(img, img.naturalWidth, img.naturalHeight), 'Looking good! Drag the photo on the card to line it up.'); URL.revokeObjectURL(url); };
    img.onerror = () => { status.textContent = 'That photo couldn’t be opened. Try a JPG or PNG.'; URL.revokeObjectURL(url); };
    img.src = url;
  });

  /* camera */
  const video = $('video');
  let stream = null, facing = 'user';
  async function startCamera() {
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false,
      });
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      await video.play().catch(() => {});
      return true;
    } catch (err) {
      return false;
    }
  }
  function stopStream() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null; }
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('photo-file').click(); return; }
    $('camera-modal').hidden = false;
    const ok = await startCamera();
    if (!ok) {
      $('camera-modal').hidden = true;
      status.textContent = 'Camera is blocked here — choosing a photo instead.';
      $('photo-file').click();
    }
  }
  function closeCamera() { stopStream(); $('camera-modal').hidden = true; $('countdown').hidden = true; }
  let counting = false;
  async function shoot() {
    if (counting || !video.videoWidth) return;
    counting = true;
    const cd = $('countdown');
    cd.hidden = false;
    for (const n of [3, 2, 1]) { cd.textContent = n; await new Promise((r) => setTimeout(r, 700)); }
    cd.hidden = true; counting = false;
    if (!video.videoWidth) return;
    // Save un-mirrored so jersey lettering reads correctly.
    const c = toCanvas(video, video.videoWidth, video.videoHeight, false);
    closeCamera();
    setPhoto(c, 'Nice shot! Drag the photo on the card to line it up.');
  }
  $('open-camera').addEventListener('click', openCamera);
  $('camera-cancel').addEventListener('click', closeCamera);
  $('camera-flip').addEventListener('click', async () => { facing = facing === 'user' ? 'environment' : 'user'; await startCamera(); });
  $('shutter').addEventListener('click', shoot);

  /* drag / pinch / wheel to position the photo on the front */
  const pointers = new Map();
  let pinchStart = null;
  function overflow() {
    const p = state.photo; if (!p) return { ox: 0, oy: 0 };
    const { w, h } = R.WIN;
    const s = Math.max(w / p.width, h / p.height) * state.view.zoom;
    return { ox: p.width * s - w, oy: p.height * s - h };
  }
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  front.addEventListener('pointerdown', (e) => {
    if (!state.photo || state.side !== 'front') return;
    front.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    front.classList.add('dragging');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), z: state.view.zoom };
    }
  });
  front.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const z = Math.max(1, Math.min(3, pinchStart.z * Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.d));
      state.view.zoom = z; $('zoom').value = z; render(); return;
    }
    const k = R.W / front.getBoundingClientRect().width;
    const { ox, oy } = overflow();
    if (ox > 0) state.view.x = clamp(state.view.x - (2 * (e.clientX - prev.x) * k) / ox);
    if (oy > 0) state.view.y = clamp(state.view.y - (2 * (e.clientY - prev.y) * k) / oy);
    render();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!pointers.size) { front.classList.remove('dragging'); render(true); }
  };
  front.addEventListener('pointerup', endPointer);
  front.addEventListener('pointercancel', endPointer);
  front.addEventListener('wheel', (e) => {
    if (!state.photo || state.side !== 'front') return;
    e.preventDefault();
    state.view.zoom = Math.max(1, Math.min(3, state.view.zoom * (e.deltaY < 0 ? 1.06 : 0.94)));
    $('zoom').value = state.view.zoom; render(true);
  }, { passive: false });

  /* ---------- modals ---------- */
  function openModal(id) { $(id).hidden = false; $('app').inert = true; document.body.classList.add('modal-open'); }
  function closeModal(id) {
    $(id).hidden = true;
    if ([...document.querySelectorAll('.modal')].every((m) => m.hidden)) { $('app').inert = false; document.body.classList.remove('modal-open'); }
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));

  // consent
  $('consent-check').addEventListener('change', (e) => { $('consent-go').disabled = !e.target.checked; });
  $('consent-go').addEventListener('click', () => closeModal('consent-modal'));

  // finish → parent form
  $('finish').addEventListener('click', () => {
    const missing = [];
    if (!val('name').trim()) missing.push('name');
    if (!state.photo) missing.push('photo');
    if (missing.length) {
      const msg = missing.includes('photo') && missing.includes('name') ? 'Add a photo and your name first.'
        : missing.includes('photo') ? 'Add a photo first — it’s the best part!' : 'Add your name first.';
      status.textContent = msg;
      if (!state.photo) { status.scrollIntoView({ behavior: 'smooth', block: 'center' }); status.style.color = '#fca5a5'; setTimeout(() => (status.style.color = ''), 2500); }
      else $('name').focus();
      return;
    }
    $('parent-error').textContent = '';
    openModal('parent-modal');
    setTimeout(() => $('p-name').focus(), 50);
  });

  // parent form → build PNGs
  let outFront = null, outBack = null, outUrls = [];
  const slug = () => (val('name').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player');
  const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

  $('parent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('p-name').value.trim(), email = $('p-email').value.trim(), phone = $('p-phone').value.trim();
    const err = $('parent-error');
    if (!name) { err.textContent = 'Please enter a parent or guardian name.'; $('p-name').focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = 'Please enter a valid email.'; $('p-email').focus(); return; }
    if (phone.replace(/\D/g, '').length < 10) { err.textContent = 'Please enter a 10-digit phone number.'; $('p-phone').focus(); return; }
    err.textContent = '';
    const btn = $('parent-submit'); btn.disabled = true; btn.textContent = 'Making your card…';

    if (CONFIG.leadEndpoint) {
      const payload = {
        parentName: name, email, phone, marketingOptIn: $('p-optin').checked,
        playerName: val('name').trim(), team: val('team').trim(), event: CONFIG.eventName, createdAt: new Date().toISOString(),
      };
      fetch(CONFIG.leadEndpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }).catch(() => {});
    }

    renderNow();
    [outFront, outBack] = await Promise.all([toBlob(front), toBlob(back)]);
    outUrls.forEach((u) => URL.revokeObjectURL(u));
    outUrls = [URL.createObjectURL(outFront), URL.createObjectURL(outBack)];
    $('out-front').src = outUrls[0]; $('out-back').src = outUrls[1];
    $('dl-front').href = outUrls[0]; $('dl-front').download = `${slug()}-card-front.png`;
    $('dl-back').href = outUrls[1]; $('dl-back').download = `${slug()}-card-back.png`;
    btn.disabled = false; btn.textContent = 'Make my card';
    closeModal('parent-modal');
    openModal('result-modal');
  });

  // save
  const canShareFiles = (() => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] })); } catch { return false; }
  })();
  if (!canShareFiles) { $('save-all').textContent = 'Download both'; $('save-tip').textContent = 'Your cards save as high-resolution PNG images (2.5" × 3.5" at 600 dpi).'; }
  // When running inside a Claude artifact, downloads go through the host.
  let hostDl = null;
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then((d) => {
      hostDl = d;
      if (d) { $('save-all').textContent = 'Save both'; $('save-tip').textContent = 'High-resolution PNGs (2.5" × 3.5" at 600 dpi).'; }
    }).catch(() => {});
  }
  async function hostSave(blob, name) {
    try { await hostDl.save({ filename: name, data: blob }); } catch (e) { /* declined or unavailable */ }
  }
  $('dl-front').addEventListener('click', (e) => { if (hostDl) { e.preventDefault(); hostSave(outFront, `${slug()}-card-front.png`); } });
  $('dl-back').addEventListener('click', (e) => { if (hostDl) { e.preventDefault(); hostSave(outBack, `${slug()}-card-back.png`); } });
  $('save-all').addEventListener('click', async () => {
    if (hostDl) { await hostSave(outFront, `${slug()}-card-front.png`); await hostSave(outBack, `${slug()}-card-back.png`); return; }
    const files = [new File([outFront], `${slug()}-card-front.png`, { type: 'image/png' }), new File([outBack], `${slug()}-card-back.png`, { type: 'image/png' })];
    if (canShareFiles) {
      try { await navigator.share({ files, title: 'My Diamond Metrics card' }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    $('dl-front').click();
    setTimeout(() => $('dl-back').click(), 600);
  });
  $('edit-card').addEventListener('click', () => closeModal('result-modal'));

  /* ---------- reset ---------- */
  function resetAll(requireConsent) {
    $('card-form').reset();
    $('parent-form').reset();
    clearPhoto();
    setTheme(CONFIG.defaultTheme);
    setSide('front');
    window.scrollTo({ top: 0 });
    if (requireConsent) {
      $('consent-check').checked = false; $('consent-go').disabled = true;
      document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
      openModal('consent-modal');
    }
  }
  // Two-tap confirm (window.confirm is blocked in some embeds)
  let armed = null;
  $('start-over').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (armed) { clearTimeout(armed); armed = null; b.textContent = 'Start over'; resetAll(false); return; }
    b.textContent = 'Tap again to clear everything';
    armed = setTimeout(() => { armed = null; b.textContent = 'Start over'; }, 3000);
  });
  $('new-card').addEventListener('click', () => resetAll(true));

  /* ---------- boot ---------- */
  setTheme(CONFIG.defaultTheme);
  (async () => {
    await loadFonts();
    try { assets.logo = await loadImage(FONT_URLS.logo); } catch {}
    render(true);
  })();
  renderNow();
})();
