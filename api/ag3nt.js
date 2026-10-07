'use strict';
/* AG3NT: pump.fun agents, one trench job each. One serverless function behind /api/*.
 * Every agent reads public Solana data (RPC, pump.fun, Jupiter, Dexscreener). Nothing here holds a key:
 * the only transaction it builds (RENT: close empty token accounts) is signed by the user's own wallet. */
const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, AccountLayout, createCloseAccountInstruction } = require('@solana/spl-token');
const BN = require('bn.js');
const { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, canonicalPumpPoolPda, computeFeesBps } = require('@pump-fun/pump-swap-sdk');
const crypto = require('crypto');

const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const CA = E('AG3NT_CA'), XH = E('AG3NT_X');
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const DB_URL = E('DATABASE_URL') || E('POSTGRES_URL') || E('AG3NT_DATABASE_URL');
const WSOL = 'So11111111111111111111111111111111111111112';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const MIGRATOR = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ---------------- the roster ---------------- */
const AGENTS = [
  { id: 'dev', no: 1, name: 'DEV', gadget: 'magnifier', job: 'checks the dev behind any pump.fun coin', input: ['mint'], reads: 'pump.fun coin record, the dev wallet, its first funding transfer and its past launches' },
  { id: 'bundle', no: 2, name: 'BUNDLE', gadget: 'stopwatch', job: 'finds wallets that bought in the launch block', input: ['mint'], reads: 'the coin\'s first transactions, every buyer in the launch block and what they still hold' },
  { id: 'honey', no: 3, name: 'HONEY', gadget: 'jar', job: 'tells you if you can actually sell', input: ['mint'], reads: 'mint and freeze authority, Token-2022 extensions and a real Jupiter buy-then-sell round trip' },
  { id: 'holders', no: 4, name: 'HOLDERS', gadget: 'clipboard', job: 'who holds the supply, pools and curves labelled', input: ['mint'], reads: 'the 20 largest token accounts and their owners' },
  { id: 'grad', no: 5, name: 'GRAD', gadget: 'cap', job: 'coins graduating to PumpSwap right now', input: [], reads: 'pump.fun\'s migration wallet, one transaction per graduation' },
  { id: 'link', no: 6, name: 'LINK', gadget: 'string', job: 'shows if two wallets are connected', input: ['wallet', 'wallet'], reads: 'the last 1,000 transactions of both wallets and who funded each one first' },
  { id: 'watch', no: 7, name: 'WATCH', gadget: 'binoculars', job: 'a wallet\'s latest moves, decoded', input: ['wallet'], reads: 'the wallet\'s last 15 transactions, balance changes per coin' },
  { id: 'pool', no: 8, name: 'POOL', gadget: 'bucket', job: 'PumpSwap pools paying the most LP fees', input: [], reads: 'live PumpSwap pool reserves, fee tiers and 24h volume' },
  { id: 'rent', no: 9, name: 'RENT', gadget: 'keys', job: 'SOL locked in your empty token accounts', input: ['wallet'], reads: 'every SPL and Token-2022 account the wallet owns' },
];
const AG = Object.fromEntries(AGENTS.map(a => [a.id, a]));

/* ---------------- plumbing ---------------- */
function send(res, code, body, cache) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const chunks = []; for await (const c of req) { chunks.push(c); if (chunks.length > 200) break; }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (e) { return {}; }
}
const timedFetch = ms => (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
async function rpc(fn) {
  let last; for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).replace(/https?:\/\/\S+/g, '').slice(0, 120));
}
async function rpcRaw(method, params) {
  let last;
  for (const u of RPCS) {
    try {
      const r = await timedFetch(9000)(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 120));
}
async function getJson(url, ms = 7000, headers = {}) {
  const r = await timedFetch(ms)(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 ag3nt', ...headers } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
const mem = {};
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem[key] = { t: Date.now(), v, has: true }; return v; }
    catch (e) { if (c && c.has) { mem[key] = { t: c.t, v: c.v, has: true }; return c.v; } delete mem[key]; throw e; }
  })();
  mem[key] = Object.assign({}, c || {}, { p });
  return p;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
function pk(s, what) { const v = String(s || '').trim(); if (!B58.test(v)) throw http(400, `That ${what || 'address'} doesn't look like a Solana address.`); try { return new PublicKey(v); } catch (e) { throw http(400, `That ${what || 'address'} doesn't look like a Solana address.`); } }
const nowS = () => Math.floor(Date.now() / 1000);
const sol = l => Number(l) / 1e9;
const r4 = v => Math.round(v * 1e4) / 1e4;
const pct = (a, b) => b > 0 ? Math.round(a / b * 10000) / 100 : 0;
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
const ago = t => { if (!t) return '—'; const s = Math.max(0, nowS() - t); return s < 3600 ? Math.round(s / 60) + 'm' : s < 172800 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };

async function tx(sig) {
  return cached('tx:' + sig, 36e5, () => rpcRaw('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]));
}
const keysOf = t => (t.transaction.message.accountKeys || []).map(k => String(k.pubkey || k));
const feePayer = t => keysOf(t)[0];
// page backwards through an address's history until the first transaction, within a budget
async function oldest(addr, pages) {
  let before, all = 0, last = null, done = false;
  for (let i = 0; i < pages; i++) {
    const page = await rpc(c => c.getSignaturesForAddress(new PublicKey(addr), { limit: 1000, before }));
    all += page.length;
    if (page.length) { last = page; before = page[page.length - 1].signature; }
    if (page.length < 1000) { done = true; break; }
  }
  return { done, seen: all, page: last || [] };
}
// who sent this wallet its first SOL
async function funder(addr) {
  return cached('fund:' + addr, 36e5, async () => {
    const o = await oldest(addr, 3);
    if (!o.done || !o.page.length) return { known: false, reason: o.seen ? 'history longer than 3,000 transactions' : 'no history' };
    const first = o.page.slice(-6).reverse();
    for (const s of first) {
      const t = await tx(s.signature).catch(() => null); if (!t) continue;
      const ins = [...(t.transaction.message.instructions || [])];
      for (const ii of (t.meta && t.meta.innerInstructions) || []) ins.push(...ii.instructions);
      const tr = ins.find(ix => ix.program === 'system' && ix.parsed && ['transfer', 'transferWithSeed', 'createAccount'].includes(ix.parsed.type) && (ix.parsed.info.destination === addr || ix.parsed.info.newAccount === addr));
      if (tr) return { known: true, from: tr.parsed.info.source, sol: r4(sol(tr.parsed.info.lamports || 0)), at: t.blockTime || s.blockTime, sig: s.signature };
    }
    return { known: false, reason: 'first transactions hold no SOL transfer in' };
  });
}
async function mintInfo(mint) {
  return cached('mint:' + mint, 60e3, async () => {
    const r = await rpc(c => c.getParsedAccountInfo(new PublicKey(mint)));
    const v = r && r.value;
    if (!v || !v.data || !v.data.parsed || v.data.parsed.type !== 'mint') throw http(404, 'That address is not a token mint.');
    const i = v.data.parsed.info;
    return { program: String(v.owner) === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token-2022' : 'spl-token', supply: Number(i.supply) / 10 ** i.decimals, decimals: i.decimals, mintAuthority: i.mintAuthority || null, freezeAuthority: i.freezeAuthority || null, extensions: i.extensions || [] };
  });
}
async function pumpCoin(mint) {
  return cached('pc:' + mint, 120e3, async () => {
    for (const host of ['https://frontend-api-v3.pump.fun', 'https://frontend-api.pump.fun']) {
      try { const j = await getJson(`${host}/coins/${mint}`, 6000, { origin: 'https://pump.fun', referer: 'https://pump.fun/' }); if (j && j.mint) return j; } catch (e) { }
    }
    return null;
  });
}
async function dexMeta(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const j = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + mints.slice(i, i + 30).join(','), 6000);
      for (const p of (Array.isArray(j) ? j : [])) { const m = p.baseToken && p.baseToken.address; if (m && (!out[m] || (+p.liquidity?.usd || 0) > (+out[m].liquidity?.usd || 0))) out[m] = p; }
    } catch (e) { }
  }
  return out;
}
const label = (m, d) => d && d.baseToken ? '$' + d.baseToken.symbol : short(m);
async function balanceOf(owner, mint) {
  const r = await rpc(c => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }));
  return r.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}
const curvePda = mint => PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0].toBase58();

/* ---------------- the agents ---------------- */
// Every agent returns { verdict: clear|caution|red|info, headline, facts:[{k,v,flag?}], rows?, cols?, links:[{t,u}], steps:[] }
const step = (S, t0, text) => S.push({ ms: Date.now() - t0, text });

async function agentDev({ q }) {
  const mint = pk(q, 'coin address').toBase58(), S = [], t0 = Date.now();
  const [mi, pc] = await Promise.all([mintInfo(mint), pumpCoin(mint)]);
  step(S, t0, `read the mint: ${mi.program}, supply ${Math.round(mi.supply).toLocaleString('en-US')}`);
  let creator = pc && pc.creator;
  if (creator) step(S, t0, `pump.fun record: created by ${short(creator)}`);
  else {
    const o = await oldest(mint, 6);
    if (!o.done) throw http(422, 'This coin has more than 6,000 transactions and pump.fun did not answer, so DEV could not reach its first one.');
    const first = o.page[o.page.length - 1]; const t = await tx(first.signature);
    creator = feePayer(t); step(S, t0, `walked ${o.seen.toLocaleString('en-US')} transactions back to the first: created by ${short(creator)}`);
  }
  const [hold, solBal, fund, past] = await Promise.all([
    balanceOf(creator, mint).catch(() => null),
    rpc(c => c.getBalance(new PublicKey(creator))).then(sol).catch(() => null),
    funder(creator).catch(() => ({ known: false, reason: 'rpc busy' })),
    (async () => {
      for (const host of ['https://frontend-api-v3.pump.fun', 'https://frontend-api.pump.fun']) {
        try {
          const j = await getJson(`${host}/coins/user-created-coins/${creator}?offset=0&limit=200&includeNsfw=true`, 7000, { origin: 'https://pump.fun', referer: 'https://pump.fun/' });
          const list = Array.isArray(j) ? j : (j && (j.coins || j.data)) || null;
          if (Array.isArray(list)) return list;
        } catch (e) { }
      }
      return null;
    })(),
  ]);
  step(S, t0, `dev wallet: ${solBal == null ? '—' : r4(solBal) + ' SOL'}, holds ${hold == null ? '—' : pct(hold, mi.supply) + '%'} of the supply`);
  step(S, t0, fund.known ? `first SOL in: ${fund.sol} from ${short(fund.from)}` : `first funding: ${fund.reason}`);
  const facts = [], flags = [];
  facts.push({ k: 'coin', v: pc ? `${pc.name} ($${pc.symbol})` : short(mint) });
  facts.push({ k: 'dev wallet', v: creator, addr: true });
  if (pc && pc.created_timestamp) facts.push({ k: 'launched', v: ago(Math.floor(pc.created_timestamp / 1000)) + ' ago' });
  facts.push({ k: 'dev holds now', v: hold == null ? '—' : `${pct(hold, mi.supply)}% of supply`, flag: hold != null && pct(hold, mi.supply) > 10 ? 'caution' : null });
  facts.push({ k: 'dev SOL', v: solBal == null ? '—' : r4(solBal) + ' SOL' });
  facts.push({ k: 'funded by', v: fund.known ? `${fund.from} · ${fund.sol} SOL · ${ago(fund.at)} ago` : '— (' + fund.reason + ')', addr: fund.known ? fund.from : null });
  if (hold != null && pct(hold, mi.supply) > 10) flags.push('the dev still holds more than 10% of the supply');
  let rows = null;
  if (past) {
    const others = past.filter(c => c.mint !== mint);
    const grads = others.filter(c => c.complete).length;
    step(S, t0, `pump.fun lists ${past.length} coin${past.length === 1 ? '' : 's'} by this wallet, ${grads} graduated`);
    facts.push({ k: 'other launches', v: `${others.length} (${grads} graduated)`, flag: others.length >= 10 && grads === 0 ? 'red' : others.length >= 5 && grads === 0 ? 'caution' : null });
    if (others.length >= 10 && grads === 0) flags.push(`${others.length} other launches and none graduated: a serial launcher`);
    else if (others.length >= 5 && grads === 0) flags.push(`${others.length} other launches, none graduated`);
    rows = others.sort((a, b) => (b.usd_market_cap || 0) - (a.usd_market_cap || 0)).slice(0, 8).map(c => [c.name + ' ($' + c.symbol + ')', c.complete ? 'graduated' : 'curve', c.usd_market_cap ? '$' + Math.round(c.usd_market_cap).toLocaleString('en-US') : '—', ago(Math.floor((c.created_timestamp || 0) / 1000)), { mint: c.mint }]);
  } else { facts.push({ k: 'other launches', v: '— (pump.fun did not answer)' }); step(S, t0, 'pump.fun did not return the launch list'); }
  if (mi.mintAuthority) flags.push('the mint authority is still active: more supply can be printed');
  if (mi.freezeAuthority) flags.push('a freeze authority is set: wallets can be frozen');
  facts.push({ k: 'mint authority', v: mi.mintAuthority ? short(mi.mintAuthority) + ' (active)' : 'revoked', flag: mi.mintAuthority ? 'red' : null });
  facts.push({ k: 'freeze authority', v: mi.freezeAuthority ? short(mi.freezeAuthority) + ' (active)' : 'none', flag: mi.freezeAuthority ? 'red' : null });
  const red = facts.some(f => f.flag === 'red'), caution = facts.some(f => f.flag === 'caution');
  return {
    verdict: red ? 'red' : caution ? 'caution' : 'clear',
    headline: flags.length ? flags[0][0].toUpperCase() + flags[0].slice(1) + '.' : 'Nothing on this dev raised a flag.',
    flags, facts, cols: rows ? ['their other coins', 'state', 'mcap', 'age'] : null, rows, steps: S,
    links: [{ t: 'dev on Solscan', u: 'https://solscan.io/account/' + creator }, { t: 'coin on pump.fun', u: 'https://pump.fun/coin/' + mint }],
    subject: pc ? '$' + pc.symbol : short(mint),
  };
}

async function agentBundle({ q }) {
  const mint = pk(q, 'coin address').toBase58(), S = [], t0 = Date.now();
  const [mi, pc] = await Promise.all([mintInfo(mint), pumpCoin(mint)]);
  const o = await oldest(mint, 8);
  if (!o.done) throw http(422, `This coin has more than 8,000 transactions; BUNDLE could not reach the launch block. Try HOLDERS instead.`);
  const asc = o.page.slice().reverse().filter(s => !s.err);
  step(S, t0, `walked ${o.seen.toLocaleString('en-US')} transactions back to the launch`);
  const launchSlot = asc[0].slot;
  const early = asc.filter(s => s.slot <= launchSlot + 2).slice(0, 30);
  const txs = await mapLimit(early, 6, s => tx(s.signature));
  const creator = (pc && pc.creator) || (txs[0] && feePayer(txs[0]));
  const buyers = new Map();
  txs.forEach((t, i) => {
    if (!t || (t.meta && t.meta.err)) return;
    const who = feePayer(t);
    const pre = (t.meta.preTokenBalances || []).filter(b => b.mint === mint && b.owner === who).reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount || 0), 0);
    const post = (t.meta.postTokenBalances || []).filter(b => b.mint === mint && b.owner === who).reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount || 0), 0);
    if (post - pre <= 0) return;
    const b = buyers.get(who) || { who, bought: 0, slot: early[i].slot, sig: early[i].signature };
    b.bought += post - pre; buyers.set(who, b);
  });
  const list = [...buyers.values()];
  step(S, t0, `read ${txs.filter(Boolean).length} transactions in slots ${launchSlot}–${launchSlot + 2}: ${list.length} buyer${list.length === 1 ? '' : 's'}`);
  const now = await mapLimit(list.slice(0, 16), 5, b => balanceOf(b.who, mint));
  list.slice(0, 16).forEach((b, i) => { b.now = now[i]; });
  const inBlock = list.filter(b => b.slot === launchSlot && b.who !== creator);
  const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  const boughtPct = pct(sum(inBlock, 'bought'), mi.supply), holdPct = pct(sum(inBlock.filter(b => b.now != null), 'now'), mi.supply);
  step(S, t0, `${inBlock.length} wallet${inBlock.length === 1 ? '' : 's'} besides the dev bought in the launch block`);
  const verdict = inBlock.length >= 3 ? 'red' : inBlock.length >= 1 ? 'caution' : 'clear';
  return {
    verdict,
    headline: inBlock.length ? `${inBlock.length} wallet${inBlock.length === 1 ? '' : 's'} bought in the same block the coin was created, taking ${boughtPct}% of supply; they hold ${holdPct}% now.` : 'No wallet besides the dev bought in the launch block.',
    facts: [
      { k: 'coin', v: pc ? `${pc.name} ($${pc.symbol})` : short(mint) },
      { k: 'launch slot', v: String(launchSlot) },
      { k: 'dev', v: creator || '—', addr: !!creator },
      { k: 'launch-block buyers', v: String(inBlock.length), flag: inBlock.length >= 3 ? 'red' : inBlock.length ? 'caution' : null },
      { k: 'they bought', v: boughtPct + '% of supply' },
      { k: 'they hold now', v: holdPct + '% of supply', flag: holdPct > 15 ? 'red' : holdPct > 5 ? 'caution' : null },
    ],
    cols: ['buyer', 'slot', 'bought', 'holds now'],
    rows: list.slice(0, 16).map(b => [b.who === creator ? short(b.who) + ' (dev)' : short(b.who), b.slot === launchSlot ? 'launch' : '+' + (b.slot - launchSlot), pct(b.bought, mi.supply) + '%', b.now == null ? '—' : pct(b.now, mi.supply) + '%', { addr: b.who, sig: b.sig }]),
    steps: S, links: [{ t: 'launch tx on Solscan', u: 'https://solscan.io/tx/' + asc[0].signature }, { t: 'coin on pump.fun', u: 'https://pump.fun/coin/' + mint }],
    subject: pc ? '$' + pc.symbol : short(mint),
  };
}

async function jup(inputMint, outputMint, amount) {
  const u = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=500&restrictIntermediateTokens=true`;
  return await getJson(u, 8000);
}
async function agentHoney({ q }) {
  const mint = pk(q, 'coin address').toBase58(), S = [], t0 = Date.now();
  const [mi, pc] = await Promise.all([mintInfo(mint), pumpCoin(mint)]);
  step(S, t0, `read the mint: ${mi.program}`);
  const facts = [{ k: 'coin', v: pc ? `${pc.name} ($${pc.symbol})` : short(mint) }, { k: 'token program', v: mi.program }];
  const flags = [];
  facts.push({ k: 'mint authority', v: mi.mintAuthority ? 'active' : 'revoked', flag: mi.mintAuthority ? 'red' : null });
  facts.push({ k: 'freeze authority', v: mi.freezeAuthority ? 'active: your tokens can be frozen' : 'none', flag: mi.freezeAuthority ? 'red' : null });
  if (mi.freezeAuthority) flags.push('a freeze authority can freeze your tokens');
  if (mi.mintAuthority) flags.push('the mint authority can print more supply');
  for (const x of mi.extensions || []) {
    const s = x.state || {};
    if (x.extension === 'transferFeeConfig') { const bps = (s.newerTransferFee && s.newerTransferFee.transferFeeBasisPoints) || 0; facts.push({ k: 'transfer fee', v: bps / 100 + '%', flag: bps > 500 ? 'red' : bps > 0 ? 'caution' : null }); if (bps > 500) flags.push(`a ${bps / 100}% fee is taken on every transfer`); }
    if (x.extension === 'transferHook' && s.programId) { facts.push({ k: 'transfer hook', v: short(s.programId) + ': a program runs on every transfer', flag: 'caution' }); flags.push('a transfer hook program runs on every transfer'); }
    if (x.extension === 'permanentDelegate' && s.delegate) { facts.push({ k: 'permanent delegate', v: short(s.delegate) + ': can move anyone\'s tokens', flag: 'red' }); flags.push('a permanent delegate can take tokens from any wallet'); }
    if (x.extension === 'nonTransferable') { facts.push({ k: 'non-transferable', v: 'yes', flag: 'red' }); flags.push('the token cannot be transferred'); }
    if (x.extension === 'defaultAccountState' && s.accountState === 'frozen') { facts.push({ k: 'new accounts', v: 'start frozen', flag: 'red' }); flags.push('new holders start frozen'); }
    if (x.extension === 'pausableConfig') { facts.push({ k: 'pausable', v: 'transfers can be paused', flag: 'caution' }); }
  }
  // a real round trip: buy 0.05 SOL of it, then quote selling exactly what that buys
  let trip = null;
  try {
    const buy = await jup(WSOL, mint, 50000000);
    const got = buy.outAmount;
    const sell = await jup(mint, WSOL, got);
    const back = Number(sell.outAmount) / 1e9;
    trip = { got: Number(got) / 10 ** mi.decimals, back, loss: Math.round((1 - back / 0.05) * 1000) / 10, route: (buy.routePlan || []).map(r => r.swapInfo && r.swapInfo.label).filter(Boolean).join(' → ') || 'Jupiter', impact: Number(sell.priceImpactPct || 0) * 100 };
    step(S, t0, `Jupiter: 0.05 SOL buys ${Math.round(trip.got).toLocaleString('en-US')}; selling them back returns ${r4(back)} SOL via ${trip.route}`);
  } catch (e) { step(S, t0, 'Jupiter found no route for a buy and sell'); }
  if (trip) {
    facts.push({ k: 'sell route', v: 'found (' + trip.route + ')' });
    facts.push({ k: 'round trip 0.05 SOL', v: `get back ${r4(trip.back)} SOL (${trip.loss}% lost to fees, curve and slippage)`, flag: trip.loss > 25 ? 'red' : trip.loss > 10 ? 'caution' : null });
    if (trip.loss > 25) flags.push(`a buy and sell round trip loses ${trip.loss}%: a hidden tax or a very thin pool`);
  } else { facts.push({ k: 'sell route', v: 'none found on Jupiter right now', flag: 'caution' }); flags.push('Jupiter found no route to sell it right now'); }
  const red = facts.some(f => f.flag === 'red'), caution = facts.some(f => f.flag === 'caution');
  return {
    verdict: red ? 'red' : caution ? 'caution' : 'clear',
    headline: red ? flags[0][0].toUpperCase() + flags[0].slice(1) + '.' : trip ? `You can sell it: 0.05 SOL in, ${r4(trip.back)} SOL back out.` : 'No sell route right now; nothing in the token itself blocks selling.',
    flags, facts, steps: S, subject: pc ? '$' + pc.symbol : short(mint),
    links: [{ t: 'mint on Solscan', u: 'https://solscan.io/token/' + mint }, { t: 'quote on Jupiter', u: 'https://jup.ag/swap/SOL-' + mint }],
  };
}

async function agentHolders({ q }) {
  const mint = pk(q, 'coin address').toBase58(), S = [], t0 = Date.now();
  const [mi, pc] = await Promise.all([mintInfo(mint), pumpCoin(mint)]);
  const big = await rpc(c => c.getTokenLargestAccounts(new PublicKey(mint)));
  const accs = big.value.slice(0, 20);
  const infos = await rpc(c => c.getMultipleParsedAccounts(accs.map(a => a.address)));
  const curve = curvePda(mint), pool = canonicalPumpPoolPda(new PublicKey(mint)).toBase58();
  const creator = pc && pc.creator;
  step(S, t0, `read the ${accs.length} largest token accounts and their owners`);
  const rows = accs.map((a, i) => {
    const o = infos.value[i] && infos.value[i].data && infos.value[i].data.parsed ? infos.value[i].data.parsed.info.owner : null;
    const amt = Number(a.uiAmount || 0);
    const tag = o === curve ? 'bonding curve' : o === pool ? 'PumpSwap pool' : o === creator ? 'dev' : '';
    return { owner: o, amt, p: pct(amt, mi.supply), tag };
  });
  const people = rows.filter(r => r.tag !== 'bonding curve' && r.tag !== 'PumpSwap pool');
  const top10 = Math.round(people.slice(0, 10).reduce((a, r) => a + r.p, 0) * 100) / 100;
  const topOne = people[0] ? people[0].p : 0;
  step(S, t0, `top 10 wallets outside the curve and pool hold ${top10}%`);
  const verdict = top10 > 50 || topOne > 20 ? 'red' : top10 > 30 || topOne > 8 ? 'caution' : 'clear';
  return {
    verdict, headline: `The top 10 wallets (curve and pool excluded) hold ${top10}% of the supply; the largest holds ${topOne}%.`,
    facts: [
      { k: 'coin', v: pc ? `${pc.name} ($${pc.symbol})` : short(mint) },
      { k: 'supply', v: Math.round(mi.supply).toLocaleString('en-US') },
      { k: 'top 10 wallets', v: top10 + '%', flag: top10 > 50 ? 'red' : top10 > 30 ? 'caution' : null },
      { k: 'largest wallet', v: topOne + '%', flag: topOne > 20 ? 'red' : topOne > 8 ? 'caution' : null },
      { k: 'in curve / pool', v: Math.round(rows.filter(r => r.tag === 'bonding curve' || r.tag === 'PumpSwap pool').reduce((a, r) => a + r.p, 0) * 100) / 100 + '%' },
    ],
    cols: ['#', 'owner', 'share', 'label'],
    rows: rows.map((r, i) => [String(i + 1), r.owner ? short(r.owner) : '—', r.p + '%', r.tag || '', { addr: r.owner }]),
    steps: S, subject: pc ? '$' + pc.symbol : short(mint),
    links: [{ t: 'holders on Solscan', u: 'https://solscan.io/token/' + mint + '#holders' }],
  };
}

async function migrated(sig) {
  return cached('mig:' + sig, 864e5, async () => {
    const t = await tx(sig);
    if (!t || (t.meta && t.meta.err)) return false;
    if (!((t.meta && t.meta.logMessages) || []).some(l => /Instruction: Migrate/.test(l))) return false;
    const ix = (t.transaction.message.instructions || []).find(i => String(i.programId) === PUMP);
    if (!ix || !ix.accounts || ix.accounts.length < 3) return false;
    const m = String(ix.accounts[2].pubkey || ix.accounts[2]);
    return B58.test(m) ? { mint: m, at: t.blockTime || 0 } : false;
  });
}
async function agentGrad() {
  const S = [], t0 = Date.now();
  const out = await cached('grad', 45e3, async () => {
    const page = await rpc(c => c.getSignaturesForAddress(new PublicKey(MIGRATOR), { limit: 60 }));
    const ok = page.filter(s => !s.err && s.blockTime).slice(0, 36);
    const got = await mapLimit(ok, 6, s => migrated(s.signature));
    const seen = new Set(), coins = [];
    got.forEach((g, i) => { if (g && !seen.has(g.mint)) { seen.add(g.mint); coins.push({ ...g, sig: ok[i].signature }); } });
    const meta = await dexMeta(coins.slice(0, 20).map(c => c.mint));
    return { checked: ok.length, coins: coins.slice(0, 20).map(c => ({ ...c, d: meta[c.mint] || null })) };
  });
  step(S, t0, `read pump.fun's migration wallet: ${out.checked} transactions, ${out.coins.length} graduations`);
  const latest = out.coins[0];
  return {
    verdict: 'info',
    headline: latest ? `${out.coins.length} coins graduated to PumpSwap recently; the newest, ${label(latest.mint, latest.d)}, ${ago(latest.at)} ago.` : 'No graduations in the latest migration transactions.',
    facts: [{ k: 'graduations found', v: String(out.coins.length) }, { k: 'newest', v: latest ? ago(latest.at) + ' ago' : '—' }],
    cols: ['coin', 'graduated', 'mcap', '24h vol'],
    rows: out.coins.map(c => [label(c.mint, c.d) + (c.d && c.d.baseToken ? ' · ' + c.d.baseToken.name.slice(0, 22) : ''), ago(c.at) + ' ago', c.d && (c.d.marketCap || c.d.fdv) ? '$' + Math.round(c.d.marketCap || c.d.fdv).toLocaleString('en-US') : '—', c.d && c.d.volume ? '$' + Math.round(c.d.volume.h24 || 0).toLocaleString('en-US') : '—', { mint: c.mint, sig: c.sig }]),
    steps: S, subject: 'graduations', links: [{ t: 'migration wallet on Solscan', u: 'https://solscan.io/account/' + MIGRATOR }],
  };
}

async function agentLink({ q, q2 }) {
  const a = pk(q, 'first wallet').toBase58(), b = pk(q2, 'second wallet').toBase58(), S = [], t0 = Date.now();
  if (a === b) throw http(400, 'Those are the same wallet.');
  const [sa, sb, fa, fb] = await Promise.all([
    rpc(c => c.getSignaturesForAddress(new PublicKey(a), { limit: 1000 })),
    rpc(c => c.getSignaturesForAddress(new PublicKey(b), { limit: 1000 })),
    funder(a).catch(() => ({ known: false, reason: 'rpc busy' })), funder(b).catch(() => ({ known: false, reason: 'rpc busy' })),
  ]);
  step(S, t0, `read ${sa.length} + ${sb.length} recent transactions`);
  const setB = new Set(sb.map(s => s.signature));
  const shared = sa.filter(s => setB.has(s.signature) && !s.err);
  step(S, t0, `${shared.length} transaction${shared.length === 1 ? '' : 's'} touch both wallets`);
  const reasons = [];
  if (shared.length) reasons.push(`${shared.length} transaction${shared.length === 1 ? '' : 's'} touch both wallets`);
  if (fa.known && fb.known && fa.from === fb.from) reasons.push(`both were first funded by ${short(fa.from)}`);
  if (fa.known && fa.from === b) reasons.push('the second wallet funded the first');
  if (fb.known && fb.from === a) reasons.push('the first wallet funded the second');
  step(S, t0, `first funding: ${fa.known ? short(fa.from) : '—'} and ${fb.known ? short(fb.from) : '—'}`);
  return {
    verdict: reasons.length ? 'red' : 'clear',
    headline: reasons.length ? 'Linked: ' + reasons.join('; ') + '.' : `No link found in the last ${Math.min(sa.length, 1000)} and ${Math.min(sb.length, 1000)} transactions or their first funding.`,
    facts: [
      { k: 'wallet A', v: a, addr: true }, { k: 'wallet B', v: b, addr: true },
      { k: 'shared transactions', v: String(shared.length), flag: shared.length ? 'red' : null },
      { k: 'A first funded by', v: fa.known ? `${short(fa.from)} · ${fa.sol} SOL` : '— (' + fa.reason + ')', flag: fa.known && (fa.from === b || (fb.known && fa.from === fb.from)) ? 'red' : null },
      { k: 'B first funded by', v: fb.known ? `${short(fb.from)} · ${fb.sol} SOL` : '— (' + fb.reason + ')', flag: fb.known && (fb.from === a || (fa.known && fa.from === fb.from)) ? 'red' : null },
    ],
    cols: shared.length ? ['shared transaction', 'when'] : null,
    rows: shared.length ? shared.slice(0, 10).map(s => [short(s.signature), ago(s.blockTime) + ' ago', { sig: s.signature }]) : null,
    steps: S, subject: short(a) + ' × ' + short(b), links: [{ t: 'A on Solscan', u: 'https://solscan.io/account/' + a }, { t: 'B on Solscan', u: 'https://solscan.io/account/' + b }],
  };
}

const TAGS = [[PUMP, 'pump.fun'], [PUMPSWAP, 'PumpSwap'], ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter'], ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium'], ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM'], ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora']];
async function agentWatch({ q }) {
  const w = pk(q, 'wallet').toBase58(), S = [], t0 = Date.now();
  const sigs = (await rpc(c => c.getSignaturesForAddress(new PublicKey(w), { limit: 15 }))).filter(s => !s.err);
  const txs = await mapLimit(sigs, 6, s => tx(s.signature));
  step(S, t0, `read the last ${txs.filter(Boolean).length} transactions`);
  const mints = new Set(), moves = [];
  txs.forEach((t, i) => {
    if (!t) return;
    const keys = keysOf(t), idx = keys.indexOf(w);
    const dSol = idx >= 0 ? (t.meta.postBalances[idx] - t.meta.preBalances[idx]) / 1e9 : 0;
    const d = {};
    for (const b of t.meta.preTokenBalances || []) if (b.owner === w) d[b.mint] = (d[b.mint] || 0) - Number(b.uiTokenAmount.uiAmount || 0);
    for (const b of t.meta.postTokenBalances || []) if (b.owner === w) d[b.mint] = (d[b.mint] || 0) + Number(b.uiTokenAmount.uiAmount || 0);
    const tok = Object.entries(d).filter(([m, v]) => Math.abs(v) > 0 && m !== WSOL);
    tok.forEach(([m]) => mints.add(m));
    const via = (TAGS.find(([p]) => keys.includes(p)) || [0, ''])[1];
    let act = 'other';
    if (tok.length === 1) act = tok[0][1] > 0 ? (dSol < -0.0001 ? 'buy' : 'receive') : (dSol > 0.0001 ? 'sell' : 'send');
    else if (!tok.length && Math.abs(dSol) > 0.0001) act = dSol > 0 ? 'SOL in' : 'SOL out';
    moves.push({ at: t.blockTime, act, dSol, tok, via, sig: sigs[i].signature });
  });
  const meta = await dexMeta([...mints].slice(0, 30));
  const trades = moves.filter(m => m.act === 'buy' || m.act === 'sell').length;
  step(S, t0, `${trades} trade${trades === 1 ? '' : 's'} among them`);
  const bal = await rpc(c => c.getBalance(new PublicKey(w))).then(sol).catch(() => null);
  return {
    verdict: 'info',
    headline: moves.length ? `Last move ${ago(moves[0].at)} ago: ${moves[0].act}${moves[0].tok.length === 1 ? ' ' + label(moves[0].tok[0][0], meta[moves[0].tok[0][0]]) : ''}. ${trades} of the last ${moves.length} were trades.` : 'No recent transactions.',
    facts: [{ k: 'wallet', v: w, addr: true }, { k: 'SOL balance', v: bal == null ? '—' : r4(bal) + ' SOL' }, { k: 'trades in last ' + moves.length, v: String(trades) }],
    cols: ['when', 'move', 'coin', 'SOL', 'via'],
    rows: moves.map(m => [ago(m.at) + ' ago', m.act, m.tok.length === 1 ? label(m.tok[0][0], meta[m.tok[0][0]]) : m.tok.length ? m.tok.length + ' coins' : '—', (m.dSol > 0 ? '+' : '') + r4(m.dSol), m.via || '—', { sig: m.sig }]),
    steps: S, subject: short(w), links: [{ t: 'wallet on Solscan', u: 'https://solscan.io/account/' + w }],
  };
}

/* POOL: the PumpSwap pools paying liquidity providers the most per SOL, from live reserves and real volume */
async function poolsBoard() {
  return cached('pools', 120e3, async () => {
    const [g, f] = await rpc(c => c.getMultipleAccountsInfo([GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA]));
    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(g), feeConfig = f ? PUMP_AMM_SDK.decodeFeeConfig(f) : null;
    const gt = 'https://api.geckoterminal.com/api/v2/networks/solana/';
    const mints = new Set();
    await Promise.all([gt + 'dexes/pumpswap/pools?page=1', gt + 'dexes/pumpswap/pools?page=2', gt + 'trending_pools?include=base_token,dex&page=1', 'https://api.dexscreener.com/token-boosts/top/v1'].map(async u => {
      try {
        const j = await getJson(u, 6500);
        if (Array.isArray(j)) { for (const t of j) if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress); return; }
        for (const p of (j.data || [])) {
          const dex = p.relationships && p.relationships.dex && p.relationships.dex.data ? p.relationships.dex.data.id : 'pumpswap';
          const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data ? p.relationships.base_token.data.id : '';
          if (dex === 'pumpswap' && id.startsWith('solana_')) mints.add(id.slice(7));
        }
      } catch (e) { }
    }));
    const keys = []; for (const m of [...mints].filter(m => B58.test(m)).slice(0, 160)) { try { keys.push(canonicalPumpPoolPda(new PublicKey(m))); } catch (e) { } }
    const infos = []; for (let i = 0; i < keys.length; i += 100) infos.push(...await rpc(c => c.getMultipleAccountsInfo(keys.slice(i, i + 100))));
    const live = []; infos.forEach((info, i) => { if (info && info.owner.equals(PUMP_AMM_PROGRAM_ID)) { try { live.push({ key: keys[i], pool: PUMP_AMM_SDK.decodePool(info) }); } catch (e) { } } });
    const flat = live.flatMap(x => [x.pool.baseMint, x.pool.poolBaseTokenAccount, x.pool.poolQuoteTokenAccount]);
    const acc = []; for (let i = 0; i < flat.length; i += 99) acc.push(...await rpc(c => c.getMultipleAccountsInfo(flat.slice(i, i + 99))));
    const meta = await dexMeta(live.map(x => x.pool.baseMint.toBase58()));
    const prices = Object.values(meta).filter(p => p.quoteToken && p.quoteToken.symbol === 'SOL' && +p.priceNative > 0 && +p.priceUsd > 0).map(p => +p.priceUsd / +p.priceNative).sort((a, b) => a - b);
    const solUsd = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
    const out = [];
    live.forEach((x, i) => {
      const [mi, bi, qi] = acc.slice(i * 3, i * 3 + 3); if (!mi || !bi || !qi) return;
      try {
        const m = MintLayout.decode(mi.data.slice(0, MintLayout.span));
        const Rb = BigInt(AccountLayout.decode(bi.data.slice(0, AccountLayout.span)).amount.toString()), Rq = BigInt(AccountLayout.decode(qi.data.slice(0, AccountLayout.span)).amount.toString());
        if (!Rb || !Rq) return;
        const fz = computeFeesBps({ globalConfig, feeConfig, creator: x.pool.creator, baseMintSupply: new BN(m.supply.toString()), baseMint: x.pool.baseMint, baseReserve: new BN(Rb.toString()), quoteReserve: new BN((Rq + BigInt(x.pool.virtualQuoteReserves ? x.pool.virtualQuoteReserves.toString() : '0')).toString()), quoteMint: x.pool.quoteMint, isMayhemMode: x.pool.isMayhemMode, creatorFeeBps: x.pool.creatorFeeBps });
        const lp = Number(fz.lpFeeBps.toString());
        const d = meta[x.pool.baseMint.toBase58()]; if (!d) return;
        const tvl = 2 * sol(Rq), volSol = solUsd ? (+d.volume?.h24 || 0) / solUsd : 0;
        if (tvl < 8) return;
        const perSol = volSol * lp / 10000 / tvl;
        out.push({ mint: x.pool.baseMint.toBase58(), pool: x.key.toBase58(), sym: d.baseToken.symbol, name: d.baseToken.name, tvl, volUsd: +d.volume?.h24 || 0, lp, perSol, apr: perSol * 365 });
      } catch (e) { }
    });
    out.sort((a, b) => b.perSol - a.perSol);
    return { checked: mints.size, pools: out.slice(0, 15) };
  });
}
async function agentPool() {
  const S = [], t0 = Date.now(); const b = await poolsBoard();
  step(S, t0, `read ${b.checked} candidate coins, ${b.pools.length} PumpSwap pools with 8+ SOL of liquidity`);
  const top = b.pools[0];
  return {
    verdict: 'info',
    headline: top ? `$${top.sym} paid liquidity providers the most per SOL in the last 24h: ${r4(top.perSol)} SOL per SOL deposited.` : 'No PumpSwap pools with 8+ SOL of liquidity answered right now.',
    facts: [{ k: 'pools ranked', v: String(b.pools.length) }, { k: 'measured on', v: 'last 24h volume × the pool\'s LP fee ÷ its liquidity' }, { k: 'note', v: 'past fees, not a promise; prices move' }],
    cols: ['pool', 'liquidity', '24h volume', 'LP fee', 'per SOL / day'],
    rows: b.pools.map(p => ['$' + p.sym, Math.round(p.tvl) + ' SOL', '$' + Math.round(p.volUsd).toLocaleString('en-US'), p.lp / 100 + '%', r4(p.perSol) + ' SOL', { mint: p.mint, pool: p.pool }]),
    steps: S, subject: 'PumpSwap pools', links: [{ t: 'PumpSwap', u: 'https://swap.pump.fun' }],
  };
}

async function emptyAccounts(w) {
  const [a, b] = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(p => rpc(c => c.getParsedTokenAccountsByOwner(new PublicKey(w), { programId: p }))));
  const all = [...a.value.map(x => ({ ...x, prog: TOKEN_PROGRAM_ID })), ...b.value.map(x => ({ ...x, prog: TOKEN_2022_PROGRAM_ID }))];
  const empty = all.filter(x => x.account.data.parsed.info.tokenAmount.amount === '0' && !x.account.data.parsed.info.isNative
    && !((x.account.data.parsed.info.extensions || []).some(e => e.extension === 'transferFeeAmount' && Number(e.state && e.state.withheldAmount) > 0)));
  return { all, empty };
}
async function agentRent({ q }) {
  const w = pk(q, 'wallet').toBase58(), S = [], t0 = Date.now();
  const { all, empty } = await emptyAccounts(w);
  const lam = empty.reduce((s, x) => s + x.account.lamports, 0);
  step(S, t0, `read ${all.length} token accounts: ${empty.length} are empty`);
  const meta = await dexMeta([...new Set(empty.map(x => x.account.data.parsed.info.mint))].slice(0, 30));
  return {
    verdict: empty.length ? 'caution' : 'clear',
    headline: empty.length ? `${empty.length} empty token account${empty.length === 1 ? '' : 's'} hold ${r4(sol(lam))} SOL of your rent. Closing them sends it back to you.` : 'No empty token accounts. Nothing to reclaim.',
    facts: [{ k: 'wallet', v: w, addr: true }, { k: 'token accounts', v: String(all.length) }, { k: 'empty', v: String(empty.length), flag: empty.length ? 'caution' : null }, { k: 'reclaimable', v: r4(sol(lam)) + ' SOL' }],
    cols: empty.length ? ['empty account of', 'program', 'rent'] : null,
    rows: empty.length ? empty.slice(0, 40).map(x => [label(x.account.data.parsed.info.mint, meta[x.account.data.parsed.info.mint]), x.prog.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL', r4(sol(x.account.lamports)) + ' SOL', { mint: x.account.data.parsed.info.mint }]) : null,
    steps: S, subject: short(w), action: empty.length ? { kind: 'close', count: empty.length, sol: r4(sol(lam)) } : null,
    links: [{ t: 'wallet on Solscan', u: 'https://solscan.io/account/' + w }],
  };
}
// RENT's one transaction: close empty accounts back to the owner, 20 per transaction; the wallet signs
async function buildClose(b) {
  const w = pk(b.wallet, 'wallet');
  const { empty } = await emptyAccounts(w.toBase58());
  if (!empty.length) throw http(409, 'No empty token accounts to close.');
  const { blockhash } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const txs = [];
  for (let i = 0; i < empty.length && txs.length < 6; i += 20) {
    const part = empty.slice(i, i + 20);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 12000 + part.length * 3500 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 })];
    for (const x of part) ixs.push(createCloseAccountInstruction(x.pubkey, w, w, [], x.prog));
    const t = new VersionedTransaction(new TransactionMessage({ payerKey: w, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    const sim = await rpc(c => c.simulateTransaction(t, { sigVerify: false, replaceRecentBlockhash: true }));
    if (sim.value.err) continue;
    txs.push({ tx: Buffer.from(t.serialize()).toString('base64'), count: part.length, sol: r4(sol(part.reduce((s, x) => s + x.account.lamports, 0))) });
  }
  if (!txs.length) throw http(409, 'The network would not accept closing these accounts right now.');
  return { txs, count: txs.reduce((a, t) => a + t.count, 0), sol: r4(txs.reduce((a, t) => a + t.sol, 0)) };
}

const RUN = { dev: agentDev, bundle: agentBundle, honey: agentHoney, holders: agentHolders, grad: agentGrad, link: agentLink, watch: agentWatch, pool: agentPool, rent: agentRent };

/* ---------------- the public record (Postgres when connected) ---------------- */
let sqlFn = null, ready = null;
function db() {
  if (!DB_URL) return null;
  if (!sqlFn) { const { neon } = require('@neondatabase/serverless'); sqlFn = neon(DB_URL); }
  if (!ready) ready = (async () => {
    await sqlFn`CREATE TABLE IF NOT EXISTS ag_runs (id BIGSERIAL PRIMARY KEY, agent TEXT NOT NULL, input TEXT, subject TEXT, verdict TEXT, headline TEXT, ok BOOLEAN, ms INT, result JSONB, at TIMESTAMPTZ DEFAULT now())`;
    await sqlFn`CREATE INDEX IF NOT EXISTS ag_runs_at ON ag_runs (at DESC)`;
    await sqlFn`CREATE TABLE IF NOT EXISTS ag_wanted (id BIGSERIAL PRIMARY KEY, body TEXT NOT NULL, votes INT DEFAULT 1, at TIMESTAMPTZ DEFAULT now())`;
    await sqlFn`CREATE TABLE IF NOT EXISTS ag_votes (wanted BIGINT, voter TEXT, PRIMARY KEY (wanted, voter))`;
  })().catch(e => { ready = null; throw e; });
  return { sql: sqlFn, ready };
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '').split(',')[0].trim();
const hashIp = ip => crypto.createHash('sha256').update('ag3nt:' + ip).digest('hex').slice(0, 24);
const hits = new Map();
function limit(key, n, ms) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms);
  if (h.length >= n) return false; h.push(now); hits.set(key, h); if (hits.size > 5000) hits.clear(); return true;
}
const BANNED = /\b(n[i1]gg|f[a@]gg|r[e3]tard|kys|rape|hitler|nazi)/i;

async function stats() {
  const d = db(); if (!d) return { db: false };
  return cached('stats', 8000, async () => {
    await d.ready;
    const [per, recent, wanted, tot] = await Promise.all([
      d.sql`SELECT agent, count(*)::int AS runs, sum(CASE WHEN ok THEN 1 ELSE 0 END)::int AS ok FROM ag_runs GROUP BY agent`,
      d.sql`SELECT id, agent, subject, verdict, headline, ok, ms, extract(epoch from at)::bigint AS at FROM ag_runs ORDER BY id DESC LIMIT 30`,
      d.sql`SELECT id, body, votes, extract(epoch from at)::bigint AS at FROM ag_wanted ORDER BY votes DESC, id DESC LIMIT 30`,
      d.sql`SELECT count(*)::int AS n FROM ag_runs`,
    ]);
    return { db: true, per: Object.fromEntries(per.map(r => [r.agent, { runs: r.runs, ok: r.ok }])), recent, wanted, total: tot[0].n };
  });
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x'), Q = url.searchParams;
  const path = (Q.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  try {
    if (path === 'config') return send(res, 200, { ok: true, ca: CA || null, x: XH || null, db: !!DB_URL, agents: AGENTS }, 'public, s-maxage=60');
    if (path === 'run') {
      const id = String(Q.get('agent') || ''), fn = RUN[id];
      if (!fn) throw http(404, 'No agent by that name.');
      const ip = ipOf(req);
      if (!limit('run:' + ip, 12, 60e3) || !limit('run:all', 400, 60e3)) throw http(429, 'The agents are busy. Give them a minute.');
      const t0 = Date.now(); let out, ok = true;
      try { out = await fn({ q: Q.get('q'), q2: Q.get('q2') }); }
      catch (e) { ok = false; out = { verdict: 'error', headline: e.code && e.code < 500 ? e.message : 'The agent could not finish: ' + String(e.message || e).slice(0, 140), error: true, code: e.code || 500 }; }
      out.ms = Date.now() - t0; out.agent = id; out.input = [Q.get('q'), Q.get('q2')].filter(Boolean);
      let caseId = null;
      const d = db();
      if (d && !(out.error && out.code === 400)) {
        try {
          await d.ready;
          const slim = JSON.stringify(out).length < 40000 ? out : { ...out, rows: (out.rows || []).slice(0, 10) };
          const r = await d.sql`INSERT INTO ag_runs (agent, input, subject, verdict, headline, ok, ms, result) VALUES (${id}, ${out.input.join(' ').slice(0, 200)}, ${String(out.subject || '').slice(0, 60)}, ${out.verdict}, ${String(out.headline || '').slice(0, 300)}, ${ok}, ${out.ms}, ${JSON.stringify(slim)}) RETURNING id`;
          caseId = Number(r[0].id); mem.stats = undefined;
        } catch (e) { }
      }
      return send(res, out.error && out.code === 400 ? 400 : 200, { ok: !out.error, case: caseId, ...out });
    }
    if (path === 'case') {
      const d = db(); if (!d) throw http(404, 'Case files need the database, which is not connected yet.');
      await d.ready;
      const r = await d.sql`SELECT id, result, extract(epoch from at)::bigint AS at FROM ag_runs WHERE id = ${Number(Q.get('id')) || 0}`;
      if (!r.length) throw http(404, 'No case with that number.');
      return send(res, 200, { ok: true, case: Number(r[0].id), at: Number(r[0].at), ...r[0].result }, 'public, s-maxage=3600');
    }
    if (path === 'stats') return send(res, 200, { ok: true, ...(await stats()) }, 'public, s-maxage=5');
    if (path === 'status') {
      const sig = String(Q.get('sig') || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw http(400, 'bad signature');
      const r = await rpc(c => c.getSignatureStatuses([sig])); const s = r.value[0];
      return send(res, 200, { ok: true, status: s ? s.confirmationStatus : null, err: s ? s.err : null });
    }
    if (req.method !== 'POST') throw http(404, 'Not found');
    const b = await readBody(req);
    if (path === 'close') return send(res, 200, { ok: true, ...(await buildClose(b)) });
    if (path === 'send') {
      const raw = Buffer.from(String(b.tx || ''), 'base64'); if (raw.length < 64 || raw.length > 1232) throw http(400, 'bad transaction');
      const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }));
      return send(res, 200, { ok: true, sig });
    }
    if (path === 'wanted') {
      const d = db(); if (!d) throw http(503, 'The request board needs the database, which is not connected yet.');
      const body = String(b.body || '').replace(/\s+/g, ' ').trim();
      if (body.length < 8 || body.length > 140) throw http(400, 'Describe the job in 8 to 140 characters.');
      if (BANNED.test(body) || /https?:\/\//i.test(body)) throw http(400, 'That request can\'t go on the board.');
      if (!limit('want:' + ipOf(req), 3, 3600e3)) throw http(429, 'Three requests an hour per person.');
      await d.ready;
      const r = await d.sql`INSERT INTO ag_wanted (body) VALUES (${body}) RETURNING id`;
      await d.sql`INSERT INTO ag_votes (wanted, voter) VALUES (${r[0].id}, ${hashIp(ipOf(req))}) ON CONFLICT DO NOTHING`;
      mem.stats = undefined;
      return send(res, 200, { ok: true, id: Number(r[0].id) });
    }
    if (path === 'vote') {
      const d = db(); if (!d) throw http(503, 'Voting needs the database, which is not connected yet.');
      await d.ready;
      const id = Number(b.id) || 0;
      const r = await d.sql`INSERT INTO ag_votes (wanted, voter) SELECT ${id}, ${hashIp(ipOf(req))} WHERE EXISTS (SELECT 1 FROM ag_wanted WHERE id = ${id}) ON CONFLICT DO NOTHING RETURNING wanted`;
      if (r.length) await d.sql`UPDATE ag_wanted SET votes = votes + 1 WHERE id = ${id}`;
      mem.stats = undefined;
      return send(res, 200, { ok: true, counted: !!r.length });
    }
    throw http(404, 'Not found');
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
};
module.exports._t = { AGENTS, RUN };
