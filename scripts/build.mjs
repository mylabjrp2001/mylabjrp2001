#!/usr/bin/env node
// Builds the profile SVGs (dark + light) from profile.config.json and data/*.json.
//   GH_TOKEN=<token> node scripts/build.mjs   fetch fresh stats (incl. private repos), then render everything
//   node scripts/build.mjs                    no token: render from the committed data/stats.json
//   node scripts/build.mjs --health           only run health checks (HEALTH_URLS) and redraw the services card
// Only aggregate numbers are written to data/ — never code, commit messages or URLs.
// Workflow logs of a public repo are public: never print anything from HEALTH_URLS.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);
const cfg = JSON.parse(await readFile(p('profile.config.json'), 'utf8'));
const TOKEN = process.env.GH_TOKEN || '';
const HEALTH_ONLY = process.argv.includes('--health');

const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };

// ---------- fetch ----------

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-build' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

async function getJson(url, auth = false) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'profile-build' };
  if (auth) headers.Authorization = `bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) { const err = new Error(`GET ${url}: ${res.status}`); err.status = res.status; throw err; }
  return res.json();
}

// Author dates of default-branch commits linked to this account.
async function commitDates(owner, repo, since) {
  const dates = [];
  for (let page = 1; ; page++) {
    let list;
    try {
      list = await getJson(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&author=${owner}&per_page=100&page=${page}`, true);
    } catch (e) {
      if (e.status === 409) return dates; // empty repository
      throw e;
    }
    for (const c of list) dates.push(c.commit.author.date);
    if (list.length < 100) return dates;
  }
}

async function fetchOss(login, prev) {
  const out = [];
  for (const o of cfg.oss || []) {
    try {
      const [doc, dl, repo] = await Promise.all([
        getJson(`https://registry.npmjs.org/${o.npm}`),
        getJson(`https://api.npmjs.org/downloads/range/last-month/${o.npm}`),
        o.repo ? getJson(`https://api.github.com/repos/${login}/${o.repo}`, true) : null,
      ]);
      const latest = doc.versions[doc['dist-tags'].latest];
      out.push({
        npm: o.npm,
        version: latest.version,
        license: latest.license || '',
        deps: Object.keys(latest.dependencies || {}).length,
        peers: Object.keys(latest.peerDependencies || {}),
        versions: Object.keys(doc.versions).length,
        stars: repo ? repo.stargazers_count : 0,
        downloads: dl.downloads.map((d) => d.downloads),
      });
    } catch (e) {
      // npm hiccups shouldn't fail the whole refresh
      const old = prev?.oss?.find((x) => x.npm === o.npm);
      console.warn(`oss ${o.npm}: ${e.message}${old ? ' — keeping previous numbers' : ''}`);
      if (old) out.push(old);
    }
  }
  return out;
}

async function fetchStats(prev) {
  const repos = [];
  let after = null;
  do {
    const d = await gql(`query($after: String) {
      viewer { repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes { name isPrivate languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } } }
      } }
    }`, { after });
    const page = d.viewer.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const d = await gql(`query {
    viewer {
      login
      year: contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } }
    }
  }`);
  const login = d.viewer.login;

  const { alias = {}, colors = {}, exclude = [] } = cfg.languages;
  const skip = new Set(exclude);
  const langs = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) {
      const name = alias[e.node.name] || e.node.name;
      if (skip.has(name)) continue;
      const cur = langs.get(name) || { name, color: colors[name] || e.node.color || '#8b949e', bytes: 0 };
      cur.bytes += e.size;
      langs.set(name, cur);
    }
  }

  // GraphQL reports private-repo commits only as "restricted" counts (even to the owner),
  // so per-repo and per-hour numbers come from REST.
  const hide = new Set(cfg.recent.hideRepos || []);
  const areaOf = {};
  for (const [area, names] of Object.entries(cfg.recent.areas || {})) for (const n of names) areaOf[n] = area;
  const since = new Date(Date.now() - Math.max(cfg.punch.days, cfg.recent.days) * 864e5).toISOString();
  const recentFrom = Date.now() - cfg.recent.days * 864e5;
  const punchFrom = Date.now() - cfg.punch.days * 864e5;
  const byArea = new Map();
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0)); // Mon..Sun × 00..23, Asia/Bangkok
  let punchTotal = 0;
  for (const r of repos) {
    if (hide.has(r.name)) continue;
    let recentN = 0;
    for (const iso of await commitDates(login, r.name, since)) {
      const ms = Date.parse(iso);
      if (ms >= punchFrom) {
        const t = new Date(ms + 7 * 3600e3); // UTC+7, no DST
        grid[(t.getUTCDay() + 6) % 7][t.getUTCHours()]++;
        punchTotal++;
      }
      if (ms >= recentFrom) recentN++;
    }
    if (recentN) {
      const area = areaOf[r.name] || r.name;
      byArea.set(area, (byArea.get(area) || 0) + recentN);
    }
  }

  const cal = d.viewer.year.contributionCalendar;
  return {
    generatedAt: new Date().toISOString(),
    login,
    repos: { total: repos.length, private: repos.filter((r) => r.isPrivate).length },
    calendar: {
      total: cal.totalContributions,
      days: cal.weeks.flatMap((w) => w.contributionDays.map((x) => [x.date, x.contributionCount])),
    },
    languages: [...langs.values()].sort((a, b) => b.bytes - a.bytes),
    recent: {
      days: cfg.recent.days,
      areas: [...byArea].map(([area, commits]) => ({ area, commits })).sort((a, b) => b.commits - a.commits),
    },
    punch: { days: cfg.punch.days, total: punchTotal, grid },
    oss: await fetchOss(login, prev),
  };
}

// Reachability, not correctness: any answer below 500 means the app and its tunnel are up
// (401/403/302 are login walls). 5xx, Cloudflare 52x/530 and timeouts count as down.
const isUp = (s) => typeof s === 'number' && s < 500;

async function runHealth() {
  if (!process.env.HEALTH_URLS) return null;
  let urls;
  try { urls = JSON.parse(process.env.HEALTH_URLS); } catch { throw new Error('HEALTH_URLS is not valid JSON'); }
  const apps = cfg.docker.apps.filter((a) => urls[a]);
  const results = {};
  await Promise.all(apps.map(async (app) => {
    try {
      const res = await fetch(urls[app], { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'profile-healthcheck' } });
      results[app] = res.status;
    } catch {
      results[app] = 'down';
    }
  }));
  const sorted = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
  const down = Object.keys(sorted).filter((k) => !isUp(sorted[k]));
  console.log(`health: ${apps.length - down.length}/${apps.length} up${down.length ? ` · down: ${down.join(', ')}` : ''}`);
  return sorted;
}

// ---------- render helpers ----------

const THEMES = {
  dark: {
    bg: '#0d1117', bar: '#161b22', border: '#30363d', rule: '#21262d',
    fg: '#e6edf3', muted: '#8b949e', green: '#3fb950', red: '#f85149', blue: '#58a6ff', fill: '#2ea043',
    levels: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
    blocks: ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#e6edf3'],
  },
  light: {
    bg: '#ffffff', bar: '#f6f8fa', border: '#d1d9e0', rule: '#eaeef2',
    fg: '#1f2328', muted: '#59636e', green: '#1a7f37', red: '#cf222e', blue: '#0969da', fill: '#2da44e',
    levels: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    blocks: ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#d0d7de'],
  },
};
const FONT = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
const BAR = 36;
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textW = (s, size) => [...s].length * size * 0.602;
const num = (n) => n.toLocaleString('en-US');
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

function txt(x, y, s, o = {}) {
  const attrs = [
    `x="${r1(x)}"`, `y="${r1(y)}"`, `class="k-t${o.cls ? ' ' + o.cls : ''}"`, `font-size="${o.size || 13}"`,
    o.anchor && `text-anchor="${o.anchor}"`, o.weight && `font-weight="${o.weight}"`,
  ].filter(Boolean);
  return `<text xml:space="preserve" ${attrs.join(' ')}>${o.raw ? s : esc(s)}</text>`;
}

function frame(t, { w, h, title, body, css = '', defs = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${w}" height="${r1(h)}" viewBox="0 0 ${w} ${r1(h)}" role="img" aria-label="${esc(title)}">
<style>
.k-t{font-family:${FONT};fill:${t.fg};white-space:pre}
.k-m{fill:${t.muted}}
.k-g{fill:${t.green}}
.k-r{fill:${t.red}}
.k-b{fill:${t.blue}}
${css}
</style>
<defs><clipPath id="k-win"><rect x="0.5" y="0.5" width="${w - 1}" height="${r1(h - 1)}" rx="8"/></clipPath>${defs}</defs>
<g clip-path="url(#k-win)">
<rect width="${w}" height="${r1(h)}" fill="${t.bg}"/>
<rect width="${w}" height="${BAR}" fill="${t.bar}"/>
<line x1="0" y1="${BAR - 0.5}" x2="${w}" y2="${BAR - 0.5}" stroke="${t.border}"/>
<circle cx="18" cy="18" r="5.5" fill="#ff5f57"/><circle cx="36" cy="18" r="5.5" fill="#febc2e"/><circle cx="54" cy="18" r="5.5" fill="#28c840"/>
${txt(72, 22.5, title, { cls: 'k-m', size: 12.5 })}
${body}
</g>
<rect x="0.5" y="0.5" width="${w - 1}" height="${r1(h - 1)}" rx="8" fill="none" stroke="${t.border}"/>
</svg>
`;
}

// Docker-style "4 weeks" (same buckets as docker's go-units HumanDuration)
function humanDuration(ms) {
  const s = ms / 1000;
  const h = s / 3600;
  if (s < 60) return `${Math.max(1, Math.floor(s))} seconds`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes`;
  if (h < 48) return `${Math.round(h)} hours`;
  if (h < 24 * 7 * 2) return `${Math.floor(h / 24)} days`;
  if (h < 24 * 30 * 2) return `${Math.floor(h / 24 / 7)} weeks`;
  if (h < 24 * 365 * 2) return `${Math.floor(h / 24 / 30)} months`;
  return `${Math.floor(h / 24 / 365)} years`;
}

function quartiles(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f) => (nz.length ? nz[Math.floor((nz.length - 1) * f)] : 0);
  return [q(0.25), q(0.5), q(0.75)];
}
const level = (v, [a, b, c]) => (v === 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);

// ---------- cards ----------

function header(t) {
  const W = 900;
  const PAD = 24;
  const parts = [];
  const keyframes = [];
  let top = BAR + 14;
  let delay = 0.4;
  cfg.header.lines.forEach((ln, i) => {
    const isCmd = ln.cmd !== undefined;
    const isBoot = Boolean(ln.ok || ln.target);
    const title = ln.style === 'title';
    const size = title ? 19 : 13.5;
    const lh = title ? 32 : 22;
    if (isCmd && i > 0) { top += 10; delay += 0.45; }
    const base = top + lh / 2 + size * 0.35;

    let plain;
    if (isBoot) {
      const verb = ln.ok ? 'Started' : 'Reached target';
      const name = ln.ok || ln.target;
      const end = ln.target ? '.' : '';
      const note = ln.note ? ` ${ln.note}` : '';
      plain = `[  OK  ] ${verb} ${name}${end}${note}`;
      parts.push(txt(PAD, base,
        `[  <tspan class="k-g">OK</tspan>  ] ${verb} <tspan font-weight="600">${esc(name)}</tspan>${end}${ln.note ? ` <tspan class="k-m">${esc(ln.note)}</tspan>` : ''}`,
        { size, raw: true }));
    } else if (isCmd) {
      plain = `$ ${ln.cmd}`;
      parts.push(txt(PAD, base, `<tspan class="k-g">$</tspan> ${esc(ln.cmd)}`, { size, raw: true }));
    } else {
      plain = ln.out;
      const cls = { muted: 'k-m', link: 'k-b' }[ln.style];
      parts.push(txt(PAD, base, ln.out, { size, cls, weight: title ? 700 : undefined }));
    }
    if (textW(plain, size) > W - PAD * 2) console.warn(`header line too long: "${plain}"`);
    if (isCmd && ln.cmd === '') {
      const x = PAD + textW('$ ', size);
      parts.push(`<rect class="k-cur" x="${r1(x)}" y="${r1(base - size * 0.82)}" width="${r1(size * 0.6)}" height="${r1(size * 1.05)}" fill="${t.green}"/>`);
    }

    // Cover rect slides right to "type" the line. Its resting state is uncovered, and the
    // keyframes only cover it during the delay, so the text still shows if animation never runs.
    const cw = textW(plain, size) + 16;
    const chars = [...plain].length;
    const dur = isCmd ? Math.max(0.3, chars * 0.06) : 0.05;
    const steps = isCmd ? chars + 2 : 1;
    keyframes.push(`@keyframes k-r${i}{from{transform:translateX(0)}to{transform:translateX(${r1(cw)}px)}}`);
    parts.push(`<rect class="k-cv" x="${PAD - 3}" y="${r1(top)}" width="${r1(cw)}" height="${lh}" fill="${t.bg}" style="transform:translateX(${r1(cw)}px);animation:k-r${i} ${r1(dur)}s steps(${steps},end) ${r1(delay)}s backwards"/>`);
    delay += dur + (isCmd ? 0.3 : isBoot ? 0.14 : 0.12);
    top += lh;
  });
  const css = `${keyframes.join('\n')}
.k-cur{animation:k-bl 1.1s step-end infinite}
@keyframes k-bl{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.k-cv{animation:none!important}.k-cur{animation:none}}`;
  return { w: W, h: top + 18, title: cfg.header.host, body: parts.join('\n'), css };
}

function neofetch(t, stats, now) {
  const W = 900;
  const PAD = 24;
  const LH = 22;
  const nf = cfg.neofetch;
  const vars = {
    uptime: humanDuration(now - new Date(cfg.docker.upSince)),
    apps: cfg.docker.apps.length,
    repos: num(stats.repos.total),
    private: num(stats.repos.private),
  };
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const artTop = BAR + 30;
  const artW = Math.max(...nf.art.map((l) => textW(l, 13)));
  const x = PAD + artW + 36;
  const labelW = Math.max(...nf.rows.map(([k]) => textW(k, 13))) + 16;
  const parts = nf.art.map((l, i) => txt(PAD, artTop + i * 18, l, { cls: 'k-g' }));
  const [user, host] = nf.title.split('@');
  let y = BAR + 30;
  parts.push(txt(x, y, `<tspan class="k-g">${esc(user)}</tspan>@<tspan class="k-g">${esc(host)}</tspan>`, { raw: true, weight: 600 }));
  y += LH;
  parts.push(txt(x, y, '-'.repeat([...nf.title].length), { cls: 'k-m' }));
  for (const [k, v] of nf.rows) {
    y += LH;
    const value = fill(v);
    if (x + labelW + textW(value, 13) > W - PAD) console.warn(`neofetch row too long: "${k}: ${value}"`);
    parts.push(txt(x, y, k, { cls: 'k-b', weight: 600 }), txt(x + labelW, y, value));
  }
  y += 16;
  t.blocks.forEach((c, i) => parts.push(`<rect x="${r1(x + i * 24)}" y="${r1(y)}" width="24" height="14" fill="${c}"/>`));
  const h = Math.max(y + 14, artTop + nf.art.length * 18) + 20;
  return { w: W, h, title: '$ neofetch', body: parts.join('\n') };
}

// Health check results when HEALTH_URLS is configured; otherwise docker-style uptime.
function services(t, now, health) {
  const W = 900;
  const PAD = 22;
  const LH = 23;
  const { apps, upSince, note } = cfg.docker;
  const cols = 3;
  const rows = Math.ceil(apps.length / cols);
  const colW = (W - PAD * 2) / cols;
  const uptime = `Up ${humanDuration(now - new Date(upSince))}`;
  const y0 = BAR + 30;
  const parts = [];
  for (let c = 0; c < cols; c++) {
    const x = PAD + c * colW;
    const sx = x + colW - 26;
    parts.push(txt(x, y0, health ? 'APP' : 'NAME', { cls: 'k-m' }), txt(sx, y0, health ? 'HTTP' : 'STATUS', { cls: 'k-m', anchor: 'end' }));
    for (let r = 0; r < rows; r++) {
      const app = apps[c * rows + r];
      if (!app) continue;
      const y = y0 + LH * (r + 1);
      let label = uptime;
      let cls = 'k-g';
      let dot = t.green;
      if (health) {
        const s = health[app];
        if (s === undefined) { label = '—'; cls = 'k-m'; dot = null; }
        else { label = s === 'down' ? 'DOWN' : String(s); if (!isUp(s)) { cls = 'k-r'; dot = t.red; } }
      }
      parts.push(txt(x, y, app), txt(sx, y, label, { cls, anchor: 'end' }));
      if (dot) parts.push(`<circle cx="${r1(sx - textW(label, 13) - 9)}" cy="${r1(y - 4.5)}" r="3.5" fill="${dot}"/>`);
    }
  }
  const ruleY = y0 + LH * rows + 12;
  let footer = `${apps.length} apps · ${note}`;
  if (health) {
    const checked = Object.keys(health);
    const up = checked.filter((a) => isUp(health[a])).length;
    const missing = apps.length - checked.length;
    footer = `${up}/${checked.length} up · ${cfg.health.note}${missing ? ` · ${missing} not monitored` : ''}`;
  }
  parts.push(
    `<line x1="${PAD}" y1="${ruleY}" x2="${W - PAD}" y2="${ruleY}" stroke="${t.border}" stroke-dasharray="3 4"/>`,
    txt(PAD, ruleY + 22, footer, { cls: 'k-m' }),
  );
  return { w: W, h: ruleY + 40, title: health ? '$ healthcheck --all' : '$ docker compose ps', body: parts.join('\n') };
}

function activity(t, stats) {
  const W = 445;
  const PAD = 22;
  const days = stats.calendar.days.map(([, c]) => c);
  let longest = 0;
  let run = 0;
  for (const c of days) { run = c > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  const active = days.filter((c) => c > 0).length;
  const big = BAR + 50;
  const parts = [
    txt(PAD, big, num(stats.calendar.total), { size: 32, weight: 700 }),
    txt(PAD, big + 22, 'contributions · last 12 months · incl. private', { cls: 'k-m', size: 12.5 }),
  ];
  const rows = [
    ['repositories', num(stats.repos.total)],
    ['private', num(stats.repos.private)],
    ['active days', num(active)],
    ['longest streak', `${longest} days`],
  ];
  let y = big + 38;
  for (const [k, v] of rows) {
    parts.push(
      `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${t.rule}"/>`,
      txt(PAD, y + 17.5, k),
      txt(W - PAD, y + 17.5, v, { anchor: 'end', weight: 600 }),
    );
    y += 26;
  }
  return { w: W, h: y + 12, title: '$ git stats --last 12mo', body: parts.join('\n') };
}

function languages(t, stats) {
  const W = 445;
  const PAD = 22;
  const all = stats.languages;
  const total = all.reduce((s, l) => s + l.bytes, 0) || 1;
  const top = all.slice(0, cfg.languages.top);
  const rest = all.slice(cfg.languages.top).reduce((s, l) => s + l.bytes, 0);
  const items = [...top, ...(rest > 0 ? [{ name: 'Other', color: t.muted, bytes: rest }] : [])];
  const barY = BAR + 24;
  const barW = W - PAD * 2;
  const parts = [];
  let x = PAD;
  for (const l of items) {
    const w = (l.bytes / total) * barW;
    parts.push(`<rect x="${r1(x)}" y="${barY}" width="${r1(w)}" height="10" fill="${l.color}"/>`);
    x += w;
  }
  const defs = `<clipPath id="k-lb"><rect x="${PAD}" y="${barY}" width="${barW}" height="10" rx="5"/></clipPath>`;
  const bar = `<g clip-path="url(#k-lb)">${parts.join('')}</g>`;
  const legend = [];
  let y = barY + 10 + 28;
  for (const l of items) {
    legend.push(
      `<circle cx="${PAD + 5}" cy="${r1(y - 4.5)}" r="5" fill="${l.color}"/>`,
      txt(PAD + 18, y, l.name),
      txt(W - PAD, y, `${((l.bytes / total) * 100).toFixed(1)}%`, { cls: 'k-m', anchor: 'end' }),
    );
    y += 24;
  }
  return { w: W, h: y - 6, title: '$ linguist --all-repos', body: bar + '\n' + legend.join('\n'), defs };
}

function punch(t, stats) {
  const W = 900;
  const PAD = 22;
  const L = 46;
  const RH = 30;
  const { grid, total, days } = stats.punch;
  const C = (W - PAD * 2 - L) / 24;
  const max = Math.max(1, ...grid.flat());
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const top = BAR + 16;
  const parts = [];
  grid.forEach((row, d) => {
    const cy = top + d * RH + RH / 2;
    parts.push(
      txt(PAD, cy + 4.5, names[d], { cls: 'k-m', size: 12 }),
      `<line x1="${PAD + L}" y1="${r1(cy)}" x2="${W - PAD}" y2="${r1(cy)}" stroke="${t.rule}"/>`,
    );
    row.forEach((v, h) => {
      if (!v) return;
      const r = Math.max(1.6, Math.sqrt(v / max) * 13);
      parts.push(`<circle cx="${r1(PAD + L + h * C + C / 2)}" cy="${r1(cy)}" r="${r1(r)}" fill="${t.green}"/>`);
    });
  });
  const ly = top + 7 * RH + 16;
  for (let h = 0; h < 24; h += 3) parts.push(txt(PAD + L + h * C + C / 2, ly, hh(h), { cls: 'k-m', size: 11.5, anchor: 'middle' }));

  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, r) => s + r[h], 0));
  const byDay = grid.map((r) => r.reduce((a, b) => a + b, 0));
  const night = [22, 23, 0, 1, 2, 3, 4].reduce((s, h) => s + byHour[h], 0);
  const b = (s) => `<tspan font-weight="600">${esc(s)}</tspan>`;
  const sy = ly + 28;
  const summary = total
    ? [
      `peak ${b(hh(byHour.indexOf(Math.max(...byHour))))}`,
      `busiest ${b(names[byDay.indexOf(Math.max(...byDay))])}`,
      `${b(`${Math.round((night / total) * 100)}%`)} after 22:00`,
      `<tspan class="k-m">${num(total)} commits${byDay.every((v) => v > 0) ? ' · 7 days a week' : ''}</tspan>`,
    ].join(' · ')
    : `<tspan class="k-m">no commits in the last ${days} days</tspan>`;
  parts.push(txt(PAD, sy, summary, { raw: true, size: 12.5 }));
  return { w: W, h: sy + 18, title: `$ git log --since=${days}.days --format=%ad | punchcard`, body: parts.join('\n') };
}

function oss(t, o, conf) {
  const W = 900;
  const PAD = 22;
  const LW = 110;
  const parts = [];
  let y = BAR + 30;
  const meta = [o.license, `deps: ${o.deps}`, `versions: ${o.versions}`, o.stars ? `★ ${o.stars}` : null].filter(Boolean).join(' | ');
  parts.push(txt(PAD, y,
    `<tspan class="k-b" font-weight="600">${esc(o.npm)}</tspan><tspan class="k-g" font-weight="600">@${esc(o.version)}</tspan> <tspan class="k-m">| ${esc(meta)}</tspan>`,
    { raw: true }));
  y += 22;
  parts.push(txt(PAD, y, conf.tagline || '', { cls: 'k-m' }));

  y += 40;
  const total = o.downloads.reduce((a, b) => a + b, 0);
  parts.push(txt(PAD, y, 'downloads', { cls: 'k-m' }), txt(PAD + LW, y, num(total), { size: 22, weight: 700 }));
  const afterNum = PAD + LW + textW(num(total), 22) + 12;
  parts.push(txt(afterNum, y, 'last 30 days', { cls: 'k-m' }));
  const sx = afterNum + textW('last 30 days', 13) + 24;
  const sw = W - PAD - sx;
  const n = o.downloads.length || 1;
  const bw = (sw - (n - 1) * 2) / n;
  const max = Math.max(1, ...o.downloads);
  o.downloads.forEach((v, i) => {
    const h = Math.max(1.5, (v / max) * 34);
    parts.push(`<rect x="${r1(sx + i * (bw + 2))}" y="${r1(y + 2 - h)}" width="${r1(bw)}" height="${r1(h)}" rx="1" fill="${t.fill}"/>`);
  });
  y += 30;
  parts.push(txt(PAD, y, 'peer deps', { cls: 'k-m' }), txt(PAD + LW, y, o.peers.join(' · ') || '—'));
  if (conf.platforms) {
    y += 22;
    parts.push(txt(PAD, y, 'platforms', { cls: 'k-m' }), txt(PAD + LW, y, conf.platforms));
  }
  return { w: W, h: y + 20, title: `$ npm view ${o.npm}`, body: parts.join('\n') };
}

function recent(t, stats) {
  const W = 900;
  const PAD = 22;
  const LH = 24;
  const { days, areas } = stats.recent;
  const grouped = Object.keys(cfg.recent.areas || {}).length > 0;
  const title = `$ git log --since="${days} days ago" --by-${grouped ? 'area' : 'repo'}`;
  if (!areas.length) {
    return { w: W, h: BAR + 60, title, body: txt(PAD, BAR + 36, `no commits in the last ${days} days`, { cls: 'k-m' }) };
  }
  const shown = areas.slice(0, cfg.recent.max);
  const max = shown[0].commits;
  const labelW = Math.min(240, Math.max(110, Math.max(...shown.map((a) => textW(a.area, 13))) + 16));
  const barX = PAD + labelW;
  const barMax = W - PAD - 56 - barX;
  const parts = [];
  let y = BAR + 32;
  for (const a of shown) {
    parts.push(
      txt(PAD, y, a.area),
      `<rect x="${r1(barX)}" y="${r1(y - 9.5)}" width="${r1(Math.max(3, (a.commits / max) * barMax))}" height="9" rx="2" fill="${t.fill}"/>`,
      txt(W - PAD, y, num(a.commits), { cls: 'k-m', anchor: 'end' }),
    );
    y += LH;
  }
  const total = areas.reduce((s, a) => s + a.commits, 0);
  const more = areas.length > shown.length ? ` · top ${shown.length} shown` : '';
  parts.push(txt(PAD, y + 8, `${num(total)} commits across ${areas.length} ${grouped ? 'areas' : 'repos'}${more}`, { cls: 'k-m', size: 12.5 }));
  return { w: W, h: y + 30, title, body: parts.join('\n') };
}

// Platane/snk output (dist/snake-<mode>.svg, written by the workflow) nested inside our frame.
// Without it, keep the committed snake; only draw a static heatmap when there is none yet.
async function snake(t, mode, stats) {
  const W = 900;
  const PAD = 20;
  const y0 = BAR + 16;
  const innerW = W - PAD * 2;
  const title = '$ snake --eat contributions';
  const src = await readFile(p('dist', `snake-${mode}.svg`), 'utf8').catch(() => null);
  const m = src && src.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/);
  const vb = m && /viewBox="([^"]+)"/.exec(m[1]);
  if (vb) {
    const [, , vw, vh] = vb[1].split(/[\s,]+/).map(Number);
    const h = (innerW * vh) / vw;
    const body = `<svg x="${PAD}" y="${y0}" width="${innerW}" height="${r1(h)}" viewBox="${vb[1]}">${m[2]}</svg>`;
    return { w: W, h: y0 + h + 14, title, body };
  }
  if (await exists(p('assets', `snake-${mode}.svg`))) return null;

  const days = stats.calendar.days;
  const q = quartiles(days.map(([, c]) => c));
  const gap = 3;
  const cols = 53;
  const cell = (innerW - gap * (cols - 1)) / cols;
  const firstDow = new Date(`${days[0][0]}T00:00:00Z`).getUTCDay();
  const parts = [];
  const months = [];
  days.forEach(([date, c], i) => {
    const idx = i + firstDow;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    parts.push(`<rect x="${r1(PAD + col * (cell + gap))}" y="${r1(y0 + row * (cell + gap))}" width="${r1(cell)}" height="${r1(cell)}" rx="2" fill="${t.levels[level(c, q)]}"/>`);
    if (date.endsWith('-01') || i === 0) months.push([col, date]);
  });
  const labelY = y0 + 7 * (cell + gap) + 14;
  let last = -9;
  for (const [col, date] of months) {
    if (col - last < 3) continue;
    const name = new Date(`${date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    parts.push(txt(PAD + col * (cell + gap), labelY, name, { cls: 'k-m', size: 11 }));
    last = col;
  }
  return { w: W, h: labelY + 14, title, body: parts.join('\n') };
}

// ---------- main ----------

const now = new Date();
await mkdir(p('data'), { recursive: true });
await mkdir(p('assets'), { recursive: true });
const write = async (name, mode, card) => card && writeFile(p('assets', `${name}-${mode}.svg`), frame(THEMES[mode], card));

let health = await runHealth();
if (health) await writeFile(p('data', 'health.json'), JSON.stringify(health, null, 1) + '\n');
else health = await readJson(p('data', 'health.json'));

if (HEALTH_ONLY) {
  if (!process.env.HEALTH_URLS) { console.log('HEALTH_URLS not set — nothing to check'); process.exit(0); }
  for (const mode of ['dark', 'light']) await write('services', mode, services(THEMES[mode], now, health));
  console.log('wrote assets/services-{dark,light}.svg');
  process.exit(0);
}

const prev = await readJson(p('data', 'stats.json'));
let stats;
if (TOKEN) {
  stats = await fetchStats(prev);
  const json = JSON.stringify(stats, null, 1)
    .replace(/\[\s+("\d{4}-\d\d-\d\d"),\s+(\d+)\s+\]/g, '[$1,$2]')
    .replace(/\[\s+(\d+(?:,\s+\d+)*)\s+\]/g, (s, inner) => `[${inner.replace(/\s+/g, '')}]`);
  await writeFile(p('data', 'stats.json'), json + '\n');
  console.log(`fetched stats for ${stats.login}: ${stats.calendar.total} contributions, ${stats.repos.total} repos, ${stats.punch.total} commits in ${stats.punch.days} days`);
} else if (prev) {
  stats = prev;
  console.log(`GH_TOKEN not set — rendering from data/stats.json (${stats.generatedAt})`);
} else {
  console.error('GH_TOKEN not set and data/stats.json is missing');
  process.exit(1);
}

for (const mode of ['dark', 'light']) {
  const t = THEMES[mode];
  const act = activity(t, stats);
  const lang = languages(t, stats);
  const pairH = Math.max(act.h, lang.h);
  await write('header', mode, header(t));
  await write('neofetch', mode, neofetch(t, stats, now));
  await write('services', mode, services(t, now, health));
  await write('activity', mode, { ...act, h: pairH });
  await write('languages', mode, { ...lang, h: pairH });
  if (stats.punch) await write('punch', mode, punch(t, stats));
  for (const [i, o] of (stats.oss || []).entries()) {
    const conf = (cfg.oss || []).find((c) => c.npm === o.npm) || {};
    await write(i ? `oss-${i + 1}` : 'oss', mode, oss(t, o, conf));
  }
  await write('recent', mode, recent(t, stats));
  await write('snake', mode, await snake(t, mode, stats));
}
console.log('wrote assets/*-{dark,light}.svg');
