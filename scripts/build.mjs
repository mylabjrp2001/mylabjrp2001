#!/usr/bin/env node
// Builds the profile SVGs (dark + light) from profile.config.json and data/stats.json.
//   GH_TOKEN=<token> node scripts/build.mjs   fetch fresh stats (incl. private repos), then render
//   node scripts/build.mjs                    no token: render from the committed data/stats.json
// Only aggregate numbers are written to data/stats.json — never code or file contents.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);
const cfg = JSON.parse(await readFile(p('profile.config.json'), 'utf8'));
const TOKEN = process.env.GH_TOKEN || '';

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

async function countCommits(owner, repo, since) {
  let total = 0;
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&author=${owner}&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'profile-build' },
    });
    if (res.status === 409) return 0; // empty repository
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
    const list = await res.json();
    total += list.length;
    if (list.length < 100) return total;
  }
}

async function fetchStats() {
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

  const hide = new Set(cfg.recent.hideRepos || []);
  const areaOf = {};
  for (const [area, names] of Object.entries(cfg.recent.areas || {})) for (const n of names) areaOf[n] = area;
  // GraphQL reports private-repo commits only as "restricted" counts (even to the owner),
  // so per-repo numbers come from REST: default-branch commits linked to this account.
  const since = new Date(Date.now() - cfg.recent.days * 864e5).toISOString();
  const byArea = new Map();
  for (const r of repos) {
    if (hide.has(r.name)) continue;
    const n = await countCommits(login, r.name, since);
    if (!n) continue;
    const area = areaOf[r.name] || r.name;
    byArea.set(area, (byArea.get(area) || 0) + n);
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
  };
}

// ---------- render helpers ----------

const THEMES = {
  dark: {
    bg: '#0d1117', bar: '#161b22', border: '#30363d', rule: '#21262d',
    fg: '#e6edf3', muted: '#8b949e', green: '#3fb950', blue: '#58a6ff', fill: '#2ea043',
    levels: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
  light: {
    bg: '#ffffff', bar: '#f6f8fa', border: '#d1d9e0', rule: '#eaeef2',
    fg: '#1f2328', muted: '#59636e', green: '#1a7f37', blue: '#0969da', fill: '#2da44e',
    levels: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  },
};
const FONT = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
const BAR = 36;
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textW = (s, size) => [...s].length * size * 0.602;
const num = (n) => n.toLocaleString('en-US');

function txt(x, y, s, o = {}) {
  const attrs = [
    `x="${r1(x)}"`, `y="${r1(y)}"`, `class="k-t${o.cls ? ' ' + o.cls : ''}"`, `font-size="${o.size || 13}"`,
    o.anchor && `text-anchor="${o.anchor}"`, o.weight && `font-weight="${o.weight}"`,
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${o.raw ? s : esc(s)}</text>`;
}

function frame(t, { w, h, title, body, css = '', defs = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${r1(h)}" viewBox="0 0 ${w} ${r1(h)}" role="img" aria-label="${esc(title)}">
<style>
.k-t{font-family:${FONT};fill:${t.fg}}
.k-m{fill:${t.muted}}
.k-g{fill:${t.green}}
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

// Docker-style "Up 4 weeks" (same buckets as docker's go-units HumanDuration)
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
  let delay = 0.5;
  cfg.header.lines.forEach((ln, i) => {
    const isCmd = ln.cmd !== undefined;
    const title = ln.style === 'title';
    const size = title ? 19 : 13.5;
    const lh = title ? 32 : 22;
    if (isCmd && i > 0) { top += 10; delay += 0.45; }
    const base = top + lh / 2 + size * 0.35;
    const plain = isCmd ? `$ ${ln.cmd}` : ln.out;
    if (textW(plain, size) > W - PAD * 2) console.warn(`header line too long: "${plain}"`);

    if (isCmd) {
      parts.push(txt(PAD, base, `<tspan class="k-g">$</tspan> ${esc(ln.cmd)}`, { size, raw: true }));
    } else {
      const cls = { muted: 'k-m', link: 'k-b' }[ln.style];
      parts.push(txt(PAD, base, ln.out, { size, cls, weight: title ? 700 : undefined }));
    }
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
    delay += dur + (isCmd ? 0.3 : 0.12);
    top += lh;
  });
  const css = `${keyframes.join('\n')}
.k-cur{animation:k-bl 1.1s step-end infinite}
@keyframes k-bl{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.k-cv{animation:none!important}.k-cur{animation:none}}`;
  return { w: W, h: top + 18, title: cfg.header.host, body: parts.join('\n'), css };
}

function docker(t, now) {
  const W = 900;
  const PAD = 22;
  const LH = 23;
  const { apps, upSince, note } = cfg.docker;
  const cols = 3;
  const rows = Math.ceil(apps.length / cols);
  const colW = (W - PAD * 2) / cols;
  const status = `Up ${humanDuration(now - new Date(upSince))}`;
  const y0 = BAR + 30;
  const parts = [];
  for (let c = 0; c < cols; c++) {
    const x = PAD + c * colW;
    const sx = x + colW - 26;
    parts.push(txt(x, y0, 'NAME', { cls: 'k-m' }), txt(sx, y0, 'STATUS', { cls: 'k-m', anchor: 'end' }));
    for (let r = 0; r < rows; r++) {
      const app = apps[c * rows + r];
      if (!app) continue;
      const y = y0 + LH * (r + 1);
      parts.push(
        txt(x, y, app),
        `<circle cx="${r1(sx - textW(status, 13) - 9)}" cy="${r1(y - 4.5)}" r="3.5" fill="${t.green}"/>`,
        txt(sx, y, status, { cls: 'k-g', anchor: 'end' }),
      );
    }
  }
  const ruleY = y0 + LH * rows + 12;
  parts.push(
    `<line x1="${PAD}" y1="${ruleY}" x2="${W - PAD}" y2="${ruleY}" stroke="${t.border}" stroke-dasharray="3 4"/>`,
    txt(PAD, ruleY + 22, `${apps.length} apps · ${note}`, { cls: 'k-m' }),
  );
  return { w: W, h: ruleY + 40, title: '$ docker compose ps', body: parts.join('\n') };
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

// Platane/snk output (dist/snake-<mode>.svg, written by the workflow) nested inside our frame;
// without it, a static heatmap from the same calendar.
async function snake(t, mode, stats) {
  const W = 900;
  const PAD = 20;
  const y0 = BAR + 16;
  const innerW = W - PAD * 2;
  const title = '$ snake --eat contributions';
  try {
    const src = await readFile(p('dist', `snake-${mode}.svg`), 'utf8');
    const m = src.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/);
    const vb = m && /viewBox="([^"]+)"/.exec(m[1]);
    if (vb) {
      const [, , vw, vh] = vb[1].split(/[\s,]+/).map(Number);
      const h = (innerW * vh) / vw;
      const body = `<svg x="${PAD}" y="${y0}" width="${innerW}" height="${r1(h)}" viewBox="${vb[1]}">${m[2]}</svg>`;
      return { w: W, h: y0 + h + 14, title, body };
    }
  } catch { /* no snake yet: fall through to the static grid */ }

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
    const x = PAD + col * (cell + gap);
    parts.push(`<rect x="${r1(x)}" y="${r1(y0 + row * (cell + gap))}" width="${r1(cell)}" height="${r1(cell)}" rx="2" fill="${t.levels[level(c, q)]}"/>`);
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

let stats;
if (TOKEN) {
  stats = await fetchStats();
  await mkdir(p('data'), { recursive: true });
  const json = JSON.stringify(stats, null, 1).replace(/\[\s+("\d{4}-\d\d-\d\d"),\s+(\d+)\s+\]/g, '[$1,$2]');
  await writeFile(p('data', 'stats.json'), json + '\n');
  console.log(`fetched stats for ${stats.login}: ${stats.calendar.total} contributions, ${stats.repos.total} repos`);
} else {
  try {
    stats = JSON.parse(await readFile(p('data', 'stats.json'), 'utf8'));
    console.log(`GH_TOKEN not set — rendering from data/stats.json (${stats.generatedAt})`);
  } catch {
    console.error('GH_TOKEN not set and data/stats.json is missing');
    process.exit(1);
  }
}

const now = new Date();
await mkdir(p('assets'), { recursive: true });
for (const mode of ['dark', 'light']) {
  const t = THEMES[mode];
  const act = activity(t, stats);
  const lang = languages(t, stats);
  const pairH = Math.max(act.h, lang.h);
  const cards = {
    header: header(t),
    docker: docker(t, now),
    activity: { ...act, h: pairH },
    languages: { ...lang, h: pairH },
    recent: recent(t, stats),
    snake: await snake(t, mode, stats),
  };
  for (const [name, card] of Object.entries(cards)) {
    await writeFile(p('assets', `${name}-${mode}.svg`), frame(t, card));
  }
}
console.log('wrote assets/*-{dark,light}.svg');
