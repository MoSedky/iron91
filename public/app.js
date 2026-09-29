'use strict';

// ---------- utils ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const num = (n) => Math.round(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const clock = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

let S = null;          // state from the server
let view = 'today';
let selDay = null;     // selected day on the Record calendar
let skew = 0;          // server clock minus device clock, in ms
let booted = false;
let waterNagged = false;
const cam = { stream: null, facing: 'user', mode: 'daily' };

const RANKS = [[0, 'Prospect'], [60, 'Contender'], [140, 'Challenger'], [240, 'Champion'], [350, 'Undisputed'], [450, 'Legend']];
const CRIES = [
  'Show up. Most of the fight is showing up.',
  'The boss is losing health. Keep hitting.',
  'Your streak is watching.',
  "Iron doesn't negotiate. Neither do you.",
  'Check in. Lift. Check out. Repeat.',
  'Nobody lifts it for you.',
  'Tired is a feeling. Done is a fact.',
  'Protein first. Excuses never.',
  'The couch has never won a round.',
  'Water is part of the program.',
  'One more rep. One more round.',
  'Future you already said thanks.',
  'Win today. Then win tomorrow.',
  'Slow is fine. Stopping is not.',
  'Heavy day or light day, it still counts.',
];

// ---------- server ----------
async function api(path, body, method) {
  const res = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Log in first.'); }
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${res.status}).`);
  return data;
}

async function load() {
  S = await api('/state');
  skew = Date.parse(S.now) - Date.now();
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  if (!booted && !S.ready) view = 'setup';
  booted = true;
  render();
  nagWater();
}

function showLogin() {
  for (const v of $$('main > .view')) v.hidden = v.id !== 'login';
  $('#tabs').hidden = true;
  $('.ticker').hidden = true;
}

// ---------- derived values ----------
const cfg = () => S.settings;
const now = () => new Date(Date.now() + skew);
const kcalToday = () => S.meals.filter((m) => m.day === S.today).reduce((a, m) => a + m.kcal, 0);
const lastKg = () => (S.weights.length ? S.weights.at(-1).kg : cfg().start_kg);
const lostKg = () => Math.max(0, cfg().start_kg - lastKg());
const weighDue = () => !S.weights.length || daysBetween(S.weights.at(-1).day, S.today) >= 7;
const record = () => [S.days.filter((d) => d.state === 'won').length, S.days.filter((d) => d.state === 'lost').length];
const roundOf = (day) => daysBetween(cfg().start, day) + 1;
const missing = () => [!cfg().start_kg && 'start weight', !cfg().kcal_limit && 'calorie limit', !cfg().gym && 'gym location'].filter(Boolean);
function rank(p) {
  let cur = RANKS[0], next = null;
  for (const r of RANKS) { if (p >= r[0]) cur = r; else { next = r; break; } }
  return { name: cur[1], next };
}

// ---------- render ----------
function render() {
  for (const v of $$('main > .view')) v.hidden = v.id !== `v-${view}`;
  for (const b of $$('#tabs button')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  ({ today: renderToday, fuel: renderFuel, record: renderRecord, wall: renderWall, setup: renderSetup })[view]();
  renderTicker();
}

function renderTicker() {
  const bar = $('.ticker');
  bar.hidden = !S?.ready;
  if (bar.hidden) return;
  const s = cfg(), n = S.day_n;
  const bits = [
    n < 1 ? (n === 0 ? 'Fight starts tomorrow' : `Fight starts in ${1 - n} days`) : n > s.days ? 'Final bell' : `Round ${n} of ${s.days}`,
    `${S.points} points`, `${S.streak}-day streak`, `${num(Math.max(0, s.kcal_limit - kcalToday()))} kcal left`,
    `Water ${S.water.glasses} of ${s.water_goal}`, `${lostKg().toFixed(1)} kg down`, 'Zero cheat meals',
  ].map((b) => `<span>${esc(b)}</span><i>✦</i>`).join('');
  $('#ticker').innerHTML = bits + bits;
}

// ---------- Today ----------
function renderToday() {
  $('#hero').innerHTML = heroHTML();
  $('#board').innerHTML = S.ready ? boardHTML() : '';
  if (!S.ready) {
    $('#mission').innerHTML = `<div class="panel pink"><h2 class="slab">Set up your fight</h2>
      <p>Still needed: ${missing().join(', ')}.</p><button class="btn big" data-go="setup">Open setup</button></div>`;
    $('#today-extra').innerHTML = '';
    return;
  }
  $('#mission').innerHTML = S.day_n > cfg().days ? finalHTML() : missionHTML();
  $('#today-extra').innerHTML = fuelMiniHTML() + waterHTML() + bossHTML();
  tick();
}

function heroHTML() {
  const s = cfg(), n = S.day_n ?? 0;
  const live = S.ready && n >= 1 && n <= s.days;
  let sub = `of ${s.days}`;
  if (!S.ready) sub = 'Setup first';
  else if (n < 1) sub = n === 0 ? 'Starts tomorrow' : `Starts in ${1 - n} days`;
  else if (n > s.days) sub = 'Final bell rang';
  return `
    <div class="vs"><span class="me">${esc(s.name || 'You')}</span><span class="vs-x">vs</span><span class="foe">${s.goal_loss} kg</span></div>
    <div class="round"><span class="round-word">Round</span>
      <span class="round-num">${live ? pad2(n) : n > s.days ? pad2(s.days) : '00'}</span><span class="round-of">${sub}</span></div>
    ${live && n <= s.iron_days ? `<p class="sticker">Iron ${s.iron_days}: day ${n} of ${s.iron_days}. A miss costs ${s.pen_miss_iron}, not ${s.pen_miss}.</p>` : ''}
`;
}

function boardHTML() {
  const r = rank(S.points), [w, l] = record(), n = S.day_n ?? 0;
  return `
    <div class="scores">
      <div class="belt"><div class="plate"><span class="pts">${signed(S.points).replace('+', '')}</span><span class="pts-l">points</span><span class="rank">${r.name}</span></div></div>
      <p class="to-next">${r.next ? `${r.next[0] - S.points} points to ${r.next[1]}` : 'Top rank. Defend it.'}</p>
      <div class="mini streak"><b>${S.streak}${S.streak >= 3 ? ' 🔥' : ''}</b><span>day streak</span></div>
      <div class="mini rec"><b>${w}–${l}</b><span>won–lost</span></div>
    </div>
    <p class="tape"><span>${esc(CRIES[Math.max(0, n - 1) % CRIES.length])}</span></p>`;
}

function missionHTML() {
  const s = cfg(), se = S.session, ph = S.photo, n = S.day_n, practice = n < 1;
  const photoOk = ph && ph.status !== 'fail';
  if (se?.out_at) {
    const row = S.days.find((d) => d.date === se.day);
    return `<div class="panel yellow mission won">
      <h2 class="slab">${practice ? 'Practice round done' : `Round ${roundOf(se.day)} won`}</h2>
      <p>Checked in ${clock(se.in_at)}, out ${clock(se.out_at)}.
        ${practice ? "Everything works. Tomorrow it's real." : `${signed(row?.pts ?? 0)} points today.`}</p>
      <span class="stamp" aria-hidden="true">W</span></div>`;
  }
  const step = (i, state, title, detail, action = '') => `
    <li class="step ${state}"><span class="n">${state === 'done' ? '✓' : i}</span>
      <div><b>${title}</b>${detail ? `<small>${detail}</small>` : ''}</div>${action}</li>`;
  const s1 = se
    ? step(1, 'done', `Checked in ${clock(se.in_at)}`, `${fmtDist(se.in_dist)} from the gym. In for <span id="timer" data-in="${se.in_at}"></span>`)
    : step(1, 'active', 'Check in', `At your gym, within ${s.radius_m} m`, '<button class="btn" data-act="checkin">Check in</button>');
  let s2;
  if (!se) s2 = step(2, 'locked', 'Take gym photo', 'Unlocks after check-in');
  else if (photoOk) s2 = step(2, 'done', ph.status === 'pass' ? 'Photo verified' : 'Photo saved, not verified',
    ph.status === 'pass' ? `Matches your gym (${ph.confidence}% sure)` : esc(ph.reason));
  else if (!S.refs.length) s2 = step(2, 'active', 'Take gym photo',
    'First take 3 reference photos of the gym from different spots. Daily photos are checked against them.',
    '<button class="btn" data-act="refcam">Take reference photo</button>');
  else if (ph) s2 = step(2, 'fail', 'Photo rejected', `${esc(ph.reason)}. Get more of the gym behind you. ${6 - S.tries} tries left.`,
    S.tries < 6 ? '<button class="btn" data-act="cam">Retake photo</button>' : '');
  else s2 = step(2, 'active', 'Take gym photo',
    `Live camera only, with the gym behind you.${S.refs.length < 3 ? ` ${S.refs.length} of 3 reference photos taken.` : ''}`,
    '<button class="btn" data-act="cam">Take gym photo</button>');
  let s3;
  const minsIn = se ? (now() - Date.parse(se.in_at)) / 60000 : 0;
  if (!photoOk) s3 = step(3, 'locked', 'Check out', `After your photo, at least ${s.min_session_min} min after check-in`);
  else if (minsIn < s.min_session_min) s3 = step(3, 'locked', 'Check out', `Opens in <span id="opens" data-in="${se.in_at}"></span>`);
  else s3 = step(3, 'active', 'Check out', 'Still at the gym? Lock in the round.', '<button class="btn" data-act="checkout">Check out</button>');
  return `<div class="panel yellow mission">
    <h2 class="slab">${practice ? 'Practice round' : "Today's session"}</h2>
    ${practice ? '<p class="note">Nothing counts until day 1. Test check-in and photos now.</p>' : ''}
    <ol class="steps">${s1}${s2}${s3}</ol></div>`;
}

function finalHTML() {
  const [w, l] = record();
  return `<div class="panel yellow mission"><h2 class="slab">Final bell</h2>
    <p>${w} rounds won, ${l} lost. ${S.points} points. ${lostKg().toFixed(1)} kg down.</p></div>`;
}

function meterHTML(k, limit, floor) {
  const max = Math.max(limit * 1.25, k);
  const cls = k > limit ? 'over' : k >= limit * 0.85 ? 'near' : '';
  return `<div class="meter ${cls}" role="img" aria-label="${num(k)} of ${num(limit)} kcal">
    <div class="fill" style="width:${Math.min(100, (k / max) * 100)}%"></div>
    <i class="mark floor" style="left:${(floor / max) * 100}%"></i><i class="mark limit" style="left:${(limit / max) * 100}%"></i></div>`;
}

function fuelMiniHTML() {
  const s = cfg(), k = kcalToday(), left = s.kcal_limit - k;
  return `<div class="panel">
    <h2 class="slab">Fuel</h2>
    <p class="big-line">${num(k)} <span>of ${num(s.kcal_limit)} kcal</span></p>
    ${meterHTML(k, s.kcal_limit, s.kcal_floor)}
    <p class="note">${left >= 0 ? `${num(left)} kcal left today.` : `Over by ${num(-left)} kcal. That's −${s.pen_kcal} today.`}</p>
    <button class="btn" data-go="fuel">Add meal</button></div>`;
}

function waterHTML() {
  const s = cfg(), g = S.water.glasses;
  const mins = S.water.last_at ? (now() - Date.parse(S.water.last_at)) / 60000 : Infinity;
  const cups = Array.from({ length: Math.max(s.water_goal, g) }, (_, i) => `<i class="cup${i < g ? ' full' : ''}"></i>`).join('');
  return `<div class="panel water">
    <h2 class="slab">Water</h2>
    <p class="big-line">${g} <span>of ${s.water_goal} glasses</span></p>
    <div class="cups" aria-hidden="true">${cups}</div>
    <p class="note${mins >= s.water_every_min && g < s.water_goal ? ' due' : ''}" id="sip">${sipText()}</p>
    <div class="row"><button class="btn big grow" data-act="water" data-d="1">+1 glass</button>
      <button class="btn ghost" data-act="water" data-d="-1" aria-label="Remove a glass">−1</button></div></div>`;
}

function sipText() {
  if (!S.water.last_at) return 'No water logged yet. Start now.';
  const m = Math.floor((now() - Date.parse(S.water.last_at)) / 60000);
  if (m < 1) return 'Last glass just now.';
  return `Last glass ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`} ago.`;
}

function bossHTML() {
  const s = cfg(), lost = lostKg(), hp = Math.max(0, s.goal_loss - lost);
  return `<div class="panel boss">
    <div class="boss-head"><h2 class="slab">The ${s.goal_loss} kg boss</h2>${weighDue() ? '<span class="sticker small">Weigh-in due</span>' : ''}</div>
    <div class="hp" role="img" aria-label="${hp.toFixed(1)} of ${s.goal_loss} kg left"><div style="width:${(hp / s.goal_loss) * 100}%"></div></div>
    <p class="note">${lost > 0 ? `${lost.toFixed(1)} kg of damage dealt. ${hp.toFixed(1)} kg to the KO.` : 'No damage yet. Your weekly weigh-in is how you hit it.'}</p>
    <button class="btn" data-go="record">Log weight</button></div>`;
}

// ---------- Fuel ----------
function renderFuel() {
  const s = cfg(), k = kcalToday();
  const todays = S.meals.filter((m) => m.day === S.today), yest = S.meals.filter((m) => m.day !== S.today);
  $('#v-fuel').innerHTML = `
    <div class="panel yellow">
      <h1 class="slab">Fuel</h1>
      <p class="big-line">${num(k)} <span>of ${num(s.kcal_limit)} kcal</span></p>
      ${meterHTML(k, s.kcal_limit, s.kcal_floor)}
      <p class="note">Going over ${num(s.kcal_limit)} costs ${s.pen_kcal} points. Ending the day under ${num(s.kcal_floor)} gets flagged.</p>
    </div>
    <form class="panel" id="meal-form">
      <h2 class="slab">Add meal</h2>
      <label>Meal <input name="name" maxlength="60" required placeholder="Grilled chicken and rice"></label>
      <label>Calories <input name="kcal" type="number" inputmode="numeric" min="1" max="5000" required placeholder="550"></label>
      <label class="check"><input type="checkbox" name="yesterday"> Log it for yesterday</label>
      <button class="btn big">Add meal</button>
      ${S.recent.length ? `<p class="note">Eat the same thing again? Tap to add it:</p>
        <div class="chips">${S.recent.map((m, i) => `<button type="button" class="chip" data-act="quick" data-i="${i}">${esc(m.name)}<b>${m.kcal}</b></button>`).join('')}</div>` : ''}
    </form>
    <div class="panel">
      <h2 class="slab">Today</h2>
      ${todays.length ? mealList(todays) : '<p class="note">Nothing logged yet today. Add your first meal above.</p>'}
      ${yest.length ? `<h3>Yesterday</h3>${mealList(yest)}` : ''}
    </div>`;
}

const mealList = (ms) => `<ul class="meals">${ms.map((m) => `
  <li><span>${esc(m.name)}</span><b>${m.kcal}</b><small>${clock(m.at)}</small>
    <button class="x" data-act="delmeal" data-id="${m.id}" aria-label="Delete ${esc(m.name)}">×</button></li>`).join('')}</ul>`;

// ---------- Record ----------
function renderRecord() {
  const s = cfg(), [w, l] = record(), sel = selDay || S.today;
  const cells = S.days.map((d) => `<button class="cell ${d.state}${d.iron ? ' iron' : ''}${d.date === sel ? ' sel' : ''}"
      data-act="day" data-date="${d.date}" aria-label="Round ${d.n}: ${d.state}"><span>${d.n}</span>${d.state === 'won' ? '<i>W</i>' : d.state === 'lost' ? '<i>L</i>' : ''}</button>`).join('');
  $('#v-record').innerHTML = `
    <div class="panel yellow">
      <h1 class="slab">Record ${w}–${l}</h1>
      <p class="note">${S.points} points. Best streak ${S.best_streak}. A black bar marks the ${s.iron_days} Iron days, where a miss costs ${s.pen_miss_iron}.</p>
      <div class="cal">${cells}</div>
      <div id="day-detail">${dayDetail(sel)}</div>
    </div>
    <div class="panel">
      <h2 class="slab">Weight</h2>
      ${weightChart()}
      <form id="weight-form" class="row">
        <label class="grow">Today's weight (kg)<input name="kg" type="number" step="0.1" inputmode="decimal" min="30" max="300" required></label>
        <button class="btn">Log weight</button>
      </form>
      <p class="note">${weighDue() ? 'Weigh-in due. Same scale, in the morning, before you eat.' : `Next weigh-in in ${7 - daysBetween(S.weights.at(-1).day, S.today)} days.`}</p>
    </div>
    <div class="panel">
      <h2 class="slab">Badges</h2>
      <div class="badges">${badges().map(([t, d, ok]) => `<div class="badge${ok ? ' got' : ''}"><b>${esc(t)}</b><small>${esc(d)}</small></div>`).join('')}</div>
    </div>`;
}

function dayDetail(date) {
  const d = S.days.find((x) => x.date === date) || S.days[0];
  if (!d) return '';
  const label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (d.state === 'future') return `<p class="detail"><b>Round ${d.n}, ${label}.</b> Not fought yet.</p>`;
  const flags = [d.low && `Under the ${num(cfg().kcal_floor)} kcal floor`, d.unlogged && 'No meals logged'].filter(Boolean);
  return `<div class="detail"><b>Round ${d.n}, ${label}</b>
    <p>${d.log.length ? esc(d.log.join(', ')) : 'In progress'}. Total ${signed(d.pts)}.</p>
    <p>${num(d.kcal)} kcal, ${d.water} glasses of water.${flags.length ? ` ${flags.join('. ')}.` : ''}</p></div>`;
}

function weightChart() {
  const s = cfg(), W = 340, H = 190, L = 34, R = 10, T = 14, B = 22;
  const n = Math.max(2, s.days), start = s.start_kg, goal = +(s.start_kg - s.goal_loss).toFixed(1);
  const pts = S.weights.map((w) => ({ x: Math.max(0, daysBetween(s.start, w.day)), y: w.kg })).filter((p) => p.x < n);
  const ys = [start, goal, ...pts.map((p) => p.y)];
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const X = (i) => L + (W - L - R) * (i / (n - 1)), Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const path = [{ x: 0, y: start }, ...pts].map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
  const ticks = [...new Set([hi, Math.round((hi + lo) / 2), lo])];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight: start ${start} kg, now ${lastKg()} kg, goal ${goal} kg">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    <line class="target" x1="${X(0)}" y1="${Y(start)}" x2="${X(n - 1)}" y2="${Y(goal)}"/>
    <path class="actual" d="${path}"/>
    ${pts.map((p) => `<circle class="dot" cx="${X(p.x)}" cy="${Y(p.y)}" r="5"/>`).join('')}
    <text x="${L}" y="${H - 5}">Day 1</text><text x="${W - R}" y="${H - 5}" text-anchor="end">Day ${s.days}</text>
  </svg>
  <p class="legend"><i class="lg target"></i>Target pace to ${goal} kg <i class="lg actual"></i>Your weigh-ins</p>`;
}

function badges() {
  const s = cfg(), past = S.days.filter((d) => d.state === 'won' || d.state === 'lost');
  const iron = S.days.slice(0, s.iron_days);
  let run = 0, clean = false;
  for (const d of past) { if (d.kcal > 0 && d.kcal <= s.kcal_limit) { if (++run >= 7) clean = true; } else run = 0; }
  const hydrated = S.days.filter((d) => d.state !== 'future' && d.water >= s.water_goal).length;
  const lost = lostKg(), half = Math.ceil(s.days / 2);
  return [
    ['First bell', 'Win your first round', S.days.some((d) => d.state === 'won')],
    [`Iron ${s.iron_days}`, `Win all ${s.iron_days} Iron days`, iron.length > 0 && iron.every((d) => d.state === 'won')],
    ['On fire', '5-day streak', S.best_streak >= 5],
    ['Machine', '10-day streak', S.best_streak >= 10],
    ['Unbreakable', '30-day streak', S.best_streak >= 30],
    ['Clean week', '7 days in a row within calories', clean],
    ['Hydrated', 'Hit the water goal on 7 days', hydrated >= 7],
    ['Halfway', `Reach round ${half}`, S.day_n >= half],
    ['First blood', '5 kg down', lost >= 5],
    ['Heavy hitter', '10 kg down', lost >= 10],
    ['KO', `All ${s.goal_loss} kg down`, lost >= s.goal_loss],
    ['Final bell', `Finish all ${s.days} rounds`, S.day_n > s.days],
  ];
}

// ---------- Wall ----------
function renderWall() {
  const wall = S.wall.filter((p) => roundOf(p.day) >= 1), first = wall[0], last = wall.at(-1);
  $('#v-wall').innerHTML = `
    <div class="panel yellow">
      <h1 class="slab">Wall</h1>
      ${wall.length >= 2 ? `
        <div class="compare" style="--cut:50%">
          <img src="/api/photo/${last.id}" alt="Round ${roundOf(last.day)} gym photo">
          <img class="top" src="/api/photo/${first.id}" alt="Round ${roundOf(first.day)} gym photo">
          <span class="tag l">R${roundOf(first.day)}</span><span class="tag r">R${roundOf(last.day)}</span>
          <input type="range" min="0" max="100" value="50" data-act="cmp" aria-label="Slide to compare your first and latest photo">
        </div>
        <p class="note">Drag across the photo to compare round ${roundOf(first.day)} with round ${roundOf(last.day)}.</p>`
      : '<p class="note">Once you have two gym photos, your first and latest show here side by side.</p>'}
    </div>
    <div class="panel">
      <h2 class="slab">Gym photos</h2>
      ${wall.length ? `<div class="grid">${wall.slice().reverse().map((p) => `<figure><img loading="lazy" src="/api/photo/${p.id}" alt="Round ${roundOf(p.day)} gym photo">
        <figcaption>R${roundOf(p.day)}${p.status === 'unverified' ? ' ⚠' : ''}</figcaption></figure>`).join('')}</div>`
      : '<p class="note">No gym photos yet. Check in at the gym and take your first one.</p>'}
    </div>
    <div class="panel">
      <h2 class="slab">Gym reference photos</h2>
      <p class="note">Every daily photo is compared with these. Take 3 of the gym itself from different spots. Delete any test shots taken outside the gym.</p>
      ${S.refs.length ? `<div class="refs">${S.refs.map((id) => `<figure><img src="/api/photo/${id}" alt="Gym reference photo">
        <button class="x" data-act="delref" data-id="${id}" aria-label="Delete reference photo">×</button></figure>`).join('')}</div>` : ''}
      <div class="row"><button class="btn" data-act="refcam">Take reference photo</button>
        <label class="btn ghost">Upload one<input type="file" accept="image/*" data-act="refupload" hidden></label></div>
    </div>`;
}

// ---------- Setup ----------
function renderSetup() {
  const s = cfg();
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
  const field = (label, name, val, attrs = '') => `<label>${label}<input name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
  const n = (label, name, attrs = '') => field(label, name, s[name], `type="number" inputmode="decimal" ${attrs}`);
  $('#v-setup').innerHTML = `
    ${S.ready ? '' : `<div class="panel pink"><h1 class="slab">Set up your fight</h1>
      <p>Still needed: ${missing().join(', ')}. Save the form, then set your gym location below.</p></div>`}
    <form class="panel" id="settings-form">
      <h2 class="slab">You and the plan</h2>
      ${field('Your name', 'name', s.name, 'maxlength="16" autocomplete="given-name"')}
      <div class="two">
        ${field('Day 1', 'start', s.start || tomorrow, 'type="date" required')}
        ${n('Plan length (days)', 'days', 'min="7" max="365" step="1"')}
        ${n('Start weight (kg)', 'start_kg', 'min="30" max="300" step="0.1" required')}
        ${n('Goal: lose (kg)', 'goal_loss', 'min="1" max="100" step="0.5"')}
      </div>
      <h2 class="slab">Food</h2>
      <div class="two">
        ${n('Daily calorie limit', 'kcal_limit', 'min="800" max="6000" step="10" required')}
        ${n('Calorie floor', 'kcal_floor', 'min="0" max="4000" step="10"')}
      </div>
      <p class="note">Going over the limit costs ${s.pen_kcal} points. A day under the floor gets flagged, so the game never rewards under-eating.</p>
      <h2 class="slab">Water</h2>
      <div class="two">
        ${n('Glasses a day (250 ml)', 'water_goal', 'min="1" max="30" step="1"')}
        ${n('Remind every (min)', 'water_every_min', 'min="15" max="240" step="5"')}
      </div>
      <h2 class="slab">Gym rules</h2>
      <div class="two">
        ${n('Check-in radius (m)', 'radius_m', 'min="50" max="1000" step="10"')}
        ${n('Minimum session (min)', 'min_session_min', 'min="0" max="240" step="5"')}
      </div>
      <details>
        <summary>Points rules</summary>
        <div class="two">
          ${n('Gym day', 'pts_gym', 'min="0" step="1"')}
          ${n('Missed day', 'pen_miss', 'min="0" step="1"')}
          ${n('Missed Iron day', 'pen_miss_iron', 'min="0" step="1"')}
          ${n('Iron days', 'iron_days', 'min="0" step="1"')}
          ${n('Over calories', 'pen_kcal', 'min="0" step="1"')}
          ${n('Streak bonus', 'streak_bonus', 'min="0" step="1"')}
          ${n('Bonus every (days)', 'streak_every', 'min="1" step="1"')}
        </div>
        <p class="note">Enter penalties as positive numbers.</p>
      </details>
      <button class="btn big">${S.ready ? 'Save setup' : 'Save and start'}</button>
    </form>
    <div class="panel">
      <h2 class="slab">Gym location</h2>
      <p class="note">${s.gym ? `Saved: ${s.gym.lat.toFixed(5)}, ${s.gym.lng.toFixed(5)}.` : 'Not set. Stand inside your gym and tap the button, or paste coordinates from a maps app.'}</p>
      <div class="row">
        <button class="btn" data-act="gymhere">Use my current location</button>
        ${s.gym ? '<button class="btn ghost" data-act="testgps">Test my distance</button>' : ''}
      </div>
      <form id="gym-form" class="row paste">
        <label class="grow">Or paste coordinates<input name="coords" placeholder="24.7136, 46.6753" required></label>
        <button class="btn ghost">Save</button>
      </form>
    </div>
    <div class="panel">
      <h2 class="slab">Photo check</h2>
      <p class="note">${S.ai ? 'On. Each gym photo is compared with your reference photos by Claude.'
        : 'Off. Set ANTHROPIC_API_KEY on the server to turn it on. Until then photos are saved as unverified.'}</p>
      <button class="btn ghost" data-act="logout">Log out</button>
    </div>`;
}

// ---------- feedback ----------
let toastTimer;
function toast(msg, kind = '', ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function busy(msg) {
  $('#busy').hidden = !msg;
  if (msg) $('#busy p').textContent = msg;
}

async function withBusy(msg, fn) {
  busy(msg);
  try { return await fn(); } finally { busy(false); }
}

let audio;
function hit(big = false) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(big ? 196 : 392, t);
    o.frequency.exponentialRampToValueAtTime(big ? 784 : 587, t + 0.15);
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 0.5 : 0.25));
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.55);
  } catch { /* no sound is fine */ }
}

function celebrate(title, sub) {
  const ko = $('#ko');
  $('h2', ko).textContent = title;
  $('p', ko).textContent = sub || '';
  ko.hidden = false;
  ko.classList.remove('go');
  void ko.offsetWidth;
  ko.classList.add('go');
  window.confetti?.({ particleCount: 180, spread: 100, startVelocity: 45, origin: { y: 0.55 },
    colors: ['#ffe10a', '#ff2e9a', '#12e8a6', '#ffffff', '#1c35f5'], disableForReducedMotion: true });
  navigator.vibrate?.([40, 40, 160]);
  hit(true);
  setTimeout(() => (ko.hidden = true), 2400);
}

// ---------- location ----------
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no location access.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1
        ? 'Location is blocked. Allow location for this site in your browser settings.'
        : 'Couldn’t get your location. Try again near a window or the entrance.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

function haversine(a, b) {
  const r = (x) => (x * Math.PI) / 180, la1 = r(a.lat), la2 = r(b.lat);
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function checkIn() {
  const r = await withBusy('Finding you…', async () => api('/checkin', await locate()));
  hit();
  toast(`Checked in, ${fmtDist(r.dist)} from your gym. Go lift.`, 'good');
  await load();
}

async function checkOut() {
  const day = S.session?.day;
  await withBusy('Finding you…', async () => api('/checkout', await locate()));
  await load();
  const row = S.days.find((d) => d.date === day);
  if (row) celebrate(`Round ${row.n} won`, `${signed(row.pts)} points. Streak ${S.streak}.`);
  else celebrate('Practice won', 'Check-out works. See you on day 1.');
}

async function gymHere() {
  const g = await withBusy('Finding you…', locate), wasReady = S.ready;
  await api('/settings', { gym: { lat: g.lat, lng: g.lng } });
  await load();
  afterSave(wasReady, `Gym location saved (GPS accuracy ±${Math.round(g.acc)} m).`);
}

async function gymPaste(form) {
  const m = String(new FormData(form).get('coords')).match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error('Paste coordinates like 24.7136, 46.6753');
  const wasReady = S.ready;
  await api('/settings', { gym: { lat: +m[1], lng: +m[2] } });
  await load();
  afterSave(wasReady, 'Gym location saved.');
}

async function testDistance() {
  const g = await withBusy('Finding you…', locate), s = cfg(), d = haversine(s.gym, g);
  const ok = d - Math.min(g.acc, 100) <= s.radius_m;
  toast(`You're ${fmtDist(d)} from your gym (GPS ±${Math.round(g.acc)} m). ${ok ? 'Check-in would work here.' : `Check-in works within ${s.radius_m} m.`}`, ok ? 'good' : 'warn', 7000);
}

// ---------- camera ----------
async function openCam(mode) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('The camera needs HTTPS (or localhost) and a current browser.');
  cam.mode = mode;
  cam.facing = mode === 'ref' ? 'environment' : 'user';
  $('#cam-title').textContent = mode === 'ref' ? 'Reference photo: show the gym itself' : 'Gym photo: get the gym behind you';
  $('#cam').hidden = false;
  $('#toast').hidden = true;
  await startStream();
}

async function startStream() {
  stopStream();
  const v = $('#cam-video'), shutter = $('.shutter');
  v.srcObject = null;
  shutter.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: cam.facing, width: { ideal: 1280 }, height: { ideal: 1280 } } });
  } catch {
    closeCam();
    throw new Error('The camera is blocked. Allow camera access for this site and try again.');
  }
  if ($('#cam').hidden) { stream.getTracks().forEach((t) => t.stop()); return; } // closed while starting
  cam.stream = stream;
  v.srcObject = stream;
  v.classList.toggle('mirror', cam.facing === 'user');
  await v.play().catch(() => {});
  shutter.disabled = false;
}

function stopStream() {
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
}

function closeCam() {
  stopStream();
  $('#cam').hidden = true;
}

async function snap() {
  const v = $('#cam-video');
  if (!cam.stream || !v.videoWidth) return;
  const k = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0, c.width, c.height);
  if (cam.mode === 'daily') stamp(ctx, c.width, c.height);
  const mode = cam.mode, data = c.toDataURL('image/jpeg', 0.82);
  closeCam();
  await sendPhoto(mode, data);
}

function stamp(ctx, w, h) {
  const bar = Math.max(28, Math.round(h * 0.07)), label = S.day_n >= 1 ? `R${pad2(S.day_n)}` : 'PRACTICE';
  ctx.font = `${Math.round(bar * 0.55)}px "Alfa Slab One", Georgia, serif`;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width + bar * 0.8, t = now();
  ctx.fillStyle = '#ffe10a';
  ctx.fillRect(0, h - bar, w, bar);
  ctx.fillStyle = '#ff2e9a';
  ctx.fillRect(0, h - bar, tw, bar);
  ctx.fillStyle = '#000';
  ctx.fillText(label, bar * 0.4, h - bar / 2);
  ctx.fillText(`${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}  ${clock(t)}`, tw + bar * 0.4, h - bar / 2);
}

function fileToJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image this browser can read.')); };
    img.src = url;
  });
}

async function sendPhoto(kind, data) {
  const r = await withBusy(kind === 'ref' ? 'Saving reference photo…' : 'Checking it against your gym…',
    () => api('/photo', { kind, data }));
  await load();
  if (kind === 'ref') {
    toast(S.refs.length < 3 ? `Reference saved (${S.refs.length} of 3). Take the next one from a different spot.`
      : 'Reference saved. Now take your gym photo.', 'good', 5000);
  } else if (r.status === 'pass') {
    hit();
    toast(`Photo verified (${r.confidence}% sure). Finish the session, then check out.`, 'good', 5000);
  } else if (r.status === 'unverified') {
    toast(`Photo saved without the AI check: ${r.reason}.`, 'warn', 7000);
  } else {
    toast(`Photo rejected: ${r.reason}. Retake with more of the gym in frame.`, 'bad', 7000);
  }
}

// ---------- water, timers ----------
async function water(delta) {
  await api('/water', { delta });
  if (delta > 0) { waterNagged = false; hit(); }
  await load();
  if (delta > 0 && S.water.glasses === cfg().water_goal) toast('Water goal hit for today.', 'good');
}

function nagWater() {
  if (!S?.ready || S.day_n < 1) return; // no nagging before day 1
  const s = cfg(), sip = $('#sip');
  if (sip) sip.textContent = sipText();
  const mins = S.water.last_at ? (now() - Date.parse(S.water.last_at)) / 60000 : Infinity, hour = new Date().getHours();
  if (!waterNagged && mins >= s.water_every_min && hour >= 8 && hour < 23 && S.water.glasses < s.water_goal) {
    waterNagged = true;
    toast('Water break. Drink a glass, then tap +1.', 'warn', 7000);
    navigator.vibrate?.(250);
  }
}

function tick() {
  const t = $('#timer');
  if (t) {
    const sec = Math.max(0, Math.floor((now() - Date.parse(t.dataset.in)) / 1000));
    t.textContent = `${Math.floor(sec / 3600)}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(sec % 60)}`;
  }
  const o = $('#opens');
  if (o) {
    const left = Math.ceil(cfg().min_session_min * 60 - (now() - Date.parse(o.dataset.in)) / 1000);
    if (left <= 0) render();
    else o.textContent = `${Math.floor(left / 60)}:${pad2(left % 60)}`;
  }
}

// ---------- settings ----------
async function saveSettings(form) {
  const body = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  for (const el of form.elements) {
    if (el.name && el.value !== '') body[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  }
  const wasReady = S.ready;
  await api('/settings', body);
  await load();
  afterSave(wasReady, 'Setup saved.');
}

function afterSave(wasReady, msg) {
  if (!wasReady && S.ready) {
    view = 'today';
    render();
    scrollTo(0, 0);
    const day1 = new Date(`${cfg().start}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    celebrate('Fight booked', `Round 1 is ${day1}.`);
  } else {
    toast(S.ready ? msg : `${msg} Still needed: ${missing().join(', ')}.`, S.ready ? 'good' : 'warn', 6000);
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  const go = e.target.closest('[data-go]');
  if (tab || go) {
    view = (tab || go).dataset.view || go.dataset.go;
    selDay = null;
    render();
    scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('button[data-act]');
  if (!el) return;
  try {
    switch (el.dataset.act) {
      case 'checkin': await checkIn(); break;
      case 'checkout': await checkOut(); break;
      case 'cam': await openCam('daily'); break;
      case 'refcam': await openCam('ref'); break;
      case 'snap': await snap(); break;
      case 'flip': cam.facing = cam.facing === 'user' ? 'environment' : 'user'; await startStream(); break;
      case 'camclose': closeCam(); break;
      case 'water': await water(Number(el.dataset.d)); break;
      case 'quick': {
        const m = S.recent[el.dataset.i];
        await api('/meal', { name: m.name, kcal: m.kcal });
        await load();
        toast(`Added ${m.name}, ${m.kcal} kcal.`, 'good');
        break;
      }
      case 'delmeal': await api(`/meal/${el.dataset.id}`, null, 'DELETE'); await load(); break;
      case 'delref':
        if (confirm('Delete this reference photo?')) { await api(`/photo/${el.dataset.id}`, null, 'DELETE'); await load(); }
        break;
      case 'day': selDay = el.dataset.date; renderRecord(); break;
      case 'gymhere': await gymHere(); break;
      case 'testgps': await testDistance(); break;
      case 'logout': await api('/logout', {}); showLogin(); break;
    }
  } catch (err) {
    if (err.message !== 'Log in first.') toast(err.message, 'bad', 7000);
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, fd = new FormData(f);
  try {
    if (f.id === 'login-form') {
      await api('/login', { password: fd.get('password') });
      f.reset();
      await load();
    } else if (f.id === 'meal-form') {
      await api('/meal', { name: fd.get('name'), kcal: Number(fd.get('kcal')), yesterday: fd.get('yesterday') === 'on' });
      await load();
      toast('Meal added.', 'good');
    } else if (f.id === 'weight-form') {
      await api('/weight', { kg: Number(fd.get('kg')) });
      await load();
      const d = lostKg();
      toast(d > 0 ? `Logged. ${d.toFixed(1)} kg of damage dealt so far.` : 'Weight logged.', 'good', 5000);
    } else if (f.id === 'settings-form') {
      await saveSettings(f);
    } else if (f.id === 'gym-form') {
      await gymPaste(f);
    }
  } catch (err) {
    if (err.message !== 'Log in first.') toast(err.message, 'bad', 7000);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.dataset.act === 'cmp') e.target.closest('.compare').style.setProperty('--cut', `${e.target.value}%`);
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'refupload' || !e.target.files[0]) return;
  try { await sendPhoto('ref', await fileToJpeg(e.target.files[0])); } catch (err) { toast(err.message, 'bad', 7000); }
  e.target.value = '';
});

document.addEventListener('visibilitychange', () => { if (!document.hidden && S) load().catch(() => {}); });
window.addEventListener('pagehide', stopStream);
setInterval(tick, 1000);
setInterval(nagWater, 30000);

load().catch((err) => { if (err.message !== 'Log in first.') toast(err.message, 'bad', 8000); });
