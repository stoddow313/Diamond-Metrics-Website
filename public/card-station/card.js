/* Diamond Metrics Player Card — renderer
   Draws the front and back of the card on a 1500 x 2100 canvas
   (2.5" x 3.5" at 600 dpi). Everything is drawn in code so it stays
   sharp at any size and every theme is pixel-exact. */
(function () {
  const W = 1500, H = 2100;

  const THEMES = {
    blue:   { name: 'Diamond Blue', main: '#1b7fd1', dark: '#0a2f5c', light: '#8fd0ff' },
    red:    { name: 'Cardinal Red', main: '#d0313f', dark: '#5c1019', light: '#ffb0b6' },
    green:  { name: 'Field Green',  main: '#1c9a5f', dark: '#0b3d26', light: '#93e9bd' },
    purple: { name: 'Royal Purple', main: '#7d3cc4', dark: '#2e1257', light: '#d4b2fa' },
    teal:   { name: 'Teal',         main: '#11a596', dark: '#06433e', light: '#8ff0e4' },
    gold:   { name: 'Gold Rush',    main: '#d79a1c', dark: '#4a3006', light: '#ffe08a' },
    black:  { name: 'Blackout',     main: '#5d6b7e', dark: '#0d1117', light: '#d5dde8' },
  };

  const NAVY = '#13233a', PAPER = '#f4f1ea';
  const F = {
    display: (s) => `400 ${s}px Anton, Impact, sans-serif`,
    label:   (s) => `500 ${s}px "Barlow Condensed", "Arial Narrow", sans-serif`,
    semi:    (s) => `600 ${s}px "Barlow Condensed", "Arial Narrow", sans-serif`,
    bold:    (s) => `700 ${s}px "Barlow Condensed", "Arial Narrow", sans-serif`,
    heavyIt: (s) => `italic 800 ${s}px "Barlow Condensed", "Arial Narrow", sans-serif`,
  };

  /* ---------- helpers ---------- */
  function poly(ctx, pts, r = 0) {
    ctx.beginPath();
    if (!r) { pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); return; }
    const n = pts.length;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(pts[n - 1], pts[0]);
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.arcTo(p[0], p[1], q[0], q[1], r);
    }
    ctx.closePath();
  }
  function rr(ctx, x, y, w, h, r) { poly(ctx, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r); }

  function spacedWidth(ctx, text, spacing) {
    return ctx.measureText(text).width + spacing * Math.max(0, text.length - 1);
  }
  function drawSpaced(ctx, text, x, y, spacing, align = 'left') {
    const w = spacedWidth(ctx, text, spacing);
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const prev = ctx.textAlign; ctx.textAlign = 'left';
    for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
    ctx.textAlign = prev;
    return w;
  }
  function fit(ctx, text, fontFn, maxW, start, min, spacing = 0) {
    let s = start;
    ctx.font = fontFn(s);
    while (s > min && spacedWidth(ctx, text, spacing) > maxW) { s -= 2; ctx.font = fontFn(s); }
    return s;
  }
  // Wrap text into at most maxLines lines, shrinking the font until it fits.
  function wrapFit(ctx, text, fontFn, maxW, maxH, start, min, maxLines = 3, lh = 1.12) {
    for (let s = start; s >= min; s -= 2) {
      ctx.font = fontFn(s);
      const words = text.split(/\s+/).filter(Boolean);
      const lines = []; let line = '';
      let ok = true;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width <= maxW) line = test;
        else {
          if (!line) { ok = false; break; }
          lines.push(line); line = w;
          if (ctx.measureText(w).width > maxW) { ok = false; break; }
        }
      }
      if (line) lines.push(line);
      if (ok && lines.length <= maxLines && lines.length * s * lh <= maxH) return { size: s, lines };
    }
    ctx.font = fontFn(min);
    return { size: min, lines: [text] };
  }

  function drawPhoto(ctx, img, x, y, w, h, view) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const zoom = view?.zoom || 1, px = view?.x || 0, py = view?.y || 0;
    const scale = Math.max(w / iw, h / ih) * zoom;
    const dw = iw * scale, dh = ih * scale;
    const ox = dw - w, oy = dh - h;
    const dx = x - ox / 2 - px * (ox / 2);
    const dy = y - oy / 2 - py * (oy / 2);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function placeholder(ctx, x, y, w, h, t, assets) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#2a3a52'); g.addColorStop(1, '#101a2b');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    // simple player silhouette
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    const cx = x + w / 2, cy = y + h * 0.42;
    const s = Math.min(w, h);
    ctx.beginPath(); ctx.arc(cx, cy - s * 0.12, s * 0.15, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, cy + s * 0.36, s * 0.32, s * 0.3, 0, Math.PI, 0);
    ctx.fill();
    ctx.restore();
    if (h > 600) {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = F.bold(64);
      drawSpaced(ctx, 'ADD YOUR PHOTO', cx, y + h * 0.82, 8, 'center');
    }
  }

  function base(ctx, t) {
    ctx.clearRect(0, 0, W, H);
    rr(ctx, 0, 0, W, H, 64);
    ctx.save();
    ctx.clip();
    const g = ctx.createLinearGradient(0, 0, W * 0.6, H);
    g.addColorStop(0, t.dark); g.addColorStop(1, '#050a16');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // pinstripes
    ctx.strokeStyle = 'rgba(255,255,255,.035)'; ctx.lineWidth = 3;
    for (let i = -H; i < W; i += 30) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H * 0.5, H); ctx.stroke(); }
  }
  function frameLines(ctx, t) {
    rr(ctx, 26, 26, W - 52, H - 52, 46);
    ctx.strokeStyle = t.main; ctx.lineWidth = 8; ctx.stroke();
    rr(ctx, 42, 42, W - 84, H - 84, 34);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.stroke();
  }
  function sheen(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.30, 'rgba(255,255,255,0)');
    g.addColorStop(0.38, 'rgba(255,255,255,.07)');
    g.addColorStop(0.44, 'rgba(255,255,255,0)');
    g.addColorStop(0.58, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,.05)');
    g.addColorStop(0.66, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  function slantBar(ctx, x, y, w, h, slant, fill) {
    poly(ctx, [[x, y], [x + w, y], [x + w - slant, y + h], [x - slant, y + h]]);
    ctx.fillStyle = fill; ctx.fill();
  }
  function splitName(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return { first: '', last: parts[0] || '' };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
  }
  function clean(d) {
    return {
      team: (d.team || '').trim().toUpperCase() || 'YOUR TEAM',
      number: (d.number || '').trim() || '00',
      name: (d.name || '').trim().toUpperCase() || 'PLAYER NAME',
      position: (d.position || '').trim().toUpperCase() || 'POSITION',
      strengths: (d.strengths || '').trim() || 'Add a strength',
      song: (d.song || '').trim() || 'Add your walk-up song',
      year: (d.year || '').trim(),
      event: (d.event || '').trim().toUpperCase(),
    };
  }

  /* ---------- FRONT ---------- */
  // Photo window geometry (exported so the UI can map drags onto it)
  const WIN = { x: 84, y: 84, w: 1332, h: 1556, slant: 120 };
  function windowPath(ctx) {
    const { x, y, w, h, slant } = WIN;
    poly(ctx, [[x, y], [x + w, y], [x + w, y + h - slant], [x, y + h]], 34);
  }

  function drawFront(ctx, data, assets) {
    const t = THEMES[data.theme] || THEMES.blue;
    const d = clean(data);
    base(ctx, t);

    // speed stripes bottom-right
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.9 - i * 0.28;
      slantBar(ctx, 1150 + i * 70, 1960, 38, 90, 40, t.main);
    }
    ctx.globalAlpha = 1;

    // photo
    ctx.save();
    windowPath(ctx); ctx.clip();
    if (assets.photo) drawPhoto(ctx, assets.photo, WIN.x, WIN.y, WIN.w, WIN.h, data.view);
    else placeholder(ctx, WIN.x, WIN.y, WIN.w, WIN.h, t, assets);
    // top shade for the team banner
    const tg = ctx.createLinearGradient(0, WIN.y, 0, WIN.y + 320);
    tg.addColorStop(0, 'rgba(0,0,0,.45)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = tg; ctx.fillRect(WIN.x, WIN.y, WIN.w, 320);
    // bottom shade
    const bg = ctx.createLinearGradient(0, WIN.y + WIN.h - 380, 0, WIN.y + WIN.h);
    bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, 'rgba(0,0,0,.45)');
    ctx.fillStyle = bg; ctx.fillRect(WIN.x, WIN.y + WIN.h - 380, WIN.w, 380);
    ctx.restore();

    // window border: colour band with a paper line inside
    windowPath(ctx);
    ctx.strokeStyle = t.main; ctx.lineWidth = 24; ctx.stroke();
    windowPath(ctx);
    ctx.strokeStyle = PAPER; ctx.lineWidth = 8; ctx.stroke();

    // team banner (top-left, bleeds off the card edge)
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const tSize = fit(ctx, d.team, F.heavyIt, 900, 80, 44, 2);
    const teamW = spacedWidth(ctx, d.team, 2);
    const bx = 0, by = 120, bh = 104, bw = 120 + teamW + 80;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
    poly(ctx, [[bx, by], [bx + bw + 36, by], [bx + bw, by + bh], [bx, by + bh]]);
    ctx.fillStyle = t.main; ctx.fill();
    ctx.restore();
    poly(ctx, [[bx, by + bh + 10], [bx + bw - 6, by + bh + 10], [bx + bw - 10, by + bh + 18], [bx, by + bh + 18]]);
    ctx.fillStyle = PAPER; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = F.heavyIt(tSize);
    drawSpaced(ctx, d.team, 112, by + bh / 2 + 3, 2);

    // year chip (top-right)
    if (d.year) {
      ctx.font = F.bold(52);
      const yw = spacedWidth(ctx, d.year, 4) + 56;
      const cx = WIN.x + WIN.w - 40 - yw, cy = 132;
      rr(ctx, cx, cy, yw, 80, 40);
      ctx.fillStyle = 'rgba(5,10,22,.72)'; ctx.fill();
      ctx.strokeStyle = t.light; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#fff';
      drawSpaced(ctx, d.year, cx + 28, cy + 43, 4);
    }

    // number medallion
    const mx = 245, my = WIN.y + WIN.h - 8, R = 150;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    ctx.beginPath(); ctx.arc(mx, my, R, 0, Math.PI * 2); ctx.fillStyle = PAPER; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(mx, my, R - 12, 0, Math.PI * 2); ctx.fillStyle = t.main; ctx.fill();
    const mg = ctx.createLinearGradient(mx, my - R, mx, my + R);
    mg.addColorStop(0, t.dark); mg.addColorStop(1, '#060c18');
    ctx.beginPath(); ctx.arc(mx, my, R - 30, 0, Math.PI * 2); ctx.fillStyle = mg; ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const num = d.number;
    const nSize = fit(ctx, num, F.display, 170, num.length <= 2 ? 150 : 120, 60);
    ctx.font = F.label(34); ctx.fillStyle = t.light;
    drawSpaced(ctx, 'NO.', mx, my - 62, 6, 'center');
    ctx.font = F.display(nSize); ctx.fillStyle = '#fff';
    ctx.fillText(num, mx, my + nSize * 0.5 + 8);

    // logo under the medallion
    if (assets.logo) {
      const lw = 250, lh = lw * assets.logo.height / assets.logo.width;
      ctx.drawImage(assets.logo, mx - lw / 2, 1885, lw, lh);
    }

    // name plate
    const nx = 440, maxW = 1430 - nx;
    const { first, last } = splitName(d.name);
    ctx.textAlign = 'left';
    if (first) {
      ctx.fillStyle = t.light;
      fit(ctx, first, F.semi, maxW, 70, 40, 8);
      drawSpaced(ctx, first, nx + 4, 1735, 8);
    }
    const lSize = fit(ctx, last, F.display, maxW, first ? 180 : 200, 80);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 6; ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#fff';
    ctx.fillText(last, nx, first ? 1735 + 30 + lSize * 0.92 : 1700 + lSize * 0.8);
    ctx.restore();

    // position chip
    ctx.font = F.bold(54);
    const pw = spacedWidth(ctx, d.position, 5) + 80;
    slantBar(ctx, nx + 26, 1955, pw, 80, 26, t.main);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    drawSpaced(ctx, d.position, nx + 26 + 26, 1997, 5);

    frameLines(ctx, t);
    sheen(ctx);
    ctx.restore(); // card clip
  }

  /* ---------- BACK ---------- */
  function panel(ctx, x, y, w, h, label, text, t, quote) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 10;
    rr(ctx, x, y, w, h, 28); ctx.fillStyle = PAPER; ctx.fill();
    ctx.restore();
    rr(ctx, x, y, w, h, 28); ctx.strokeStyle = t.main; ctx.lineWidth = 6; ctx.stroke();
    // tab
    ctx.font = F.heavyIt(50);
    const tw = spacedWidth(ctx, label, 4) + 90;
    slantBar(ctx, x + 40, y - 38, tw, 76, 24, t.main);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    drawSpaced(ctx, label, x + 40 + 30, y + 2, 4);
    // body
    const body = quote ? `“${text}”` : text;
    const pad = 70;
    const r = wrapFit(ctx, body, F.bold, w - pad * 2, h - 90, 92, 46, 3, 1.1);
    ctx.font = F.bold(r.size); ctx.fillStyle = NAVY; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lh = r.size * 1.1, total = lh * r.lines.length;
    const cy = y + 22 + h / 2;
    r.lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, cy - total / 2 + lh * (i + 0.5)));
  }

  function drawBack(ctx, data, assets) {
    const t = THEMES[data.theme] || THEMES.blue;
    const d = clean(data);
    base(ctx, t);

    // diamond watermark
    ctx.save();
    ctx.translate(W / 2, 1880); ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 10;
    ctx.strokeRect(-260, -260, 520, 520);
    ctx.restore();

    // header band
    const hg = ctx.createLinearGradient(0, 80, W, 400);
    hg.addColorStop(0, t.main); hg.addColorStop(1, t.dark);
    poly(ctx, [[0, 70], [W, 70], [W, 330], [0, 410]]);
    ctx.fillStyle = hg; ctx.fill();
    poly(ctx, [[0, 424], [W, 344], [W, 356], [0, 436]]);
    ctx.fillStyle = PAPER; ctx.fill();

    // big outlined number
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    const nb = fit(ctx, d.number, F.display, 420, 250, 120);
    ctx.font = F.display(nb);
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillText(d.number, 1410, 320);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.strokeText(d.number, 1410, 320);

    const { first, last } = splitName(d.name);
    ctx.textAlign = 'left';
    const nameMax = 1410 - 90 - (ctx.measureText(d.number).width + 50);
    if (first) {
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      fit(ctx, first, F.semi, nameMax, 62, 36, 8);
      drawSpaced(ctx, first, 94, 168, 8);
    }
    const ls = fit(ctx, last, F.display, nameMax, 150, 70);
    ctx.fillStyle = '#fff';
    ctx.fillText(last, 90, first ? 190 + ls * 0.9 : 140 + ls * 0.9);

    // headshot
    const cx = 290, cy = 650, R = 190;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    ctx.beginPath(); ctx.arc(cx, cy, R + 18, 0, Math.PI * 2); ctx.fillStyle = t.main; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, Math.PI * 2); ctx.fillStyle = PAPER; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, Math.PI * 2); ctx.clip();
    if (assets.photo) drawPhoto(ctx, assets.photo, cx - R, cy - R, R * 2, R * 2, data.view);
    else placeholder(ctx, cx - R, cy - R, R * 2, R * 2, t, assets);
    ctx.restore();

    // info rows
    const ix = 560, iw = 1420 - ix;
    function info(label, value, x, y, w) {
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.font = F.label(40); ctx.fillStyle = t.light;
      drawSpaced(ctx, label, x, y, 6);
      ctx.fillStyle = '#fff';
      fit(ctx, value, F.bold, w, 76, 40, 1);
      drawSpaced(ctx, value, x, y + 78, 1);
    }
    info('TEAM', d.team, ix, 545, iw);
    ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(ix, 650, iw, 3);
    info('POSITION', d.position, ix, 730, iw * 0.62);
    info('NUMBER', '#' + d.number, ix + iw * 0.68, 730, iw * 0.32);

    panel(ctx, 90, 960, 1320, 330, 'STRENGTHS', d.strengths, t, false);
    panel(ctx, 90, 1390, 1320, 330, 'WALK-UP SONG', d.song, t, true);

    // footer
    if (assets.logo) {
      const lw = 330, lh = lw * assets.logo.height / assets.logo.width;
      ctx.drawImage(assets.logo, W / 2 - lw / 2, 1785, lw, lh);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = F.label(34); ctx.fillStyle = 'rgba(255,255,255,.55)';
    const foot = [d.event, d.year ? d.year + ' SEASON' : '', 'DIAMONDMETRICS.AI'].filter(Boolean).join('  •  ');
    fit(ctx, foot, F.label, 1200, 34, 24, 4);
    drawSpaced(ctx, foot, W / 2, 2025, 4, 'center');

    frameLines(ctx, t);
    sheen(ctx);
    ctx.restore();
  }

  window.CardRenderer = { W, H, THEMES, WIN, drawFront, drawBack };
})();
