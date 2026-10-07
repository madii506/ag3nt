/* AG3NT: pump.fun agents, one trench job each. Every case reads public Solana data on the server;
   the only transaction this page ever asks a wallet to sign is RENT closing empty token accounts. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const S = { cfg: null, agents: [], st: null, cur: 'dev', busy: false, last: null, seen: new Set() };

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
  const agentOf = id => S.agents.find(a => a.id === id) || { id, name: id.toUpperCase(), no: 0, input: [] };
  const num = n => 'ag3nt/' + String(n).padStart(3, '0');
  const VWORD = { clear: 'CLEAR', caution: 'CAUTION', red: 'RED FLAG', info: 'REPORT', error: 'NO VERDICT' };
  const RANKS = [[0, 'RECRUIT'], [25, 'FIELD AGENT'], [100, 'SPECIAL AGENT'], [500, 'DIRECTOR']];
  const rankOf = n => { let i = 0; RANKS.forEach((r, k) => { if (n >= r[0]) i = k; }); return { i, name: RANKS[i][1], next: RANKS[i + 1] || null }; };

  /* ---------------- the field: a dot grid with a magnifying glass drifting over it ---------------- */
  (() => {
    const cv = $('#field'), x = cv.getContext('2d'); let W, H, D = Math.min(2, devicePixelRatio || 1), raf = 0, last = 0;
    const size = () => { W = innerWidth; H = innerHeight; cv.width = W * D; cv.height = H * D; };
    size(); addEventListener('resize', size);
    function draw(t) {
      raf = requestAnimationFrame(draw);
      if (t - last < 40) return; last = t;
      x.setTransform(D, 0, 0, D, 0, 0); x.clearRect(0, 0, W, H);
      const g = 24, R = Math.min(130, W * .16);
      const lx = W * (.5 + .38 * Math.sin(t / 9000)), ly = H * (.5 + .34 * Math.sin(t / 6100 + 1.3));
      const sy = (scrollY * .15) % g;
      for (let yy = -g; yy < H + g; yy += g) for (let xx = 0; xx < W + g; xx += g) {
        const px = xx + ((yy / g | 0) % 2) * g / 2, py = yy - sy;
        const d = Math.hypot(px - lx, py - ly);
        if (d < R) {
          const k = 1 - d / R, mx = lx + (px - lx) * (1 - .35 * k), my = ly + (py - ly) * (1 - .35 * k);
          x.fillStyle = `rgba(20,20,22,${.16 + .3 * k})`; x.beginPath(); x.arc(mx, my, 1.1 + 2.4 * k, 0, 7); x.fill();
        } else { x.fillStyle = 'rgba(20,20,22,.13)'; x.fillRect(px - .75, py - .75, 1.5, 1.5); }
      }
      x.strokeStyle = 'rgba(20,20,22,.22)'; x.lineWidth = 2; x.beginPath(); x.arc(lx, ly, R, 0, 7); x.stroke();
      x.lineWidth = 7; x.lineCap = 'round'; x.strokeStyle = 'rgba(20,20,22,.16)';
      x.beginPath(); x.moveTo(lx + R * .72, ly + R * .72); x.lineTo(lx + R * 1.22, ly + R * 1.22); x.stroke();
    }
    if (!reduce) { raf = requestAnimationFrame(draw); document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) raf = requestAnimationFrame(draw); }); }
    else draw(0);
  })();

  /* ---------------- nav + reveal ---------------- */
  const navLinks = $$('#links a').filter(a => a.getAttribute('href').startsWith('#'));
  function spy() {
    let cur = null;
    for (const a of navLinks) { const s = $(a.getAttribute('href')); if (s && s.getBoundingClientRect().top < innerHeight * .35) cur = a; }
    navLinks.forEach(a => a.classList.toggle('on', a === cur));
  }
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('vis'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -6% 0px' });
  $$('.band h2, .roster, .desk, .cases, .ladder, .climb, .want, .wlist, .qa').forEach(el => { el.classList.add('rv'); io.observe(el); });
  const sweep = () => $$('.rv:not(.vis)').forEach(el => { if (el.getBoundingClientRect().top < innerHeight) el.classList.add('vis'); });
  addEventListener('scroll', () => { spy(); sweep(); }, { passive: true }); addEventListener('hashchange', sweep); spy();

  /* ---------------- roster ---------------- */
  function renderRoster() {
    const per = (S.st && S.st.per) || {};
    $('#roster').innerHTML = S.agents.map(a => {
      const runs = per[a.id] ? per[a.id].runs : null;
      return `<div class="ag" data-a="${a.id}" role="button" tabindex="0"><img src="/img/agent.png" alt=""><span class="n">${num(a.no)}</span><span class="k">${a.name}</span><span class="j">${esc(a.job)}<small>gadget: ${esc(a.gadget)} · needs ${a.input.length ? a.input.map(i => i === 'mint' ? 'a coin' : 'a wallet').join(' + ') : 'nothing'}</small></span><span class="rk">${rankOf(runs || 0).name}</span><span class="runs">${runs == null ? '—' : runs + ' case' + (runs === 1 ? '' : 's')}</span><span class="go">→</span></div>`;
    }).join('');
  }
  $('#roster').addEventListener('click', e => { const r = e.target.closest('.ag'); if (r) { pick(r.dataset.a); $('#desk').scrollIntoView(); } });
  $('#roster').addEventListener('keydown', e => { const r = e.target.closest('.ag'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(r.dataset.a); $('#desk').scrollIntoView(); } });

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
    $('#pick').innerHTML = S.agents.map(a => `<button type="button" role="tab" data-a="${a.id}" class="${a.id === S.cur ? 'on' : ''}" aria-selected="${a.id === S.cur}"><img src="/img/agent.png" alt="">${String(a.no).padStart(3, '0')} <b>${a.name}</b></button>`).join('');
  }
  function renderBrief() {
    const a = agentOf(S.cur);
    $('#brief').innerHTML = `<img src="/img/agent.png" alt=""><div><b>${num(a.no)} ${a.name}<small>gadget: ${esc(a.gadget)}</small></b><p>${esc(a.job)}.</p></div>`;
    const f = $('#form');
    const ins = a.input.map((t, i) => `<label>${a.input.length > 1 ? FIELDS[t][0] + (i ? ' B' : ' A') : FIELDS[t][0]}<input name="q${i ? 2 : ''}" spellcheck="false" autocapitalize="off" placeholder="${FIELDS[t][1]}"></label>`).join('');
    f.innerHTML = `${ins}<button class="run" type="submit">${a.input.length ? 'OPEN CASE' : 'RUN REPORT'}</button>`;
    f.insertAdjacentHTML('afterbegin', `<p class="reads" style="flex:1 1 100%;margin-top:0">reads ${esc(a.reads)}</p>`);
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
      $('#desk').scrollIntoView();
      if (need <= addrs.length) setTimeout(run, reduce ? 0 : 500);
      return;
    }
    if (addrs.length === 1) {
      box.innerHTML = `which case? <button data-p="dev">DEV</button><button data-p="bundle">BUNDLE</button><button data-p="honey">HONEY</button><button data-p="holders">HOLDERS</button> for a coin · <button data-p="watch">WATCH</button><button data-p="rent">RENT</button> for a wallet`;
      box.dataset.addr = addrs[0]; return;
    }
    box.innerHTML = `no agent does that yet. <button data-want="1">post it to WANTED</button>`;
    box.dataset.want = text;
  }
  $('#dispatch').addEventListener('submit', e => { e.preventDefault(); dispatch($('#dIn').value); });
  $('#route').addEventListener('click', e => {
    const p = e.target.closest('[data-p]'); if (p) { pick(p.dataset.p, [$('#route').dataset.addr]); $('#desk').scrollIntoView(); run(); return; }
    if (e.target.closest('[data-want]')) { $('#wantIn').value = $('#route').dataset.want.replace(/^an agent that\s*/i, '').slice(0, 140); $('#wanted').scrollIntoView(); $('#wantIn').focus(); }
  });
  $('#chips').addEventListener('click', e => { const b = e.target.closest('[data-ask]'); if (!b) return; const i = $('#dIn'); i.value = b.dataset.ask; dispatch(i.value); });

  /* ---------------- live, ranks, wanted ---------------- */
  function renderLive() {
    const st = S.st, ol = $('#cases');
    if (!st) return;
    if (!st.db) { $('#liveState').textContent = 'record offline'; ol.innerHTML = `<li class="empty">The public case record is offline right now. Agents still run; their cases just aren't kept.</li>`; return; }
    $('#liveState').className = 'state live'; $('#liveState').textContent = st.total + ' case' + (st.total === 1 ? '' : 's') + ' on record';
    const first = !S.seen.size;
    ol.innerHTML = st.recent.length ? st.recent.map(c => {
      const a = agentOf(c.agent), fresh = !first && !S.seen.has(c.id); S.seen.add(c.id);
      return `<li class="${fresh ? 'new' : ''}" data-case="${c.id}"><span class="id">#${c.id}</span><span class="a">${a.name}</span><span class="s">${esc(c.subject || '—')}</span><span class="v v-${esc(c.verdict)}">${VWORD[c.verdict] || esc(c.verdict)}</span><span class="h">${esc(c.headline || '')}</span><span class="t">${ago(+c.at)}</span></li>`;
    }).join('') : `<li class="empty">No cases yet. The first one is yours.</li>`;
  }
  $('#cases').addEventListener('click', e => { const li = e.target.closest('[data-case]'); if (li) openCase(li.dataset.case); });
  async function openCase(id) {
    try { const j = await api('case?id=' + encodeURIComponent(id)); if (j.ok === false) throw new Error(j.error); pick(j.agent, j.input || []); showCase(j); $('#desk').scrollIntoView(); history.replaceState(null, '', '?case=' + id + '#desk'); }
    catch (e) { toast(e.message); }
  }
  function renderClimb() {
    const per = (S.st && S.st.per) || {};
    $('#climb').innerHTML = S.agents.map(a => {
      const n = per[a.id] ? per[a.id].runs : 0, r = rankOf(n);
      const w = Math.min(100, n / 500 * 100);
      return `<div class="cl"><img src="/img/agent.png" alt=""><b>${a.name}</b><div class="track"><i data-w="${w}"></i><em style="left:5%"></em><em style="left:20%"></em></div><span>${S.st && S.st.db ? `${n} · ${r.name}${r.next ? ' · ' + (r.next[0] - n) + ' to ' + r.next[1] : ''}` : '—'}</span></div>`;
    }).join('');
    // a linear bar up to DIRECTOR (500 cases); the ticks mark FIELD AGENT (25) and SPECIAL AGENT (100)
    requestAnimationFrame(() => $$('#climb .track i').forEach(i => { i.style.width = i.dataset.w + '%'; }));
  }
  function renderWanted() {
    const st = S.st, ol = $('#wlist'); if (!st) return;
    if (!st.db) { ol.innerHTML = `<li class="empty">The request board is offline right now.</li>`; return; }
    const voted = JSON.parse(store.get('ag3nt:voted') || '[]');
    ol.innerHTML = st.wanted.length ? st.wanted.map(w => `<li><button class="vote ${voted.includes(+w.id) ? 'did' : ''}" type="button" data-vote="${w.id}">▲ ${w.votes}</button><span class="b">${esc(w.body)}</span><span class="t">${ago(+w.at)}</span></li>`).join('') : `<li class="empty">No requests yet. What should the next agent do?</li>`;
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

  /* ---------------- data ---------------- */
  async function loadCfg() {
    try {
      S.cfg = await api('config'); S.agents = S.cfg.agents;
      if (S.cfg.ca) $('#scamTxt').innerHTML = `OFFICIAL TOKEN $AG3NT <code>${esc(S.cfg.ca)}</code> <button type="button" id="caCopy">copy</button> anything else is not ours.`;
      const cc = $('#caCopy'); if (cc) cc.onclick = () => navigator.clipboard && navigator.clipboard.writeText(S.cfg.ca).then(() => toast('CA copied'));
      renderRoster(); renderPick(); renderBrief(); blank(); renderClimb();
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
      $('#wMine').onclick = () => { $('#wModal').hidden = true; pick('rent', [W.acct.address]); $('#desk').scrollIntoView(); run(); };
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
  function connect() { renderWallets(); $('#wModal').hidden = false; }
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
