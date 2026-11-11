/**
 * Read-only dashboard: one self-contained HTML document (inline CSS + vanilla
 * JS, no external requests). It polls GET /api/state every 3 seconds.
 *
 * This is a String.raw template: keep backticks and dollar-brace sequences out
 * of the markup and script below (the page script uses string concatenation).
 */
export const DASHBOARD_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Distro</title>
<style>
:root{
  --bg:#0b0d12;--panel:#12151d;--panel2:#171b25;--line:#232838;--text:#e8ebf3;--muted:#8d95a8;--faint:#5d6578;
  --accent:#34d399;--accent-dim:#14532d;--warn:#fbbf24;--bad:#f87171;--info:#7aa2ff;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--info)}
.wrap{max-width:1240px;margin:0 auto;padding:18px 18px 60px}
header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:stretch;margin-bottom:18px}
.brandmark{flex:1 1 220px;display:flex;flex-direction:column;justify-content:center;min-width:200px}
.brandmark h1{margin:0;font-size:26px;letter-spacing:-.02em;font-weight:750}
.brandmark h1 span{color:var(--accent)}
.brandmark p{margin:2px 0 0;color:var(--muted)}
.conn{margin-top:8px;font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.dot.on{background:var(--accent)}.dot.off{background:var(--bad)}.dot.warn{background:var(--warn)}
.cost{flex:2 1 380px;background:linear-gradient(180deg,#131a1a,#10141b);border:1px solid #1e3a2f;border-radius:14px;padding:14px 16px}
.cost .label{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.cost .big{display:flex;align-items:baseline;gap:8px;margin:2px 0 8px;flex-wrap:wrap}
.cost .big b{font-size:34px;font-weight:750;color:var(--accent);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.cost .big span{color:var(--muted);font-size:15px}
.bar{height:10px;border-radius:6px;background:#0c1014;border:1px solid var(--line);overflow:hidden;display:flex}
.bar i{display:block;height:100%}
.bar .spent{background:var(--accent)}
.bar .reserved{background:repeating-linear-gradient(45deg,#1f7a57,#1f7a57 5px,#165a40 5px,#165a40 10px)}
.cost .stats{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:9px;color:var(--muted);font-size:12.5px}
.cost .stats b{color:var(--text);font-variant-numeric:tabular-nums;font-weight:600}
section{margin-top:22px}
section>h2{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:650}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.empty{color:var(--faint);border:1px dashed var(--line);border-radius:12px;padding:16px;text-align:center}
.grid{display:grid;gap:12px}
.g-foot{grid-template-columns:repeat(auto-fill,minmax(128px,1fr))}
.g-hooks{grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}
.g-jobs{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.g-two{grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.kv{display:grid;grid-template-columns:92px 1fr;gap:5px 10px}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.bname{font-size:19px;font-weight:700;margin:0 0 8px}
.excerpt{color:var(--muted);font-size:12.5px;margin-top:10px;max-height:92px;overflow:auto;white-space:pre-wrap;border-top:1px solid var(--line);padding-top:8px}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);margin:2px 4px 2px 0;white-space:nowrap}
.chip.warn{color:var(--warn);border-color:#4a3b12}.chip.bad{color:var(--bad);border-color:#532020}.chip.ok{color:var(--accent);border-color:var(--accent-dim)}.chip.info{color:var(--info);border-color:#263a6b}
.asset{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.asset.banned{border-color:#532020}
.thumb{aspect-ratio:9/16;background:#0d1016;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:11px;position:relative;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .flag{position:absolute;top:6px;left:6px;background:var(--bad);color:#1a0b0b;font-weight:700;font-size:10.5px;padding:2px 6px;border-radius:5px}
.asset .info{padding:7px 8px 8px}
.asset .fn{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.asset .dim{font-size:11px;color:var(--muted);margin:1px 0 3px}
.asset .chip{font-size:10.5px;padding:1px 6px;margin:1px 3px 1px 0}
.pattern{display:inline-block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px 10px;margin:0 6px 6px 0;max-width:340px;vertical-align:top}
.pattern b{font-size:12.5px}.pattern small{display:block;color:var(--muted);font-size:11.5px}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.hook .head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.rank{width:26px;height:26px;border-radius:8px;background:var(--accent);color:#052e1f;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
.hook .line{font-size:15.5px;font-weight:650;line-height:1.3;margin:0 0 7px}
.hook .body{color:#c3c9d8;margin:0 0 7px}
.hook .cta{color:var(--accent);font-size:12.5px;margin:0}
.hook .why{color:var(--muted);font-size:12px;margin:9px 0 0;border-top:1px solid var(--line);padding-top:8px}
.rest{margin-top:12px;padding:6px 14px}
.rest .row{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line)}
.rest .row:last-child{border-bottom:0}
.rest .n{color:var(--faint);width:24px;flex:none;font-variant-numeric:tabular-nums}
.rest .t{flex:1;min-width:0}
.rest .e{color:var(--muted);font-size:12px;flex:none;font-variant-numeric:tabular-nums}
.job{padding:0;overflow:hidden;display:flex;flex-direction:column}
.job-video{background:#07090d;display:flex;justify-content:center}
.job-video video{width:100%;max-width:270px;aspect-ratio:9/16;background:#000;display:block}
.job-video .ph{width:100%;padding:26px 14px;text-align:center;color:var(--faint);font-size:12.5px}
.job-meta{padding:12px 14px 14px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:650;border:1px solid var(--line);background:var(--panel2)}
.pill.ready{color:var(--accent);border-color:var(--accent-dim)}
.pill.bad{color:var(--bad);border-color:#532020}
.pill.busy{color:var(--warn);border-color:#4a3b12}
.pill.busy::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--warn);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
.job .hk{font-weight:600;margin:9px 0 8px;line-height:1.3}
.job .costs{display:flex;gap:16px;margin-bottom:8px;color:var(--muted);font-size:12.5px;flex-wrap:wrap}
.job .costs b{font-variant-numeric:tabular-nums;color:var(--text)}
.job .costs .actual b{color:var(--accent);font-size:16px}
.check{list-style:none;margin:8px 0 0;padding:0;border-top:1px solid var(--line)}
.check li{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12.5px}
.check li:last-child{border-bottom:0}
.tick{flex:none;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;margin-top:1px}
.tick.ok{background:var(--accent-dim);color:var(--accent)}.tick.no{background:#532020;color:var(--bad)}.tick.fix{background:#263a6b;color:var(--info)}
.check .id{font-weight:600;white-space:nowrap}.check .d{color:var(--muted);overflow-wrap:anywhere}
.note{color:var(--muted);font-size:12px;margin:8px 0 0}
.err{color:var(--bad);font-size:12.5px;margin:8px 0 0;overflow-wrap:anywhere}
.id-s{color:var(--faint);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
details{margin-top:8px}
summary{cursor:pointer;color:var(--muted);font-size:12.5px}
pre{background:#0a0c11;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c3c9d8;max-height:260px;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.adapters{display:flex;flex-wrap:wrap;gap:8px 18px}
.adapters span{display:inline-flex;align-items:center;gap:7px}
.draft{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}
.ledger{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.ledger td{padding:3px 8px 3px 0;border-bottom:1px solid var(--line);color:var(--muted);vertical-align:top}
.ledger td.u{color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap}
#auth{display:none;margin-bottom:14px;gap:8px;align-items:center;flex-wrap:wrap}
#auth input{flex:1 1 220px;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font:inherit}
#auth button{background:var(--accent);color:#052e1f;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer}
@media (max-width:520px){.wrap{padding:12px 12px 40px}.cost .big b{font-size:28px}.kv{grid-template-columns:78px 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brandmark">
      <h1>Distro<span>.</span></h1>
      <p>Replace your GTM team with one URL</p>
      <div class="conn"><i class="dot" id="conn-dot"></i><span id="conn-text">Connecting</span></div>
    </div>
    <div class="cost" id="cost"><div class="label">Spend</div><div class="big"><b>$0.00</b><span>loading</span></div><div class="bar"></div></div>
  </header>

  <form id="auth" class="card">
    <span>This server requires a bearer token.</span>
    <input id="auth-token" type="password" autocomplete="off" placeholder="Paste bearer token">
    <button type="submit">Unlock</button>
  </form>

  <div class="grid g-two">
    <section style="margin-top:0"><h2>Brand</h2><div id="brand"></div></section>
    <section style="margin-top:0"><h2>Integrations</h2><div id="integrations"></div></section>
  </div>
  <section><h2>Footage</h2><div id="footage"></div></section>
  <section><h2>Research patterns</h2><div id="research"></div></section>
  <section><h2>Hooks board</h2><div id="hooks"></div></section>
  <section><h2>Videos</h2><div id="jobs" class="grid g-jobs"></div></section>
  <section><h2>Schedulers</h2><div id="schedulers"></div></section>
</div>

<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'distro_bearer';
  var POLL_MS = 3000;
  var sigs = {};
  var jobNodes = {};
  var jobsEmpty = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
      var x = new URL(u, location.origin);
      return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '';
    } catch (e) { return ''; }
  }
  function pathOf(u) {
    try { return new URL(u, location.origin).pathname; } catch (e) { return ''; }
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function money(n) { return isNum(n) ? '$' + n.toFixed(2) : '—'; }
  function secs(ms) { return isNum(ms) ? (ms / 1000).toFixed(1) + 's' : ''; }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function words(s) { return String(s || '').replace(/_/g, ' '); }
  function empty(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }
  // Signed media links change on every poll; compare them by path only.
  function sig(v) {
    return JSON.stringify(v === undefined ? null : v, function (k, val) {
      if ((k === 'thumb_url' || k === 'preview_url') && typeof val === 'string') return pathOf(val);
      return val;
    });
  }
  function setSection(id, data, render) {
    var s = sig(data);
    if (sigs[id] === s) return;
    sigs[id] = s;
    $(id).innerHTML = render(data);
  }
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage blocked */ } }

  // ---------- Spend
  function renderCost(sp) {
    if (!sp) return '<div class="label">Spend</div><div class="big"><b>$0.00</b><span>no data yet</span></div><div class="bar"></div>';
    var cap = isNum(sp.cap_usd) && sp.cap_usd > 0 ? sp.cap_usd : 0;
    var spent = isNum(sp.spent_usd) ? sp.spent_usd : 0;
    var reserved = isNum(sp.reserved_usd) ? sp.reserved_usd : 0;
    var pS = cap ? Math.min(100, (spent / cap) * 100) : 0;
    var pR = cap ? Math.min(100 - pS, (reserved / cap) * 100) : 0;
    var h = '<div class="label">Spend against cap</div>';
    h += '<div class="big"><b>' + esc(money(spent)) + '</b><span>of ' + esc(money(cap)) + ' cap</span></div>';
    h += '<div class="bar"><i class="spent" style="width:' + pS.toFixed(2) + '%"></i><i class="reserved" style="width:' + pR.toFixed(2) + '%"></i></div>';
    h += '<div class="stats">';
    h += '<span>Remaining <b>' + esc(money(sp.remaining_usd)) + '</b></span>';
    h += '<span>Reserved <b>' + esc(money(reserved)) + '</b></span>';
    h += '<span>Per-render limit <b>' + esc(money(sp.max_render_usd)) + '</b></span>';
    h += '<span>Research calls today <b>' + esc(isNum(sp.darkugc_calls_today) ? sp.darkugc_calls_today : 0) + ' / ' + esc(isNum(sp.darkugc_daily_cap) ? sp.darkugc_daily_cap : 0) + '</b></span>';
    h += '</div>';
    var entries = Array.isArray(sp.entries) ? sp.entries : [];
    if (entries.length) {
      h += '<details><summary>Ledger (' + entries.length + ' recent)</summary><table class="ledger">';
      entries.slice(0, 20).forEach(function (e) {
        h += '<tr><td>' + esc(when(e.at)) + '</td><td>' + esc(e.kind) + '</td><td class="u">' + esc(money(e.usd)) + '</td><td>' + esc(e.note || e.model || '') + '</td></tr>';
      });
      h += '</table></details>';
    }
    return h;
  }

  // ---------- Brand
  function renderBrand(b) {
    if (!b || b.set === false) return empty('No brand set yet — tell your agent about your product, or paste your site URL in the chat.');
    var site = safeUrl(b.site_url);
    var h = '<div class="card"><p class="bname">' + esc(b.name || 'Unnamed brand') + '</p><dl class="kv">';
    function row(k, v) { if (v) h += '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
    row('Site', site ? '<a href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' + esc(b.site_url) + '</a>' : esc(b.site_url || ''));
    row('Niche', esc(b.niche || ''));
    row('Audience', esc(b.audience || ''));
    row('Tone', esc(b.tone || ''));
    row('Platform', esc(b.platform || ''));
    row('CTA', esc(b.cta || ''));
    row('Competitors', esc((b.competitors || []).join(', ')));
    row('Avoid', esc((b.avoid_claims || []).join('; ')));
    row('Notes', esc(b.notes || ''));
    h += '</dl>';
    if (b.site_url) h += '<div style="margin-top:8px"><span class="chip ' + (b.scrape_ok ? 'ok' : 'warn') + '">' + (b.scrape_ok ? 'Site read' : 'Site could not be read') + '</span></div>';
    if (b.site_excerpt) h += '<div class="excerpt">' + esc(b.site_excerpt) + '</div>';
    return h + '</div>';
  }

  // ---------- Integrations
  function renderIntegrations(i) {
    i = i || {};
    var items = [['llm_and_video', 'Models and video'], ['live_research', 'Live research'], ['editor', 'Video editor'], ['presigned_uploads', 'Large uploads']];
    var h = '<div class="card"><div class="adapters">';
    items.forEach(function (it) {
      h += '<span><i class="dot ' + (i[it[0]] ? 'on' : '') + '"></i>' + esc(it[1]) + '</span>';
    });
    h += '</div><p class="note">';
    h += i.live_research ? 'Research uses the live connection.' : 'Research falls back to generic seed patterns until live research is connected.';
    if (!i.presigned_uploads) h += ' Uploads go through the server with a smaller size limit.';
    return h + '</p></div>';
  }

  // ---------- Footage
  function renderFootage(list) {
    if (!list || !list.length) return empty('No footage yet — drop clips into your agent chat and it will upload them here.');
    var h = '<div class="grid g-foot">';
    list.forEach(function (a) {
      var t = safeUrl(a.thumb_url);
      var dims = (a.width && a.height) ? a.width + '×' + a.height : 'not probed';
      var dur = secs(a.duration_ms);
      h += '<div class="asset' + (a.banned ? ' banned' : '') + '"><div class="thumb">';
      h += t ? '<img loading="lazy" alt="" src="' + esc(t) + '">' : '<span>no preview</span>';
      if (a.banned) h += '<span class="flag">Flagged</span>';
      h += '</div><div class="info"><div class="fn" title="' + esc(a.filename || a.id) + '">' + esc(a.filename || a.id) + '</div>';
      h += '<div class="dim">' + esc(dims) + (dur ? ' · ' + esc(dur) : '') + '</div>';
      h += '<span class="chip">' + esc(a.kind || 'file') + '</span>';
      if (a.kind === 'footage') h += '<span class="chip">' + (a.has_audio ? 'audio' : 'silent') + '</span>';
      (a.warnings || []).forEach(function (w) { h += '<span class="chip warn">' + esc(words(w)) + '</span>'; });
      h += '</div></div>';
    });
    return h + '</div>';
  }

  // ---------- Research
  function renderResearch(r) {
    if (!r) return empty('No research yet — ask your agent what is going viral for your brand.');
    var h = '<p class="sub">Run at ' + esc(when(r.created_at)) + ' · ' + esc(isNum(r.calls_used) ? r.calls_used : 0) + ' live research calls' + (r.notes ? ' · ' + esc(r.notes) : '') + '</p>';
    var p = Array.isArray(r.patterns) ? r.patterns : [];
    if (!p.length) return h + empty('This run produced no patterns.');
    p.forEach(function (x) {
      h += '<span class="pattern" title="' + esc(x.brand_angle || '') + '"><b>' + esc(x.hook_type || 'pattern') + '</b><small>' + esc(x.format_family || '') + '</small></span>';
    });
    return h;
  }

  // ---------- Hooks
  function renderHooks(d) {
    var hooks = (d && d.hooks) || [];
    var run = d && d.run;
    if (!hooks.length) return empty('No hooks ranked yet — ask your agent to write and rank hooks.');
    var h = '';
    if (run) {
      var dis = run.discarded || {};
      h += '<p class="sub">Ranked at ' + esc(when(run.created_at)) + ' · cost ' + esc(money(run.cost_usd)) + ' · discarded ' + esc(dis.rule_filter || 0) + ' unsafe, ' + esc(dis.near_dupes || 0) + ' near-duplicates</p>';
    }
    h += '<div class="grid g-hooks">';
    hooks.slice(0, 5).forEach(function (k) {
      h += '<div class="card hook"><div class="head"><span class="rank">' + esc(k.rank) + '</span>';
      if (isNum(k.elo)) h += '<span class="chip ok">Elo ' + esc(Math.round(k.elo)) + '</span>';
      if (isNum(k.pointwise_avg)) h += '<span class="chip">Judge ' + esc(k.pointwise_avg.toFixed(2)) + ' / 5</span>';
      h += '<span class="chip info">' + (k.want_talking_head ? 'talking head' : 'text hook') + '</span></div>';
      h += '<p class="line">' + esc(k.hook) + '</p>';
      if (k.body) h += '<p class="body">' + esc(k.body) + '</p>';
      if (k.cta) h += '<p class="cta">' + esc(k.cta) + '</p>';
      if (k.reasons && k.reasons[0]) h += '<p class="why">' + esc(k.reasons[0]) + '</p>';
      h += '</div>';
    });
    h += '</div>';
    if (hooks.length > 5) {
      h += '<div class="card rest">';
      hooks.slice(5).forEach(function (k) {
        h += '<div class="row"><span class="n">' + esc(k.rank) + '</span><span class="t">' + esc(k.hook) + '</span><span class="e">' + (isNum(k.elo) ? 'Elo ' + esc(Math.round(k.elo)) : (isNum(k.pointwise_avg) ? esc(k.pointwise_avg.toFixed(2)) : '')) + '</span></div>';
      });
      h += '</div>';
    }
    return h;
  }

  // ---------- Videos (keyed, so a playing video is never re-created)
  function pillClass(s) {
    if (s === 'ready') return 'ready';
    if (s === 'failed' || s === 'discarded') return 'bad';
    return 'busy';
  }
  function jobMeta(j) {
    var h = '<span class="pill ' + pillClass(j.status) + '">' + esc(words(j.status)) + (j.step ? ' · ' + esc(j.step) : '') + '</span>';
    h += ' <span class="id-s">' + esc(j.id) + '</span>';
    if (j.hook) h += '<p class="hk">' + esc(j.hook) + '</p>';
    h += '<div class="costs"><span>Estimated <b>' + esc(money(j.estimated_usd)) + '</b></span>';
    h += '<span class="actual">Actual <b>' + (isNum(j.actual_usd) ? esc(money(j.actual_usd)) : 'pending') + '</b></span></div>';
    var s = j.sanity;
    if (s) {
      var vc = s.verdict === 'pass' ? 'ok' : (s.verdict === 'fixed' ? 'info' : 'bad');
      h += '<span class="chip ' + vc + '">Sanity: ' + esc(s.verdict) + '</span>';
      h += '<ul class="check">';
      (s.items || []).forEach(function (it) {
        h += '<li><span class="tick ' + (it.ok ? 'ok' : 'no') + '">' + (it.ok ? '✓' : '✕') + '</span><span><span class="id">' + esc(words(it.id)) + '</span> <span class="d">' + esc(it.detail || '') + '</span></span></li>';
      });
      (s.actions || []).forEach(function (a) {
        h += '<li><span class="tick fix">↻</span><span><span class="id">Auto-fix: ' + esc(words(a.id)) + '</span> <span class="d">' + esc(a.did || '') + (a.ok ? '' : ' (did not succeed)') + '</span></span></li>';
      });
      h += '</ul>';
    }
    (Array.isArray(j.notes) ? j.notes : []).forEach(function (n) { h += '<p class="note">' + esc(n) + '</p>'; });
    if (j.error) h += '<p class="err">' + esc(j.error) + '</p>';
    return h;
  }
  function jobPlaceholder(j) {
    if (j.status === 'failed') return 'This job failed before a video was produced.';
    if (j.status === 'discarded') return 'This video was discarded by the sanity check.';
    if (j.status === 'waiting_render') return 'Rendering the hook. This usually takes about five minutes.';
    return 'The preview appears here when the video is ready.';
  }
  function renderJobs(jobs) {
    var root = $('jobs');
    if (!jobs || !jobs.length) {
      if (jobsEmpty !== true) {
        root.className = '';
        root.innerHTML = empty('No videos yet — ask your agent to make a video from a ranked hook.');
        jobNodes = {};
        jobsEmpty = true;
      }
      return;
    }
    if (jobsEmpty !== false) {
      root.className = 'grid g-jobs';
      root.innerHTML = '';
      jobNodes = {};
      jobsEmpty = false;
    }
    var seen = {};
    jobs.forEach(function (j, i) {
      var key = String(j.id);
      var n = jobNodes[key];
      if (!n) {
        n = { el: document.createElement('div'), video: document.createElement('div'), meta: document.createElement('div'), vkey: null, msig: null };
        n.el.className = 'card job';
        n.video.className = 'job-video';
        n.meta.className = 'job-meta';
        n.el.appendChild(n.video);
        n.el.appendChild(n.meta);
        jobNodes[key] = n;
      }
      seen[key] = true;
      var url = safeUrl(j.preview_url);
      var vkey = url ? 'v:' + pathOf(url) : 'p:' + j.status;
      if (vkey !== n.vkey) {
        n.vkey = vkey;
        n.video.innerHTML = url
          ? '<video controls playsinline preload="metadata" src="' + esc(url) + '"></video>'
          : '<div class="ph">' + esc(jobPlaceholder(j)) + '</div>';
      }
      var ms = sig(j);
      if (ms !== n.msig) {
        n.msig = ms;
        n.meta.innerHTML = jobMeta(j);
      }
      if (root.children[i] !== n.el) root.insertBefore(n.el, root.children[i] || null);
    });
    Object.keys(jobNodes).forEach(function (key) {
      if (!seen[key]) {
        if (jobNodes[key].el.parentNode === root) root.removeChild(jobNodes[key].el);
        delete jobNodes[key];
      }
    });
  }

  // ---------- Schedulers
  function renderSchedulers(d) {
    var a = (d && d.adapters) || {};
    var drafts = (d && d.drafts) || [];
    var names = [['dryrun', 'Dry-run (always on)'], ['buffer', 'Buffer'], ['zernio', 'Zernio'], ['tiktok', 'TikTok direct (stub)']];
    var h = '<div class="card"><div class="adapters">';
    names.forEach(function (n) {
      h += '<span><i class="dot ' + (a[n[0]] ? 'on' : '') + '"></i>' + esc(n[1]) + (n[0] === 'dryrun' || n[0] === 'tiktok' ? '' : (a[n[0]] ? ' · configured' : ' · not configured')) + '</span>';
    });
    h += '</div><p class="note">Publishing is dry-run by default: a draft is recorded and nothing is posted.</p>';
    if (!drafts.length) {
      h += '<p class="note">No drafts yet — ask your agent to hand a finished video to your scheduler.</p>';
    } else {
      drafts.forEach(function (x) {
        var json = '';
        try { json = JSON.stringify(x.payload, null, 2); } catch (e) { json = ''; }
        h += '<div class="draft"><span class="chip ' + (x.dry_run ? 'info' : 'warn') + '">' + (x.dry_run ? 'dry-run' : 'live') + '</span><span class="chip">' + esc(x.adapter) + '</span> <span class="id-s">' + esc(x.job_id) + ' · ' + esc(when(x.created_at)) + '</span>';
        h += '<details><summary>Payload that would be sent</summary><pre>' + esc(json) + '</pre></details></div>';
      });
    }
    return h + '</div>';
  }

  // ---------- Poll loop
  function render(s) {
    s = s || {};
    setSection('cost', s.spend || null, renderCost);
    setSection('brand', s.brand || null, renderBrand);
    setSection('integrations', s.integrations || null, renderIntegrations);
    setSection('footage', s.assets || [], renderFootage);
    setSection('research', s.research || null, renderResearch);
    setSection('hooks', { hooks: s.hooks || [], run: s.rank_run || null }, renderHooks);
    renderJobs(s.jobs || []);
    setSection('schedulers', { adapters: s.adapters || {}, drafts: s.drafts || [] }, renderSchedulers);
  }
  function setConn(ok, msg) {
    $('conn-dot').className = 'dot ' + (ok ? 'on' : 'off');
    $('conn-text').textContent = ok ? 'Live · updated ' + new Date().toLocaleTimeString() : (msg || 'Disconnected') + ' · retrying';
  }
  function showAuth(on) { $('auth').style.display = on ? 'flex' : 'none'; }
  function load() {
    var headers = {};
    var t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    fetch('/api/state', { headers: headers, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { showAuth(true); throw new Error('Bearer token required'); }
        if (!r.ok) throw new Error('Server returned HTTP ' + r.status);
        showAuth(false);
        return r.json();
      })
      .then(function (s) { render(s); setConn(true); })
      .catch(function (e) { setConn(false, e && e.message ? e.message : 'Disconnected'); })
      .then(function () { setTimeout(load, POLL_MS); });
  }

  $('auth').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = $('auth-token').value.trim();
    if (v) { setToken(v); $('auth-token').value = ''; showAuth(false); }
  });
  // Thumbnails that are missing or expired collapse to a text placeholder.
  document.addEventListener('error', function (ev) {
    var el = ev.target;
    if (el && el.tagName === 'IMG' && el.parentNode && el.parentNode.className === 'thumb') {
      var span = document.createElement('span');
      span.textContent = 'no preview';
      el.parentNode.replaceChild(span, el);
    }
  }, true);

  render({});
  load();
})();
</script>
</body>
</html>
`;
