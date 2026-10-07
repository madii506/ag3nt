/* AG3NT: pump.fun agents, one trench job each. Every case reads public Solana data on the server;
   the only transaction this page ever asks a wallet to sign is RENT closing empty token accounts. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const S = { cfg: null, agents: [], st: null, cur: 'dev', busy: false, last: null, seen: new Set(), liveN: 0 };

  /* ---------------- utils ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  const nowS = () => Date.now() / 1000;
  function ago(t) { if (!t) return '—'; const s = Math.max(0, nowS() - t); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 172800 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; }
  function toast(m, ms = 2800) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); $('#sr').textContent = m; }
  async function api(path, body) {
    const r = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!j) throw new Error('request failed (' + r.status + ')');
    if (!r.ok && j.ok === false && !j.verdict) throw new Error(j.error || ('request failed (' + r.status + ')'));
    return j;
  }
  const agentOf = id => S.agents.find(a => a.id === id) || { id, name: id.toUpperCase(), role: '', look: 'vera', no: 0, input: [] };
  const ico = a => `/img/a-${a.look || 'vera'}.png`;
  const num = n => 'ag3nt/' + String(n).padStart(3, '0');
  const VWORD = { clear: 'CLEAR', caution: 'CAUTION', red: 'RED FLAG', info: 'REPORT', error: 'NO VERDICT' };
  const RANKS = [[0, 'RECRUIT'], [25, 'FIELD AGENT'], [100, 'SPECIAL AGENT'], [500, 'DIRECTOR']];
  const rankOf = n => { let i = 0; RANKS.forEach((r, k) => { if (n >= r[0]) i = k; }); return { i, name: RANKS[i][1], next: RANKS[i + 1] || null }; };

  /* ---------------- the field: chain data raining down a dot grid, a magnifying glass reading it ---------------- */
  (() => {
    const cv = $('#field'), x = cv.getContext('2d'); let W, H, D = Math.min(2, devicePixelRatio || 1), raf = 0, last = 0;
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', CH = () => B58[Math.random() * 58 | 0];
    const G = 22, P = { x: null, y: null, t: 0, lx: 0, ly: 0 };
    let cols = 0, runs = [], sparks = [], vel = 0, lastY = scrollY;
    const size = () => {
      W = innerWidth; H = innerHeight; cv.width = W * D; cv.height = H * D; cols = Math.ceil(W / G);
      runs = Array.from({ length: Math.round(cols / 4.2) }, () => spawn(true));
    };
    function spawn(anywhere) {
      const len = 6 + (Math.random() * 14 | 0);
      return { c: Math.random() * cols | 0, y: anywhere ? Math.random() * H : -len * 16 - Math.random() * 200, v: 40 + Math.random() * 120, len, ch: Array.from({ length: len }, CH), a: .12 + Math.random() * .2 };
    }
    addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { P.x = e.clientX; P.y = e.clientY; P.t = performance.now(); } }, { passive: true });
    size(); addEventListener('resize', size);
    function draw(t) {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(80, t - last); if (dt < 33) return; last = t;
      vel += ((scrollY - lastY) - vel) * .2; lastY = scrollY;
      x.setTransform(D, 0, 0, D, 0, 0); x.clearRect(0, 0, W, H);
      const R = Math.min(140, W * .17);
      let lx = W * (.5 + .38 * Math.sin(t / 9000)), ly = H * (.5 + .34 * Math.sin(t / 6100 + 1.3));
      if (P.x != null && t - P.t < 4000) { const k = Math.min(1, (4000 - (t - P.t)) / 1200); P.lx += (P.x - P.lx) * .08; P.ly += (P.y - P.ly) * .08; lx += (P.lx - lx) * k; ly += (P.ly - ly) * k; } else { P.lx = lx; P.ly = ly; }
      // the grid
      const sy = (scrollY * .15) % G;
      x.fillStyle = 'rgba(20,20,22,.10)';
      for (let yy = -G; yy < H + G; yy += G) for (let xx = 0; xx < W + G; xx += G) { const px = xx + ((yy / G | 0) % 2) * G / 2, py = yy - sy; if (Math.hypot(px - lx, py - ly) > R) x.fillRect(px - .7, py - .7, 1.4, 1.4); }
      // the rain: base58 runs falling down columns, a dark head and a fading tail; scrolling speeds them up
      x.textAlign = 'center'; x.textBaseline = 'middle';
      const boost = 1 + Math.min(4, Math.abs(vel) / 18);
      for (const r of runs) {
        r.y += r.v * boost * dt / 1000;
        if (Math.random() < .08) r.ch[Math.random() * r.len | 0] = CH();
        const cx = r.c * G + G / 2;
        for (let i = 0; i < r.len; i++) {
          const cy = r.y - i * 16; if (cy < -20 || cy > H + 20) continue;
          const d = Math.hypot(cx - lx, cy - ly), inLens = d < R, k = inLens ? 1 - d / R : 0;
          const al = (i === 0 ? r.a * 2.4 : r.a * (1 - i / r.len)) * (inLens ? 1.8 : 1);
          x.fillStyle = `rgba(20,20,22,${Math.min(.85, al)})`;
          x.font = `${i === 0 ? 700 : 400} ${Math.round(12 + 7 * k)}px M, monospace`;
          x.fillText(r.ch[i], inLens ? lx + (cx - lx) * (1 + .25 * k) : cx, inLens ? ly + (cy - ly) * (1 + .25 * k) : cy);
        }
        if (r.y - r.len * 16 > H) Object.assign(r, spawn(false));
      }
      // churn: single characters that flash in and out on the grid
      if (Math.random() < .5) sparks.push({ x: (Math.random() * cols | 0) * G + G / 2, y: (Math.random() * (H / G) | 0) * G, life: 0, max: 8 + Math.random() * 30, ch: CH() });
      sparks = sparks.filter(sp => sp.life++ < sp.max);
      x.font = '400 11px M, monospace';
      for (const sp of sparks) { if (Math.random() < .3) sp.ch = CH(); x.fillStyle = `rgba(20,20,22,${.22 * Math.sin(Math.PI * sp.life / sp.max)})`; x.fillText(sp.ch, sp.x, sp.y); }
      // the lens: magnified dots, a rim and a handle
      for (let yy = -G; yy < H + G; yy += G) for (let xx = 0; xx < W + G; xx += G) {
        const px = xx + ((yy / G | 0) % 2) * G / 2, py = yy - sy, d = Math.hypot(px - lx, py - ly);
        if (d < R) { const k = 1 - d / R; x.fillStyle = `rgba(20,20,22,${.14 + .26 * k})`; x.beginPath(); x.arc(lx + (px - lx) * (1 + .25 * k), ly + (py - ly) * (1 + .25 * k), 1 + 2.2 * k, 0, 7); x.fill(); }
      }
      x.fillStyle = 'rgba(250,249,246,.18)'; x.beginPath(); x.arc(lx, ly, R, 0, 7); x.fill();
      x.strokeStyle = 'rgba(20,20,22,.26)'; x.lineWidth = 2.5; x.beginPath(); x.arc(lx, ly, R, 0, 7); x.stroke();
      x.lineWidth = 8; x.lineCap = 'round'; x.strokeStyle = 'rgba(20,20,22,.18)';
      x.beginPath(); x.moveTo(lx + R * .72, ly + R * .72); x.lineTo(lx + R * 1.24, ly + R * 1.24); x.stroke();
    }
    if (!reduce) { raf = requestAnimationFrame(draw); document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) { last = performance.now(); raf = requestAnimationFrame(draw); } }); }
    else draw(40);
  })();

  /* ---------------- smooth scroll: Lenis drives the page, every jump eases ---------------- */
  const NAVH = 58;
  const lenis = (!reduce && window.Lenis) ? new window.Lenis({ lerp: .085, smoothWheel: true, wheelMultiplier: .95, syncTouch: false }) : null;
  if (lenis) { const loop = t => { lenis.raf(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  const glide = {
    to(y) {
      y = Math.max(0, y);
      if (lenis) lenis.scrollTo(y, { duration: Math.min(1.6, .7 + Math.abs(y - scrollY) / 2600), easing: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 });
      else scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
    },
  };
  function goTo(sel) { const el = typeof sel === 'string' ? $(sel) : sel; if (!el) return; glide.to(el.getBoundingClientRect().top + scrollY - (el.id === 'top' ? 0 : NAVH)); }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"], a[href^="/#"]'); if (!a) return;
    const id = a.getAttribute('href').replace(/^\//, ''); const el = $(id); if (!el) return;
    e.preventDefault(); goTo(el); history.replaceState(null, '', id);
  });

  /* ---------------- hero: parallax on scroll, the agents take turns in front ---------------- */
  (() => {
    const hi = $('#heroIn'); let ticking = false;
    const apply = () => { ticking = false; const y = scrollY, h = innerHeight; if (y > h * 1.2) return; hi.style.transform = `translate3d(0,${y * .28}px,0)`; hi.style.opacity = String(Math.max(0, 1 - y / (h * .75))); };
    if (!reduce) addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }, { passive: true });
    let k = 0;
    const cycle = () => {
      if (!S.agents.length || document.hidden || scrollY > innerHeight) return;
      const box = $('#faces'), old = $('.face.on', box);
      k = (k + 1) % S.agents.length;
      const img = new Image(); img.className = 'face'; img.alt = ''; img.width = img.height = 132; img.src = ico(S.agents[k]);
      img.onload = () => { box.appendChild(img); requestAnimationFrame(() => { img.classList.add('on'); if (old) { old.classList.remove('on'); old.classList.add('off'); setTimeout(() => old.remove(), 700); } }); };
    };
    if (!reduce) setInterval(cycle, 2400);
  })();

  /* ---------------- numbers count up when they change ---------------- */
  function countUp(root) {
    $$('[data-n]', root).forEach(el => {
      const to = +el.dataset.n, from = +(el.dataset.was || 0); if (from === to || reduce) { el.textContent = to; return; }
      const t0 = performance.now(), dur = 900;
      const step = t => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  const lastN = {};

  /* ---------------- nav + reveal ---------------- */
  const navLinks = $$('#links a').filter(a => a.getAttribute('href').startsWith('#'));
  function spy() {
    let cur = null;
    for (const a of navLinks) { const s = $(a.getAttribute('href')); if (s && s.getBoundingClientRect().top < innerHeight * .35) cur = a; }
    navLinks.forEach(a => a.classList.toggle('on', a === cur));
    const ind = $('#ind');
    if (ind) { if (cur) { ind.classList.add('on'); ind.style.width = (cur.offsetWidth - 22) + 'px'; ind.style.transform = `translateX(${cur.offsetLeft + 11}px)`; } else ind.classList.remove('on'); }
  }
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('vis'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
  $$('.band h2').forEach(h => { let d = 0; h.innerHTML = h.textContent.trim().split(/\s+/).map(w => `<span class="w"><span style="--d:${d++}">${esc(w)}</span></span>`).join(' '); io.observe(h); });
  $$('.roster, .cases, .ladder, .climb, .wlist').forEach(el => { el.classList.add('stag'); io.observe(el); });
  $$('.desk, .want, .qa, .eye').forEach(el => { el.classList.add('rv'); io.observe(el); });
  $$('.ladder li').forEach((li, i) => li.style.setProperty('--i', i));
  const sweep = () => $$('.rv:not(.vis), .stag:not(.vis), .band h2:not(.vis)').forEach(el => { if (el.getBoundingClientRect().top < innerHeight) el.classList.add('vis'); });
  addEventListener('scroll', () => { spy(); sweep(); }, { passive: true }); addEventListener('hashchange', sweep); spy();

  /* ---------------- roster ---------------- */
  function renderRoster() {
    const per = (S.st && S.st.per) || {};
    $('#roster').innerHTML = S.agents.map(a => {
      const runs = per[a.id] ? per[a.id].runs : null;
      return `<div class="ag" data-a="${a.id}" role="button" tabindex="0" style="--i:${a.no}"><img src="${ico(a)}" alt=""><span class="n">${num(a.no)}</span><span class="k">${a.name}<small>${a.role}</small></span><span class="j">${esc(a.job)}<small>gadget: ${esc(a.gadget)} · needs ${a.input.length ? a.input.map(i => i === 'mint' ? 'a coin' : 'a wallet').join(' + ') : 'nothing'}</small></span><span class="rk">${rankOf(runs || 0).name}</span><span class="runs">${runs == null ? '—' : `<b data-n="${runs}" data-was="${lastN[a.id] || 0}">${lastN[a.id] || 0}</b> case${runs === 1 ? '' : 's'}`}</span><span class="go">→</span></div>`;
    }).join('');
    countUp($('#roster')); S.agents.forEach(a => { if (per[a.id]) lastN[a.id] = per[a.id].runs; });
  }
  $('#roster').addEventListener('click', e => { const r = e.target.closest('.ag'); if (r) { pick(r.dataset.a); goTo('#desk'); } });
  $('#roster').addEventListener('keydown', e => { const r = e.target.closest('.ag'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(r.dataset.a); goTo('#desk'); } });

  /* ---------------- case desk ---------------- */
  const PLAN = {
    dev: ['reading the mint', 'pulling the pump.fun record', 'finding the dev wallet', 'tracing who funded it first', 'counting its other launches'],
    bundle: ['walking back to the launch block', 'reading every buy in it', 'checking what those wallets hold now'],
    honey: ['reading the mint and its extensions', 'asking Jupiter for a 0.05 SOL buy', 'asking Jupiter to sell it straight back'],
    holders: ['reading the 20 largest token accounts', 'resolving their owners', 'labelling the curve, the pool and the dev'],
    grad: ['reading pump.fun\'s migration wallet', 'decoding each graduation', 'pricing them on Dexscreener'],
    link: ['reading both wallets\' last 1,000 transactions', 'looking for transactions that touch both', 'tracing who funded each one first'],
    watch: ['reading the last 15 transactions', 'decoding balance changes', 'naming the coins'],
    pool: ['reading live PumpSwap pools', 'pricing 24h volume against liquidity', 'ranking by fees per SOL'],
    rent: ['reading every token account you own', 'finding the empty ones', 'adding up the rent'],
  };
  const FIELDS = { mint: ['COIN ADDRESS', 'paste a mint'], wallet: ['WALLET', 'paste a wallet'] };
  function renderPick() {
    $('#pick').innerHTML = S.agents.map(a => `<button type="button" role="tab" data-a="${a.id}" class="${a.id === S.cur ? 'on' : ''}" aria-selected="${a.id === S.cur}"><img src="${ico(a)}" alt="">${String(a.no).padStart(3, '0')} <b>${a.name}</b></button>`).join('');
  }
  function renderBrief() {
    const a = agentOf(S.cur);
    $('#brief').innerHTML = `<img src="${ico(a)}" alt=""><div><b>${a.name} <small>${num(a.no)} · ${esc(a.role)} · gadget: ${esc(a.gadget)}</small></b><p>${esc(a.job)}.</p></div>`;
    const f = $('#form');
    const ins = a.input.map((t, i) => `<label>${a.input.length > 1 ? FIELDS[t][0] + (i ? ' B' : ' A') : FIELDS[t][0]}<input name="q${i ? 2 : ''}" spellcheck="false" autocapitalize="off" placeholder="${FIELDS[t][1]}"></label>`).join('');
    f.innerHTML = `${ins}<button class="run" type="submit">${a.input.length ? 'OPEN CASE' : 'RUN REPORT'}</button>`;
    f.insertAdjacentHTML('afterbegin', `<p class="reads" style="flex:1 1 100%;margin-top:0">reads ${esc(a.reads)}</p>`);
    for (const el of [$('#brief'), f]) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  }
  function pick(id, fill) {
    if (!S.agents.some(a => a.id === id) || S.busy) return;
    S.cur = id; renderPick(); renderBrief();
    if (fill) { const ins = $$('#form input'); fill.forEach((v, i) => { if (ins[i]) ins[i].value = v; }); }
    if (!S.last || S.last.agent !== id) blank();
  }
  function blank() {
    $('#fileIn').innerHTML = `<div class="blank">no case open.<div class="bar" style="width:68%"></div><div class="bar" style="width:52%"></div><div class="bar" style="width:61%"></div><div class="bar" style="width:34%"></div></div>`;
  }
  $('#pick').addEventListener('click', e => { const b = e.target.closest('button[data-a]'); if (b) pick(b.dataset.a); });
  $('#form').addEventListener('submit', e => { e.preventDefault(); run(); });

  async function run() {
    if (S.busy) return;
    const a = agentOf(S.cur), ins = $$('#form input').map(i => i.value.trim());
    for (let i = 0; i < a.input.length; i++) if (!isAddr(ins[i] || '')) { toast(`Paste a ${a.input[i] === 'mint' ? 'coin address' : 'wallet address'} first.`); $$('#form input')[i].focus(); return; }
    S.busy = true; const btn = $('#form .run'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>ON IT';
    $('#deskState').textContent = num(a.no) + ' on the case';
    const plan = PLAN[a.id] || ['working'];
    $('#fileIn').innerHTML = `<ol class="plan" id="plan"></ol>`;
    let k = 0; const tick = () => { if (k >= plan.length) return; const ol = $('#plan'); if (!ol) return; $$('li', ol).forEach(li => li.classList.remove('do')); ol.insertAdjacentHTML('beforeend', `<li class="do">${esc(plan[k++])}</li>`); };
    tick(); const iv = setInterval(tick, 900);
    let j;
    try {
      const q = new URLSearchParams({ agent: a.id }); if (ins[0]) q.set('q', ins[0]); if (ins[1]) q.set('q2', ins[1]);
      j = await api('run?' + q);
    } catch (e) { j = { verdict: 'error', headline: e.message, agent: a.id, input: ins }; }
    clearInterval(iv);
    S.busy = false; btn.disabled = false; btn.textContent = a.input.length ? 'OPEN CASE' : 'RUN REPORT'; $('#deskState').textContent = '';
    showCase(j);
    if (j.case) { history.replaceState(null, '', '?case=' + j.case + '#desk'); loadStats(); }
  }

  function linkFor(m) {
    if (!m) return '';
    if (m.mint) return `<a href="https://pump.fun/coin/${esc(m.mint)}" target="_blank" rel="noopener">pump ↗</a> <a href="#" data-q="honey" data-v="${esc(m.mint)}">honey</a> <a href="#" data-q="dev" data-v="${esc(m.mint)}">dev</a>`;
    if (m.sig) return `<a href="https://solscan.io/tx/${esc(m.sig)}" target="_blank" rel="noopener">tx ↗</a>` + (m.addr ? ` <a href="#" data-q="watch" data-v="${esc(m.addr)}">watch</a>` : '');
    if (m.addr) return `<a href="https://solscan.io/account/${esc(m.addr)}" target="_blank" rel="noopener">solscan ↗</a> <a href="#" data-q="watch" data-v="${esc(m.addr)}">watch</a>`;
    return '';
  }
  function showCase(j) {
    S.last = j;
    const a = agentOf(j.agent || S.cur), v = j.verdict || 'error';
    const facts = (j.facts || []).map(f => {
      const val = f.addr ? `<code>${esc(f.v)}</code>${isAddr(f.addr === true ? f.v : f.addr) ? ` <a href="https://solscan.io/account/${esc(f.addr === true ? f.v : f.addr)}" target="_blank" rel="noopener">solscan ↗</a>` : ''}` : esc(f.v);
      return `<dt>${esc(f.k)}</dt><dd>${f.flag ? `<i class="${f.flag}"></i>` : ''}${val}</dd>`;
    }).join('');
    const rows = j.rows && j.rows.length ? `<div class="tw"><table><thead><tr>${(j.cols || []).map(c => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead><tbody>${j.rows.map(r => { const meta = typeof r[r.length - 1] === 'object' ? r[r.length - 1] : null; const cells = meta ? r.slice(0, -1) : r; return `<tr>${cells.map(c => `<td>${esc(c)}</td>`).join('')}<td>${linkFor(meta)}</td></tr>`; }).join('')}</tbody></table></div>` : '';
    const steps = (j.steps || []).length ? `<ol class="steps">${j.steps.map(s => `<li><span>${(s.ms / 1000).toFixed(2)}s</span>${esc(s.text)}</li>`).join('')}</ol>` : '';
    const links = (j.links || []).map(l => `<a href="${esc(l.u)}" target="_blank" rel="noopener">${esc(l.t)} ↗</a>`).join('');
    const act = j.action && j.action.kind === 'close' ? `<button class="act" type="button" data-close="${esc((j.input || [])[0] || '')}">close ${j.action.count} empty account${j.action.count === 1 ? '' : 's'} · get ${j.action.sol} SOL back</button>` : '';
    const share = j.case ? `<button type="button" data-copy="${location.origin}/?case=${j.case}">copy case link</button>` : '';
    $('#fileIn').innerHTML = `
      <div class="chead"><span><b>${j.case ? 'CASE #' + j.case : 'CASE'}</b> · ${num(a.no)} ${a.name}${j.subject ? ' · ' + esc(j.subject) : ''}</span><span>${j.at ? new Date(j.at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'just now'}${j.ms ? ' · ' + (j.ms / 1000).toFixed(1) + 's' : ''}</span></div>
      <div class="stamp v-${v}">${VWORD[v] || v.toUpperCase()}</div>
      <p class="head">${esc(j.headline || '')}</p>
      ${facts ? `<dl class="facts">${facts}</dl>` : ''}${rows}${steps}
      <div class="cfoot">${act}${share}${links}<button type="button" data-again="1">run again</button></div>`;
    $$('#fileIn .facts dt, #fileIn .facts dd').forEach((el, i) => el.style.setProperty('--k', i >> 1));
    $$('#fileIn .tw tr, #fileIn .steps li, #fileIn .cfoot > *').forEach((el, i) => el.style.setProperty('--k', i + 6));
    $('#sr').textContent = (VWORD[v] || '') + ': ' + (j.headline || '');
  }
  $('#fileIn').addEventListener('click', async e => {
    const q = e.target.closest('[data-q]'); if (q) { e.preventDefault(); pick(q.dataset.q, [q.dataset.v]); run(); return; }
    const c = e.target.closest('[data-copy]'); if (c) { navigator.clipboard && navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Case link copied')); return; }
    if (e.target.closest('[data-again]')) { const inp = (S.last && S.last.input) || []; pick(S.last && S.last.agent || S.cur, inp); run(); return; }
    const cl = e.target.closest('[data-close]'); if (cl) closeEmpty(cl.dataset.close);
  });

  /* ---------------- dispatch: route a sentence to the right agent ---------------- */
  const WORDS = [
    ['link', /\b(link|linked|connect|connected|same (person|owner|guy)|alts?|two wallets|related)\b/i],
    ['rent', /\b(rent|empty|reclaim|close|dust|stuck|locked sol|token accounts?)\b/i],
    ['bundle', /\b(bundl\w*|snipe\w*|sniper|launch block|first block|block 0)\b/i],
    ['honey', /\b(honey\s?pot|honey|sell|sellable|tax|freeze|frozen|scam token|can'?t sell)\b/i],
    ['holders', /\b(holders?|whales?|supply|top 10|concentrat\w*|distribution)\b/i],
    ['grad', /\b(grad\w*|migrat\w*|bonded|just (launched|graduated)|new coins?|pumpswap listings?)\b/i],
    ['pool', /\b(pools?|lp|liquidity|yield|apr|earn fees|farm)\b/i],
    ['watch', /\b(watch|track|tracking|moves?|doing|latest|activity|copy ?trade)\b/i],
    ['dev', /\b(dev|developer|creator|rug\w*|serial|deployer|who made)\b/i],
  ];
  function route(text) {
    const addrs = [...new Set(text.match(ADDR) || [])];
    const words = text.replace(ADDR, ' ');
    const hit = WORDS.find(([, re]) => re.test(words));
    const id = hit ? hit[0] : addrs.length >= 2 ? 'link' : null;
    return { id, addrs };
  }
  function dispatch(text) {
    text = text.trim(); const box = $('#route');
    if (!text) { box.innerHTML = ''; return; }
    const { id, addrs } = route(text);
    if (id) {
      const a = agentOf(id), need = a.input.length;
      box.innerHTML = `→ <b>${num(a.no)} ${a.name}</b> takes this case${need > addrs.length ? ` · paste ${need === 2 ? 'both wallets' : a.input[0] === 'mint' ? 'the coin address' : 'the wallet'} on the desk` : ''}`;
      pick(id, addrs.slice(0, need));
      goTo('#desk');
      if (need <= addrs.length) setTimeout(run, reduce ? 0 : 500);
      return;
    }
    if (addrs.length === 1) {
      const bt = id => `<button data-p="${id}">${agentOf(id).name}</button>`;
      box.innerHTML = `which case? ${['dev', 'bundle', 'honey', 'holders'].map(bt).join('')} for a coin · ${['watch', 'rent'].map(bt).join('')} for a wallet`;
      box.dataset.addr = addrs[0]; return;
    }
    box.innerHTML = `no agent does that yet. <button data-want="1">post it to WANTED</button>`;
    box.dataset.want = text;
  }
  $('#dispatch').addEventListener('submit', e => { e.preventDefault(); dispatch($('#dIn').value); });
  $('#route').addEventListener('click', e => {
    const p = e.target.closest('[data-p]'); if (p) { pick(p.dataset.p, [$('#route').dataset.addr]); goTo('#desk'); run(); return; }
    if (e.target.closest('[data-want]')) { $('#wantIn').value = $('#route').dataset.want.replace(/^an agent that\s*/i, '').slice(0, 140); goTo('#wanted'); $('#wantIn').focus(); }
  });
  $('#chips').addEventListener('click', e => { const b = e.target.closest('[data-ask]'); if (!b) return; const i = $('#dIn'); i.value = b.dataset.ask; dispatch(i.value); });

  /* ---------------- live, ranks, wanted ---------------- */
  function renderLive() {
    const st = S.st, ol = $('#cases');
    if (!st) return;
    if (!st.db) { $('#liveState').textContent = 'record offline'; ol.innerHTML = `<li class="empty">The public case record is offline right now. Agents still run; their cases just aren't kept.</li>`; return; }
    $('#liveState').className = 'state live'; $('#liveState').textContent = st.total + ' case' + (st.total === 1 ? '' : 's') + ' on record';
    const first = !S.seen.size;
    S.liveN = 0;
    ol.innerHTML = st.recent.length ? st.recent.map(c => {
      const a = agentOf(c.agent), fresh = !first && !S.seen.has(c.id); S.seen.add(c.id);
      return `<li class="${fresh ? 'new' : ''}" data-case="${c.id}" style="--i:${Math.min(12, S.liveN++)}"><span class="id">#${c.id}</span><span class="a">${a.name}</span><span class="s">${esc(c.subject || '—')}</span><span class="v v-${esc(c.verdict)}">${VWORD[c.verdict] || esc(c.verdict)}</span><span class="h">${esc(c.headline || '')}</span><span class="t">${ago(+c.at)}</span></li>`;
    }).join('') : `<li class="empty">No cases yet. The first one is yours.</li>`;
  }
  $('#cases').addEventListener('click', e => { const li = e.target.closest('[data-case]'); if (li) openCase(li.dataset.case); });
  async function openCase(id) {
    try { const j = await api('case?id=' + encodeURIComponent(id)); if (j.ok === false) throw new Error(j.error); pick(j.agent, j.input || []); showCase(j); goTo('#desk'); history.replaceState(null, '', '?case=' + id + '#desk'); }
    catch (e) { toast(e.message); }
  }
  function renderClimb() {
    const per = (S.st && S.st.per) || {};
    $('#climb').innerHTML = S.agents.map(a => {
      const n = per[a.id] ? per[a.id].runs : 0, r = rankOf(n);
      const w = Math.min(100, n / 500 * 100);
      return `<div class="cl" style="--i:${a.no}"><img src="${ico(a)}" alt=""><b>${a.name}</b><div class="track"><i data-w="${w}"></i><em style="left:5%"></em><em style="left:20%"></em></div><span>${S.st && S.st.db ? `${n} · ${r.name}${r.next ? ' · ' + (r.next[0] - n) + ' to ' + r.next[1] : ''}` : '—'}</span></div>`;
    }).join('');
    // a linear bar up to DIRECTOR (500 cases); the ticks mark FIELD AGENT (25) and SPECIAL AGENT (100)
    requestAnimationFrame(() => $$('#climb .track i').forEach(i => { i.style.width = i.dataset.w + '%'; }));
  }
  function renderWanted() {
    const st = S.st, ol = $('#wlist'); if (!st) return;
    if (!st.db) { ol.innerHTML = `<li class="empty">The request board is offline right now.</li>`; return; }
    const voted = JSON.parse(store.get('ag3nt:voted') || '[]');
    ol.innerHTML = st.wanted.length ? st.wanted.map((w, i) => `<li style="--i:${Math.min(10, i)}"><button class="vote ${voted.includes(+w.id) ? 'did' : ''}" type="button" data-vote="${w.id}">▲ ${w.votes}</button><span class="b">${esc(w.body)}</span><span class="t">${ago(+w.at)}</span></li>`).join('') : `<li class="empty">No requests yet. What should the next agent do?</li>`;
  }
  $('#wlist').addEventListener('click', async e => {
    const b = e.target.closest('[data-vote]'); if (!b) return;
    const voted = JSON.parse(store.get('ag3nt:voted') || '[]'); const id = +b.dataset.vote;
    if (voted.includes(id)) { toast('Already counted.'); return; }
    try { const j = await api('vote', { id }); if (j.ok === false) throw new Error(j.error); voted.push(id); store.set('ag3nt:voted', JSON.stringify(voted)); toast(j.counted ? 'Vote counted.' : 'Already counted.'); loadStats(); }
    catch (err) { toast(err.message); }
  });
  $('#wantForm').addEventListener('submit', async e => {
    e.preventDefault(); const v = $('#wantIn').value.trim();
    if (v.length < 8) { toast('Describe the job in a few more words.'); return; }
    try { const j = await api('wanted', { body: v }); if (j.ok === false) throw new Error(j.error); $('#wantIn').value = ''; toast('Posted to WANTED.'); loadStats(); }
    catch (err) { toast(err.message); }
  });

  function renderTape() {
    const one = S.agents.map(a => `<span class="tk" data-a="${a.id}"><img src="${ico(a)}" alt="" width="38" height="38"><b>${a.name}</b><span>${esc(a.role)} · ${esc(a.job)}</span></span>`).join('');
    $('#tin').innerHTML = one + one;
  }
  $('#tin').addEventListener('click', e => { const t = e.target.closest('.tk'); if (t) { pick(t.dataset.a); goTo('#desk'); } });
  addEventListener('resize', spy);

  /* ---------------- data ---------------- */
  async function loadCfg() {
    try {
      S.cfg = await api('config'); S.agents = S.cfg.agents;
      if (S.cfg.ca) { const c = $('#heroCa'); c.hidden = false; c.innerHTML = `$AG3NT <code>${esc(S.cfg.ca)}</code><button type="button" id="caCopy">copy</button>`; }
      const cc = $('#caCopy'); if (cc) cc.onclick = () => navigator.clipboard && navigator.clipboard.writeText(S.cfg.ca).then(() => toast('CA copied'));
      renderRoster(); renderPick(); renderBrief(); blank(); renderClimb(); renderTape();
      const m = location.search.match(/[?&]case=(\d+)/); if (m) openCase(m[1]);
    } catch (e) { setTimeout(loadCfg, 3000); }
  }
  async function loadStats() {
    try { S.st = await api('stats'); } catch (e) { S.st = S.st || { db: false }; }
    renderRoster(); renderLive(); renderClimb(); renderWanted();
  }
  setInterval(() => { if (!document.hidden) loadStats(); }, 15000);

  /* ---------------- wallet (only RENT ever asks for a signature) ---------------- */
  const W = { list: [], w: null, acct: null };
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      const ok = (w.chains || []).some(c => String(c).startsWith('solana:')) && w.features['standard:connect'] && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
      if (!ok || W.list.some(x => x.name === w.name)) return;
      W.list.push(w);
      if (!W.w && store.get('ag3nt:wallet') === w.name && w.accounts && w.accounts.length) use(w, w.accounts[0]);
      if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const wapi = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(wapi); } catch (_) { } });
  try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: wapi })); } catch (_) { }
  function use(w, acct) { W.w = w; W.acct = acct; store.set('ag3nt:wallet', w.name); $('#walletBtn').classList.add('on'); $('#walletLabel').textContent = short(acct.address); }
  function disconnect() { try { W.w && W.w.features['standard:disconnect'] && W.w.features['standard:disconnect'].disconnect(); } catch (e) { } W.w = null; W.acct = null; store.set('ag3nt:wallet', ''); $('#walletBtn').classList.remove('on'); $('#walletLabel').textContent = 'connect'; }
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  function renderWallets() {
    const box = $('#wList');
    if (W.w) {
      box.innerHTML = `<p>${esc(W.w.name)}<br><code>${esc(W.acct.address)}</code></p><button class="wopt" type="button" id="wMine">check my rent</button><button class="wopt" type="button" id="wOut">disconnect</button>`;
      $('#wMine').onclick = () => { $('#wModal').hidden = true; pick('rent', [W.acct.address]); goTo('#desk'); run(); };
      $('#wOut').onclick = () => { disconnect(); $('#wModal').hidden = true; };
      return;
    }
    if (!W.list.length) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      box.innerHTML = mobile ? `<p>Open AG3NT inside your wallet's browser:</p><a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Phantom</a><a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Solflare</a>`
        : `<p>No Solana wallet in this browser. You only need one to close empty accounts.</p><a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener">Phantom</a><a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener">Solflare</a>`;
      return;
    }
    box.innerHTML = W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}</button>`).join('');
  }
  function connect() { renderWallets(); $('#wModal').hidden = false; if (lenis) lenis.stop(); }
  new MutationObserver(() => { if (lenis && $('#wModal').hidden) lenis.start(); }).observe($('#wModal'), { attributes: true, attributeFilter: ['hidden'] });
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt[data-i]'); if (!b) return; const w = W.list[+b.dataset.i];
    try { const r = await w.features['standard:connect'].connect(); const a = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]); if (!a) throw new Error('No account shared'); $('#wModal').hidden = true; use(w, a); toast('Connected ' + short(a.address)); }
    catch (err) { toast(err && err.message ? err.message : 'Cancelled'); }
  });
  $('#walletBtn').addEventListener('click', connect);
  $('#wClose').addEventListener('click', () => { $('#wModal').hidden = true; });
  $('#wModal').addEventListener('click', e => { if (e.target.id === 'wModal') $('#wModal').hidden = true; });
  addEventListener('keydown', e => { if (e.key === 'Escape') $('#wModal').hidden = true; });
  async function waitFor(sig) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1300));
      try { const s = await api('status?sig=' + sig); if (s.err) throw Object.assign(new Error('The transaction failed on-chain.'), { chain: 1 }); if (s.status === 'confirmed' || s.status === 'finalized') return; } catch (e) { if (e.chain) throw e; }
    }
    throw new Error('Not confirmed after 90 seconds. Check Solscan before trying again.');
  }
  async function closeEmpty(addr) {
    if (!W.acct) { connect(); toast('Connect the wallet you checked.'); return; }
    if (W.acct.address !== addr) { toast('Connect the wallet you checked: ' + short(addr)); return; }
    try {
      const j = await api('close', { wallet: addr }); if (j.ok === false) throw new Error(j.error);
      const f = W.w.features, chain = 'solana:mainnet';
      for (let i = 0; i < j.txs.length; i++) {
        toast(`Sign ${i + 1} of ${j.txs.length} in your wallet`);
        const bytes = fromB64(j.txs[i].tx); let sig;
        if (f['solana:signAndSendTransaction']) { const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes }); sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); }
        else { const [o] = await f['solana:signTransaction'].signTransaction({ account: W.acct, chain, transaction: bytes }); sig = (await api('send', { tx: toB64(o.signedTransaction) })).sig; }
        await waitFor(sig);
      }
      toast(`Closed ${j.count} accounts. ${j.sol} SOL is back in your wallet.`, 5000);
      pick('rent', [addr]); run();
    } catch (e) { toast(/reject|cancel|declin/i.test(e.message) ? 'Cancelled' : e.message, 5000); }
  }

  loadCfg(); loadStats();
})();
