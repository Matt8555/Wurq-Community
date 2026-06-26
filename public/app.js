'use strict';

// Wurq Community — Profile, WOD log, live box leaderboards, box-vs-box, and feed.
// user_id is the real key (cached in localStorage); email creates/matches it.
// The Holistic Score is computed SERVER-SIDE — the browser only submits raw
// inputs and renders whatever the API returns. No faked/seed data on the client.

const STORAGE_KEY = 'wurq_user_id';
const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'RX', 'competitor'];

const content = document.getElementById('content');
const toastEl = document.getElementById('toast');
const screenNameEl = document.querySelector('.screen-name');
const navEl = document.querySelector('.nav');

let userId = localStorage.getItem(STORAGE_KEY);
let profile = null;
let currentView = 'profile';     // 'profile' | 'log' | 'leaderboard' | 'feed'
let todayWorkout = null;
let lbTab = 'box';               // 'box' | 'boxes'
let pendingAvatarUrl = null;

// ---- helpers ----------------------------------------------------------------
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
function labelFor(lvl) { return lvl === 'RX' ? 'RX' : lvl.charAt(0).toUpperCase() + lvl.slice(1); }
function escapeHtml(v) {
  return (v == null ? '' : String(v)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(v) { return escapeHtml(v).replace(/"/g, '&quot;'); }

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function parseTime(str) {
  const v = String(str).trim();
  if (!v) return NaN;
  if (v.includes(':')) {
    const [m, s] = v.split(':');
    const mins = Number(m), secs = Number(s);
    if (!Number.isInteger(mins) || !Number.isInteger(secs) || secs < 0 || secs > 59) return NaN;
    return mins * 60 + secs;
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}
function fmtDate(d) {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function avatarHtml(url, name, cls) {
  return url
    ? `<div class="${cls}"><img src="${escapeAttr(url)}" alt="" style="width:100%;height:100%;object-fit:cover" /></div>`
    : `<div class="${cls}">${escapeHtml(initials(name))}</div>`;
}
function num(v) { return Number(v); }

// ---- routing ----------------------------------------------------------------
function setScreenName(name) { screenNameEl.textContent = name; }

function setView(view) {
  if (view !== 'profile' && !userId) { showToast('Set up your profile first'); view = 'profile'; }
  currentView = view;
  navEl.querySelectorAll('a[data-view]').forEach((a) =>
    a.classList.toggle('active', a.dataset.view === view));
  render();
}

function render() {
  if (currentView === 'profile') return renderProfile();
  if (currentView === 'log') return renderLog();
  if (currentView === 'leaderboard') return renderLeaderboard();
  if (currentView === 'feed') return renderFeed();
}

navEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a) return;
  e.preventDefault();
  setView(a.dataset.view);
});

// Prompt shown when a box-scoped screen needs a gym that isn't set yet.
function needBoxPrompt(msg) {
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <div class="empty">${msg}</div>
      <button class="btn-primary" id="goProfile">Set your gym / box</button>
    </div>
  `));
  content.querySelector('#goProfile').addEventListener('click', () => setView('profile'));
}

// ---- profile ----------------------------------------------------------------
function renderProfile() {
  setScreenName('Profile');
  if (!userId) return renderEmailGate();
  if (!profile) { content.innerHTML = '<p class="subtitle">Loading…</p>'; return loadProfile(); }
  renderProfileForm();
}

function renderEmailGate() {
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">Join the community</h1>
      <p class="subtitle">Enter your email to set up your athlete profile. We use it to match your account across Wurq.</p>
      <div class="card">
        <label class="field"><span class="lbl">Email</span>
          <input type="email" id="email" placeholder="you@example.com" autocomplete="email" /></label>
        <button class="btn-primary" id="continue">Continue</button>
        <div class="error" id="err"></div>
      </div>
    </div>
  `));
  const emailInput = content.querySelector('#email');
  const btn = content.querySelector('#continue');
  const err = content.querySelector('#err');
  async function submit() {
    err.textContent = '';
    const email = emailInput.value.trim();
    if (!email) { err.textContent = 'Please enter your email.'; return; }
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const { user_id } = await api('POST', '/api/users', { email });
      userId = user_id;
      localStorage.setItem(STORAGE_KEY, userId);
      profile = await api('GET', `/api/profile/${userId}`);
      renderProfileForm();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Continue';
    }
  }
  btn.addEventListener('click', submit);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function renderProfileForm() {
  setScreenName('Profile');
  pendingAvatarUrl = null;
  const onboarding = !profile.profile_complete;
  const avatar = profile.avatar_url;

  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">${onboarding ? 'Set up your profile' : 'Profile settings'}</h1>
      <p class="subtitle">${onboarding
        ? 'Tell the community who you are. You can change any of this later.'
        : 'Update your details and save.'}</p>

      <div class="card">
        <div class="avatar-row">
          <div class="avatar ${avatar ? 'has-img' : ''}" id="avatar">
            ${avatar ? `<img src="${avatar}" alt="avatar" style="width:100%;height:100%;object-fit:cover" />` : initials(profile.display_name)}
          </div>
          <div class="avatar-actions">
            <label class="upload-btn" for="avatarInput">Upload photo</label>
            <input type="file" id="avatarInput" accept="image/*" />
            <span class="hint" id="avatarHint">PNG, JPG, GIF or WEBP · up to 5 MB</span>
          </div>
        </div>

        <label class="field field-gym"><span class="lbl">Your gym / box ★</span>
          <input type="text" id="gym_name" placeholder="e.g. CrossFit Pegacorn" value="${escapeAttr(profile.gym_name)}" /></label>

        <label class="field"><span class="lbl">Display name</span>
          <input type="text" id="display_name" placeholder="How you show up on the leaderboard" value="${escapeAttr(profile.display_name)}" /></label>

        <label class="field"><span class="lbl">Experience level</span>
          <select id="experience_level">
            <option value="">Select…</option>
            ${EXPERIENCE_LEVELS.map((lvl) =>
              `<option value="${lvl}" ${profile.experience_level === lvl ? 'selected' : ''}>${labelFor(lvl)}</option>`).join('')}
          </select></label>

        <label class="field"><span class="lbl">Primary goals</span>
          <input type="text" id="primary_goals" placeholder="e.g. First muscle-up, sub-3 Fran" value="${escapeAttr(profile.primary_goals)}" /></label>

        <label class="field"><span class="lbl">Bio</span>
          <textarea id="bio" placeholder="A line or two about you (optional)">${escapeHtml(profile.bio)}</textarea></label>

        <label class="field"><span class="lbl">Units</span></label>
        <div class="toggle" id="units">
          <button type="button" data-units="lb">LB</button>
          <button type="button" data-units="kg">KG</button>
        </div>

        <button class="btn-primary" id="save">${onboarding ? 'Create profile' : 'Save changes'}</button>
        <div class="error" id="err"></div>
      </div>

      <div class="center"><button class="link" id="reset">Not you? Start over</button></div>
    </div>
  `));

  let units = profile.units === 'kg' ? 'kg' : 'lb';
  const unitsEl = content.querySelector('#units');
  const paintUnits = () => unitsEl.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.units === units));
  unitsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; units = b.dataset.units; paintUnits();
  });
  paintUnits();

  const avatarInput = content.querySelector('#avatarInput');
  const avatarBox = content.querySelector('#avatar');
  const avatarHint = content.querySelector('#avatarHint');
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      avatarBox.innerHTML = `<img src="${reader.result}" alt="avatar" style="width:100%;height:100%;object-fit:cover" />`;
      avatarBox.classList.add('has-img');
    };
    reader.readAsDataURL(file);
    avatarHint.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      const res = await fetch(`/api/profile/${userId}/avatar`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      pendingAvatarUrl = data.avatar_url;
      avatarHint.textContent = 'Photo ready · save to confirm';
    } catch (e) { avatarHint.textContent = e.message; }
  });

  const btn = content.querySelector('#save');
  const err = content.querySelector('#err');
  btn.addEventListener('click', async () => {
    err.textContent = '';
    const payload = {
      display_name: content.querySelector('#display_name').value.trim(),
      gym_name: content.querySelector('#gym_name').value.trim(),
      experience_level: content.querySelector('#experience_level').value,
      primary_goals: content.querySelector('#primary_goals').value.trim(),
      bio: content.querySelector('#bio').value.trim(),
      units,
    };
    if (pendingAvatarUrl) payload.avatar_url = pendingAvatarUrl;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      profile = await api('PUT', `/api/profile/${userId}`, payload);
      showToast('Saved ✓');
      renderProfileForm();
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = onboarding ? 'Create profile' : 'Save changes';
    }
  });

  content.querySelector('#reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    userId = null; profile = null;
    setView('profile');
  });
}

// ---- WOD log ----------------------------------------------------------------
async function ensureWorkout() {
  if (!todayWorkout) todayWorkout = await api('GET', '/api/wod/today');
  return todayWorkout;
}

async function renderLog() {
  setScreenName("Today's WOD");
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w;
  try { w = await ensureWorkout(); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">Log your WOD</h1>
      <p class="subtitle">Enter your numbers — your Holistic Score is calculated for you.</p>

      <div class="card">
        <div class="wod-head">
          <h2 class="wod-name">${escapeHtml(w.name)}</h2>
          ${w.type ? `<span class="type-badge">${escapeHtml(w.type)}</span>` : ''}
        </div>
        <div class="wod-date">${fmtDate(w.wod_date)}</div>
        <p class="wod-desc">${escapeHtml(w.description)}</p>
      </div>

      <div class="card">
        <label class="field"><span class="lbl">Your time (mm:ss)</span>
          <input type="text" id="time" inputmode="numeric" placeholder="3:45" /></label>

        <label class="field"><span class="lbl">Range of motion</span></label>
        <div class="range-row">
          <input type="range" id="rom" min="0" max="100" value="100" />
          <span class="range-val" id="romVal">100%</span>
        </div>

        <label class="field"><span class="lbl">Unbroken sets</span>
          <input type="text" id="sets" inputmode="numeric" placeholder="e.g. 6" value="0" /></label>

        <button class="btn-primary" id="log">Log result</button>
        <div class="error" id="err"></div>
      </div>
    </div>
  `));

  const rom = content.querySelector('#rom');
  const romVal = content.querySelector('#romVal');
  rom.addEventListener('input', () => { romVal.textContent = `${rom.value}%`; });

  const btn = content.querySelector('#log');
  const err = content.querySelector('#err');
  btn.addEventListener('click', async () => {
    err.textContent = '';
    const time_seconds = parseTime(content.querySelector('#time').value);
    const unbroken_sets = Number(content.querySelector('#sets').value);
    const rom_pct = Number(rom.value);
    if (!Number.isFinite(time_seconds) || time_seconds <= 0) {
      err.textContent = 'Enter a valid time as mm:ss (e.g. 3:45).'; return;
    }
    if (!Number.isInteger(unbroken_sets) || unbroken_sets < 0) {
      err.textContent = 'Unbroken sets must be a whole number.'; return;
    }
    btn.disabled = true; btn.textContent = 'Logging…';
    try {
      // Server computes the score; we only send raw inputs.
      const resp = await api('POST', '/api/results', {
        userId, workoutId: w.workout_id, time_seconds, rom_pct, unbroken_sets,
      });
      showToast('Logged ✓');
      renderLogged(resp.result, w, resp.newBadges || []);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Log result';
    }
  });
}

function countUp(node, target) {
  const dur = 600, start = performance.now();
  function step(t) {
    const p = Math.min(1, (t - start) / dur);
    node.textContent = (target * p).toFixed(1).replace(/\.0$/, '');
    if (p < 1) requestAnimationFrame(step); else node.textContent = String(target);
  }
  requestAnimationFrame(step);
}

function renderLogged(saved, w, newBadges) {
  const score = Number(saved.holistic_score);
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">Nice work!</h1>
      <p class="subtitle">${escapeHtml(w.name)} · ${fmtTime(saved.time_seconds)} · ${Math.round(saved.rom_pct)}% ROM</p>
      <div class="card score-reveal">
        <div class="num" id="scoreNum">0</div>
        <div class="cap">Holistic Score</div>
      </div>
      ${newBadges.map((b) => `
        <div class="badge-unlock">
          <div class="bu-title">🏅 Badge unlocked</div>
          <div class="bu-name">${escapeHtml(b.name)}</div>
          <div class="bu-desc">${escapeHtml(b.description || '')}</div>
        </div>`).join('')}
      <button class="btn-primary" id="toLb">View leaderboard</button>
      <div class="center" style="margin-top:14px"><button class="link" id="again">Edit my result</button></div>
    </div>
  `));
  countUp(content.querySelector('#scoreNum'), score);
  content.querySelector('#toLb').addEventListener('click', () => { lbTab = 'box'; setView('leaderboard'); });
  content.querySelector('#again').addEventListener('click', () => renderLog());
}

// ---- Leaderboard (My Box + Box vs Box) --------------------------------------
async function renderLeaderboard() {
  setScreenName('Leaderboard');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w;
  try { w = await ensureWorkout(); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  const head = el(`
    <div>
      <h1 class="title">${escapeHtml(w.name)} leaderboard</h1>
      <p class="subtitle">${fmtDate(w.wod_date)} · ranked by Holistic Score</p>
      <div class="tabs" id="tabs">
        <button data-tab="box">My Box</button>
        <button data-tab="boxes">Box vs Box</button>
      </div>
      <div id="lbBody"></div>
    </div>
  `);
  content.appendChild(head);
  const tabsEl = head.querySelector('#tabs');
  tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === lbTab));
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    lbTab = b.dataset.tab; renderLeaderboard();
  });

  const body = head.querySelector('#lbBody');
  if (lbTab === 'box') return renderMyBox(body, w);
  return renderBoxVsBox(body, w);
}

async function renderMyBox(body, w) {
  if (!profile || !profile.box_id) {
    body.innerHTML = `<div class="empty">Set your gym / box on your profile to see your box leaderboard.</div>`;
    return;
  }
  body.innerHTML = '<p class="subtitle">Loading…</p>';
  let data;
  try { data = await api('GET', `/api/leaderboard/box/${profile.box_id}/${w.workout_id}`); }
  catch (e) { body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const rows = data.results || [];
  body.innerHTML = '';
  body.appendChild(el(`<p class="subtitle" style="margin-top:-4px">${escapeHtml(data.box.name)}</p>`));
  if (!rows.length) {
    body.appendChild(el(`
      <div class="empty">No one from <strong>${escapeHtml(data.box.name)}</strong> has logged ${escapeHtml(w.name)} yet.<br/>Be the first.</div>
      <button class="btn-primary" id="goLog">Log ${escapeHtml(w.name)}</button>
    `));
    body.querySelector('#goLog').addEventListener('click', () => setView('log'));
    return;
  }
  rows.forEach((r, i) => {
    const me = r.user_id === userId;
    body.appendChild(el(`
      <div class="lb-row ${me ? 'me' : ''}">
        <div class="lb-rank">${i + 1}</div>
        <div class="lb-main">
          <div class="lb-name">${escapeHtml(r.display_name)}${me ? ' · you' : ''}</div>
          <div class="lb-sub">${Math.round(r.rom_pct)}% ROM · ${r.unbroken_sets} unbroken</div>
        </div>
        <div class="lb-score"><div class="s">${num(r.holistic_score)}</div><div class="t">${fmtTime(r.time_seconds)}</div></div>
      </div>
    `));
  });
}

async function renderBoxVsBox(body, w) {
  body.innerHTML = '<p class="subtitle">Loading…</p>';
  let data;
  try { data = await api('GET', `/api/leaderboard/boxes/${w.workout_id}`); }
  catch (e) { body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const boxes = data.boxes || [];
  body.innerHTML = '';
  if (!boxes.length) { body.appendChild(el(`<div class="empty">No boxes yet.</div>`)); return; }

  boxes.forEach((b, i) => {
    const mine = profile && b.box_id === profile.box_id;
    const pct = Math.round(b.participation * 100);
    body.appendChild(el(`
      <div class="box-row ${mine ? 'mine' : ''}">
        <div class="box-rank">${i + 1}</div>
        <div class="box-main">
          <div class="box-name">${escapeHtml(b.name)}${mine ? ' · your box' : ''}</div>
          <div class="box-breakdown"><b>${b.avg_score}</b> avg × <b>${pct}%</b> turnout · ${b.logged_members}/${b.total_members} logged</div>
        </div>
        <div class="box-score">${b.score}</div>
      </div>
    `));
  });
}

// ---- Feed -------------------------------------------------------------------
function feedText(ev) {
  const name = `<b>${escapeHtml(ev.display_name)}</b>`;
  const p = ev.payload || {};
  if (ev.type === 'result_logged') {
    return `${name} logged <b>${escapeHtml(p.workout_name || 'a workout')}</b> — <span class="accent">${num(p.holistic_score)}</span>`;
  }
  if (ev.type === 'badge_earned') {
    return `${name} earned the <span class="accent">${escapeHtml(p.name || 'a')}</span> badge <span class="feed-badge">🏅</span>`;
  }
  return `${name} did something`;
}

async function renderFeed() {
  setScreenName('Feed');
  if (!profile || !profile.box_id) {
    return needBoxPrompt('Set your gym / box on your profile to see your box feed.');
  }
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let data;
  try { data = await api('GET', `/api/feed/box/${profile.box_id}`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const events = data.events || [];
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">${escapeHtml(data.box.name)} feed</h1>
      <p class="subtitle">What your box is up to</p>
      <div id="feed"></div>
    </div>
  `);
  content.appendChild(wrap);
  const list = wrap.querySelector('#feed');

  if (!events.length) {
    list.appendChild(el(`<div class="empty">No activity yet. Log today's WOD to kick things off.</div>`));
    return;
  }

  events.forEach((ev) => {
    const item = el(`
      <div class="feed-item">
        ${avatarHtml(ev.avatar_url, ev.display_name, 'feed-av')}
        <div class="feed-body">
          <div class="feed-text">${feedText(ev)}</div>
          <div class="feed-meta">
            <span class="feed-time">${timeAgo(ev.created_at)}</span>
            <button class="kudos" data-id="${escapeAttr(ev.event_id)}">👏 <span class="kudos-n">${ev.kudos}</span></button>
          </div>
        </div>
      </div>
    `);
    const btn = item.querySelector('.kudos');
    btn.addEventListener('click', async () => {
      try {
        const r = await api('POST', `/api/feed/${ev.event_id}/kudos`);
        item.querySelector('.kudos-n').textContent = r.kudos;
        btn.classList.add('kudosed');
      } catch (e) { showToast(e.message); }
    });
    list.appendChild(item);
  });
}

// ---- bootstrap --------------------------------------------------------------
async function loadProfile() {
  try {
    profile = await api('GET', `/api/profile/${userId}`);
    render();
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
    userId = null; profile = null;
    renderEmailGate();
  }
}

if (userId) loadProfile(); else renderEmailGate();
