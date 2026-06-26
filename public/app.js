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
let currentView = 'profile';     // 'profile' | 'log' | 'leaderboard' | 'community' | 'feed'
let todayWorkout = null;
let lbTab = 'box';               // 'box' | 'boxes'
let communitySpace = 'all';      // selected Circle space (mock)
const likedPosts = new Set();    // client-only like state for the Circle mock
let pendingAvatarUrl = null;

// Role (athlete vs gym owner). For the demo, the owner owns OWNER_BOX_NAME.
const OWNER_BOX_NAME = 'CrossFit Borderland';
let role = localStorage.getItem('wurq_role') === 'owner' ? 'owner' : 'athlete';
let ownerView = 'home';          // 'home' | 'compete' | 'throwdown' | 'engage'
let ownerBox = null;             // resolved {box_id, name, location}
const roleToggleEl = document.getElementById('roleToggle');

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

// ---- routing (role-aware) ---------------------------------------------------
function setScreenName(name) { if (screenNameEl) screenNameEl.textContent = name; }

const NAV_ATHLETE = [
  ['log', '▦', 'WOD'], ['leaderboard', '≡', 'Board'],
  ['community', '❖', 'Community'], ['feed', '✦', 'Feed'], ['profile', '◉', 'Profile'],
];
const NAV_OWNER = [
  ['home', '◧', 'Home'], ['compete', '≡', 'Compete'],
  ['throwdown', '⚔', 'Throwdown'], ['engage', '✦', 'Engage'],
];

function renderNav() {
  const items = role === 'owner' ? NAV_OWNER : NAV_ATHLETE;
  const active = role === 'owner' ? ownerView : currentView;
  navEl.innerHTML = items.map(([v, ic, lbl]) =>
    `<a href="#" data-view="${v}" class="${v === active ? 'active' : ''}"><span class="ico">${ic}</span>${lbl}</a>`).join('');
}

function updateRoleToggle() {
  if (!roleToggleEl) return;
  roleToggleEl.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.role === role));
}

// Render the current screen for the current role.
function go() {
  renderNav();
  updateRoleToggle();
  if (role === 'owner') return renderOwner();
  return render();
}

function setView(view) {
  if (view !== 'profile' && !userId) { showToast('Set up your profile first'); view = 'profile'; }
  currentView = view;
  go();
}

function setOwnerView(view) { ownerView = view; go(); }

function setRole(r) {
  role = r === 'owner' ? 'owner' : 'athlete';
  localStorage.setItem('wurq_role', role);
  if (role === 'owner') ownerView = 'home';
  else currentView = profile && profile.profile_complete ? 'log' : 'profile';
  go();
}

function render() {
  if (currentView === 'profile') return renderProfile();
  if (currentView === 'log') return renderLog();
  if (currentView === 'leaderboard') return renderLeaderboard();
  if (currentView === 'community') return renderCommunity();
  if (currentView === 'feed') return renderFeed();
}

navEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a) return;
  e.preventDefault();
  if (role === 'owner') setOwnerView(a.dataset.view); else setView(a.dataset.view);
});

if (roleToggleEl) {
  roleToggleEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-role]');
    if (b) setRole(b.dataset.role);
  });
}

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
  if (!profile.profile_complete) return renderProfileForm(); // onboarding
  return renderRichProfile();
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
      ${onboarding ? '' : '<button class="back-link" id="backToProfile">← Back to profile</button>'}
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
          <input type="text" id="gym_name" list="boxOptions" placeholder="e.g. CrossFit Borderland" value="${escapeAttr(profile.gym_name)}" autocomplete="off" />
          <datalist id="boxOptions"></datalist>
          <span class="hint" id="gymHint">Pick an existing box to join the community — or type a new one.</span></label>

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

  // Suggest existing boxes so athletes join a populated community, not a solo box.
  (async () => {
    try {
      const { boxes } = await api('GET', '/api/boxes');
      const dl = content.querySelector('#boxOptions');
      if (dl) dl.innerHTML = boxes
        .sort((a, b) => (b.member_count || 0) - (a.member_count || 0))
        .map((b) => `<option value="${escapeAttr(b.name)}">${escapeHtml(b.location || '')}</option>`).join('');
    } catch (_) { /* suggestions are best-effort */ }
  })();

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
      renderProfile(); // -> rich profile once complete
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = onboarding ? 'Create profile' : 'Save changes';
    }
  });

  const back = content.querySelector('#backToProfile');
  if (back) back.addEventListener('click', () => renderRichProfile());

  content.querySelector('#reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    userId = null; profile = null;
    setView('profile');
  });
}

// ---- Rich athlete profile ---------------------------------------------------
function svgLineChart(series, h = 96) {
  if (!series || series.length < 2) return '<div class="muted-note">Not enough sessions yet.</div>';
  const w = 320, ys = series.map((p) => p.score);
  const lo = Math.max(0, Math.floor(Math.min(...ys) - 3)), hi = Math.min(100, Math.ceil(Math.max(...ys) + 3));
  const range = Math.max(1, hi - lo);
  const px = (i) => (i / (series.length - 1)) * (w - 8) + 4;
  const py = (v) => h - 8 - ((v - lo) / range) * (h - 18);
  const pts = series.map((p, i) => `${px(i).toFixed(1)},${py(p.score).toFixed(1)}`).join(' ');
  const last = series[series.length - 1];
  return `<svg class="linechart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <polygon points="4,${h - 8} ${pts} ${w - 4},${h - 8}" fill="rgba(198,255,0,0.12)"/>
    <polyline points="${pts}" fill="none" stroke="var(--acid)" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="${px(series.length - 1).toFixed(1)}" cy="${py(last.score).toFixed(1)}" r="3.5" fill="var(--acid)"/>
  </svg>`;
}
function heatmapHtml(cells) {
  return `<div class="heat">${cells.map((c) => {
    const on = c.score > 0;
    const a = on ? (0.2 + 0.8 * Math.min(1, Math.max(0, (c.score - 60) / 40))) : 0;
    const bg = on ? `rgba(198,255,0,${a.toFixed(2)})` : 'var(--surface-2)';
    return `<span class="heat-cell" style="background:${bg}" title="${c.date}${on ? ' · ' + c.score : ' · rest'}"></span>`;
  }).join('')}</div>`;
}
function barsHtml(items) {
  if (!items.length) return '<div class="muted-note">No workload data yet.</div>';
  const max = Math.max(...items.map((i) => i.reps), 1);
  return items.map((i) => `<div class="wl-row"><div class="wl-lab">${escapeHtml(i.category)}</div>
    <div class="wl-bar"><span style="width:${Math.round(100 * i.reps / max)}%"></span></div>
    <div class="wl-val">${i.pct}%</div></div>`).join('');
}
function sparkTimes(history) {
  const w = 96, h = 30, ts = history.map((x) => x.time);
  const min = Math.min(...ts), max = Math.max(...ts), range = Math.max(1, max - min);
  const px = (i) => (i / (history.length - 1)) * (w - 4) + 2;
  const py = (v) => 3 + ((v - min) / range) * (h - 6); // lower time -> higher on chart
  const pts = history.map((x, i) => `${px(i).toFixed(1)},${py(x.time).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="var(--acid)" stroke-width="2"/></svg>`;
}

async function renderRichProfile() {
  setScreenName('Profile');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d, sessions;
  try {
    [d, sessions] = await Promise.all([
      api('GET', `/api/athlete/${userId}/profile`),
      api('GET', `/api/athlete/${userId}/history`).then((r) => r.sessions),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const u = d.user, s = d.summary, prs = d.prs, cmp = d.comparison;
  const avatar = u.avatar_url;
  const header = `
    <div class="prof-head">
      <div class="avatar ${avatar ? 'has-img' : ''}" style="width:64px;height:64px">
        ${avatar ? `<img src="${escapeAttr(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover"/>` : initials(u.display_name)}
      </div>
      <div class="prof-id">
        <div class="prof-name">${escapeHtml(u.display_name || 'Athlete')}</div>
        <div class="prof-sub">${escapeHtml(u.gym_name || 'No box')}${u.experience_level ? ' · ' + labelFor(u.experience_level) : ''}</div>
      </div>
      <button class="edit-btn" id="editProfile">Edit</button>
    </div>`;

  if (!s.sessions_total) {
    content.innerHTML = '';
    content.appendChild(el(`<div>${header}
      <div class="empty">No training history yet.<br/>Log today's WOD to start building your record.</div>
      <button class="btn-primary" id="goLog">Log today's WOD</button></div>`));
    content.querySelector('#editProfile').addEventListener('click', () => renderProfileForm());
    content.querySelector('#goLog').addEventListener('click', () => setView('log'));
    return;
  }

  const delta = (s.this_week_avg != null && s.last_week_avg != null) ? Math.round((s.this_week_avg - s.last_week_avg) * 10) / 10 : null;
  const fran = prs.fastest.find((f) => f.name === 'Fran');
  const streakLine = s.trained_today
    ? `🔥 ${s.current_streak}-day streak`
    : (s.current_streak > 0 ? `🔥 ${s.current_streak}-day streak — train today to keep it!` : 'Start a streak today');

  content.innerHTML = '';
  const wrap = el(`
    <div>
      ${header}

      <div class="fitter">
        <div>
          <div class="fitter-lab">This week's avg score</div>
          <div class="fitter-val">${s.this_week_avg ?? '—'}
            ${delta != null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}</span>` : ''}</div>
        </div>
        <div class="fitter-note">${delta != null && delta >= 0 ? "You're getting fitter 💪" : (delta != null ? 'Keep grinding' : 'Build your baseline')}<br/>vs last week ${s.last_week_avg ?? '—'}</div>
      </div>

      <div class="sec-title">★ Personal Records</div>
      <div class="pr-grid">
        <div class="pr-card"><div class="pr-v">${prs.best_holistic ? prs.best_holistic.score : '—'}</div><div class="pr-l">Best Holistic${prs.best_holistic ? ' · ' + escapeHtml(prs.best_holistic.name) : ''}</div></div>
        <div class="pr-card"><div class="pr-v">${fran ? fmtTime(fran.time) : '—'}</div><div class="pr-l">Fastest Fran</div></div>
        <div class="pr-card"><div class="pr-v">${prs.highest_power ? Math.round(prs.highest_power.power) + 'W' : '—'}</div><div class="pr-l">Top Power</div></div>
        <div class="pr-card"><div class="pr-v">${prs.longest_streak}d</div><div class="pr-l">Longest Streak</div></div>
      </div>

      <div class="sec-title">🔥 Streak & consistency</div>
      <div class="card">
        <div class="streak-line">${streakLine}</div>
        ${heatmapHtml(d.heatmap)}
        <div class="heat-legend"><span>35 days</span><span>less</span><span class="lg lg1"></span><span class="lg lg2"></span><span class="lg lg3"></span><span>more</span></div>
      </div>

      <div class="sec-title">📈 Progress — Holistic Score</div>
      <div class="card">${svgLineChart(d.trend)}</div>

      <div class="sec-title">🏋 Workload this month</div>
      <div class="card">${barsHtml(d.workload)}</div>

      <div class="sec-title">🏆 How am I doing</div>
      <div class="cmp-grid">
        ${cmp.box ? `<div class="cmp-card"><div class="cmp-v">Top ${cmp.box.top_pct}%</div><div class="cmp-l">in your box</div></div>` : ''}
        ${cmp.exp ? `<div class="cmp-card"><div class="cmp-v">${cmp.exp.beats_pct}%</div><div class="cmp-l">of ${escapeHtml(labelFor(cmp.exp.level))} you beat</div></div>` : ''}
        ${cmp.fran ? `<div class="cmp-card"><div class="cmp-v">${cmp.fran.beats_pct}%</div><div class="cmp-l">of ${escapeHtml(labelFor(cmp.fran.level))} beat at Fran</div></div>` : ''}
      </div>

      ${d.benchmarks.length ? `<div class="sec-title">📊 Benchmark tracking</div><div id="benches"></div>` : ''}

      <div class="sec-title">🗒 Recent sessions</div>
      <div id="sessions"></div>

      <div class="center" style="margin-top:16px"><button class="link" id="reset2">Not you? Start over</button></div>
    </div>
  `);
  content.appendChild(wrap);

  const benchEl = wrap.querySelector('#benches');
  if (benchEl) d.benchmarks.forEach((b) => {
    const hist = b.history;
    const best = hist.reduce((m, x) => (x.time < m.time ? x : m), hist[0]);
    const latest = hist[hist.length - 1];
    benchEl.appendChild(el(`
      <div class="bench-row">
        <div class="bench-main"><div class="nm">${escapeHtml(b.name)}</div>
          <div class="meta">best ${fmtTime(best.time)} · latest ${fmtTime(latest.time)} · ${hist.length}×</div></div>
        <div class="bench-spark">${sparkTimes(hist)}</div>
      </div>`));
  });

  const sessEl = wrap.querySelector('#sessions');
  sessions.slice(0, 14).forEach((x) => {
    const row = el(`
      <div class="sess-row" data-id="${x.result_id}">
        <div class="sess-main"><div class="nm">${escapeHtml(x.name)} <span class="sess-type">${escapeHtml(x.type || '')}</span></div>
          <div class="meta">${fmtDate(x.wod_date)} · ${fmtTime(x.time_seconds)}</div></div>
        <div class="sess-score">${x.holistic_score}</div>
      </div>`);
    row.addEventListener('click', () => renderSession(x.result_id));
    sessEl.appendChild(row);
  });

  wrap.querySelector('#editProfile').addEventListener('click', () => renderProfileForm());
  wrap.querySelector('#reset2').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY); userId = null; profile = null; setView('profile');
  });
}

async function renderSession(resultId) {
  setScreenName('Session');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let s;
  try { s = (await api('GET', `/api/athlete/${userId}/session/${resultId}`)).session; }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  const b = s.breakdown;
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <button class="back-link" id="back">← Training history</button>
      <h1 class="title">${escapeHtml(s.name)}</h1>
      <p class="subtitle">${fmtDate(s.wod_date)} · ${escapeHtml(s.type || '')}</p>

      <div class="card score-reveal">
        <div class="num">${s.holistic_score}</div>
        <div class="cap">Holistic Score</div>
        <div class="brk-row">
          <span>time <b>${b.timeScore}</b></span>
          <span>ROM <b>${Math.round(b.romFactor * 100)}%</b></span>
          <span>pacing <b>${Math.round(b.pacingFactor * 100)}%</b></span>
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric"><div class="m-v">${fmtTime(s.time_seconds)}</div><div class="m-l">Time</div></div>
        <div class="metric"><div class="m-v">${s.avg_hr ?? '—'}</div><div class="m-l">Avg HR</div></div>
        <div class="metric"><div class="m-v">${s.peak_hr ?? '—'}</div><div class="m-l">Peak HR</div></div>
        <div class="metric"><div class="m-v">${s.calories ?? '—'}</div><div class="m-l">Calories</div></div>
        <div class="metric"><div class="m-v">${s.power_output != null ? Math.round(s.power_output) + 'W' : '—'}</div><div class="m-l">Avg Power</div></div>
        <div class="metric"><div class="m-v">${s.work_volume != null ? Math.round(s.work_volume) : '—'}</div><div class="m-l">Volume (kg)</div></div>
      </div>

      <div class="sec-title">Movement breakdown</div>
      <div id="moves"></div>
    </div>
  `));
  const movesEl = content.querySelector('#moves');
  if (!s.movements.length) movesEl.appendChild(el('<div class="muted-note">No movement detail.</div>'));
  s.movements.forEach((m) => movesEl.appendChild(el(`
    <div class="move-row">
      <div class="nm">${escapeHtml(m.movement)}</div>
      <div class="move-meta">${m.reps} reps · ${m.rom_pct}% ROM</div>
    </div>`)));
  content.querySelector('#back').addEventListener('click', () => renderRichProfile());
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
      showToast(resp.prs && resp.prs.length ? 'New PR! 🎉' : 'Logged ✓');
      renderLogged(resp.result, w, resp.newBadges || [], resp.prs || []);
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

function renderLogged(saved, w, newBadges, prs) {
  prs = prs || [];
  const score = Number(saved.holistic_score);
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">${prs.length ? 'New PR! 🎉' : 'Nice work!'}</h1>
      <p class="subtitle">${escapeHtml(w.name)} · ${fmtTime(saved.time_seconds)} · ${Math.round(saved.rom_pct)}% ROM</p>
      ${prs.map((pr) => `
        <div class="pr-celebrate">
          <div class="pc-burst">🎉</div>
          <div class="pc-title">Personal Record</div>
          <div class="pc-msg">${escapeHtml(pr.message)}</div>
        </div>`).join('')}
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
  if (ev.type === 'coach_post') {
    return `${name} <span class="role-tag">Coach</span><div class="feed-post">${escapeHtml(p.text || '')}</div>`;
  }
  if (ev.type === 'pr') {
    return `${name} set a PR — <span class="accent">${escapeHtml(p.label || 'New PR')}</span> 🎉`;
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

// ============================================================================
// Community — Circle.so integration (MOCK)
// ----------------------------------------------------------------------------
// This is a realistic DEMO mock of the Circle.so community embed. There is NO
// real Circle auth or API here — the spaces and posts below are hard-coded so
// the tab reads as "Circle, seamlessly inside WurQ."
//
// TODO (real integration, once the Circle plan is provisioned): replace this
// rendered mock with the live Circle community embedded via <iframe> pointing at
// community.wurq.io (hosted on the same TLD as the portal) and sign members in
// transparently using Circle's headless SSO — so a logged-in WurQ athlete lands
// in their Circle space with no extra login. Keep this portal chrome around it.
// ============================================================================

// Circle "spaces" (mock). `key` 'all' shows everything.
const COMMUNITY_SPACES = [
  { key: 'all', name: 'All posts' },
  { key: 'throwdowns', name: 'Throwdowns' },
  { key: 'scaling', name: 'Scaling & Skills' },
  { key: 'prs', name: 'PRs & Wins' },
];

// Seeded Circle discussion posts (mock data).
const COMMUNITY_POSTS = [
  {
    id: 'p1', space: 'throwdowns', author: 'Coach Mike', role: 'Coach', color: '#c6ff00',
    time: '2h ago',
    title: 'This Saturday: Summer Throwdown 🔥',
    body: 'Partner WOD + a surprise finisher. Teams of 2, all levels — scaled and RX heats. ' +
          'Drop your partner in the replies so we can set the heat sheet. Who\'s in?',
    replies: 12, likes: 34,
  },
  {
    id: 'p2', space: 'scaling', author: 'Sara K', role: null, color: '#7cd4ff',
    time: '5h ago',
    title: 'How should I scale Fran?',
    body: 'First time doing Fran tomorrow. Pull-ups are still my weak point — band, jumping, ' +
          'or ring rows? And is 65 lb a sensible thruster weight to start? 🙏',
    replies: 8, likes: 5,
  },
  {
    id: 'p3', space: 'prs', author: 'Dan R', role: null, color: '#ff9f7c',
    time: 'yesterday',
    title: '400 lb deadlift!! 🎉',
    body: 'Two years ago I couldn\'t pull 225. Hit 400 clean this morning. This community is ' +
          'the reason I kept showing up — thank you all. 🖤',
    replies: 21, likes: 57,
  },
  {
    id: 'p4', space: 'throwdowns', author: 'Coach Mike', role: 'Coach', color: '#c6ff00',
    time: '2d ago',
    title: 'Welcome our new members 👋',
    body: 'Five new faces this week — say hi, grab a partner for Saturday, and don\'t be shy ' +
          'about asking questions in Scaling & Skills.',
    replies: 4, likes: 18,
  },
];

function spaceName(key) {
  const s = COMMUNITY_SPACES.find((x) => x.key === key);
  return s ? s.name : 'All posts';
}

function renderCommunity() {
  setScreenName('Community');
  content.innerHTML = '';

  const posts = communitySpace === 'all'
    ? COMMUNITY_POSTS
    : COMMUNITY_POSTS.filter((p) => p.space === communitySpace);

  const wrap = el(`
    <div>
      <!-- MOCK: Circle.so embed chrome. Real version is an iframe to
           community.wurq.io with headless SSO (see comment block above). -->
      <div class="circle-strip">
        <div class="left">
          <span class="circle-mark"></span>
          <span class="label">Community <span class="by">· powered by Circle</span></span>
        </div>
        <span class="live">WurQ space</span>
      </div>

      <div class="space-chips" id="spaceChips">
        ${COMMUNITY_SPACES.map((s) =>
          `<button class="space-chip ${s.key === communitySpace ? 'active' : ''}" data-space="${s.key}"># ${escapeHtml(s.name)}</button>`
        ).join('')}
      </div>

      <div class="space-head">
        <div class="sname"><span class="hash">#</span> ${escapeHtml(spaceName(communitySpace))}</div>
        <button class="new-post" id="newPost">+ New post</button>
      </div>

      <div id="posts"></div>
    </div>
  `);
  content.appendChild(wrap);

  // Space switcher
  wrap.querySelector('#spaceChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-space]'); if (!b) return;
    communitySpace = b.dataset.space; renderCommunity();
  });

  // New post / replies are mock entry points into Circle.
  wrap.querySelector('#newPost').addEventListener('click', () =>
    showToast('Posting opens in Circle (mock)'));

  const list = wrap.querySelector('#posts');
  posts.forEach((p) => {
    const liked = likedPosts.has(p.id);
    const likeCount = p.likes + (liked ? 1 : 0);
    const card = el(`
      <div class="post-card">
        <div class="post-top">
          <div class="post-av" style="background:${p.color}">${escapeHtml(initials(p.author))}</div>
          <div class="post-who">
            <div class="post-author">${escapeHtml(p.author)}${p.role ? `<span class="role">${escapeHtml(p.role)}</span>` : ''}</div>
            <div class="post-meta">${escapeHtml(p.time)} · # ${escapeHtml(spaceName(p.space))}</div>
          </div>
        </div>
        <div class="post-title">${escapeHtml(p.title)}</div>
        <div class="post-body">${escapeHtml(p.body)}</div>
        <div class="post-foot">
          <button class="react like ${liked ? 'liked' : ''}" data-id="${p.id}">♥ <span class="lc">${likeCount}</span></button>
          <button class="react reply">💬 <span>${p.replies}</span></button>
        </div>
      </div>
    `);
    // Likes toggle client-side only (mock — no API call).
    card.querySelector('.like').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (likedPosts.has(p.id)) likedPosts.delete(p.id); else likedPosts.add(p.id);
      const on = likedPosts.has(p.id);
      btn.classList.toggle('liked', on);
      btn.querySelector('.lc').textContent = p.likes + (on ? 1 : 0);
    });
    card.querySelector('.reply').addEventListener('click', () =>
      showToast('Replies open in Circle (mock)'));
    list.appendChild(card);
  });
}

// ============================================================================
// Owner view — the gym-owner perspective (dashboard, competition, throwdowns,
// engagement). For the demo the owner owns OWNER_BOX_NAME ("CrossFit
// Borderland"); its box_id is resolved from /api/boxes.
// ============================================================================
function ymd(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function pct(x) { return Math.round((Number(x) || 0) * 100); }

async function loadOwnerBox() {
  try {
    const { boxes } = await api('GET', '/api/boxes');
    ownerBox = boxes.find((b) => b.name === OWNER_BOX_NAME) || null;
  } catch (e) { ownerBox = null; }
}

async function renderOwner() {
  if (!ownerBox) {
    content.innerHTML = '<p class="subtitle">Loading…</p>';
    await loadOwnerBox();
    if (!ownerBox) {
      content.innerHTML = `<div class="empty">Owner box "${escapeHtml(OWNER_BOX_NAME)}" not found.<br/>Run <code>npm run seed</code> to populate the demo world.</div>`;
      return;
    }
  }
  if (ownerView === 'compete') return renderOwnerCompete();
  if (ownerView === 'throwdown') return renderOwnerThrowdown();
  if (ownerView === 'engage') return renderOwnerEngage();
  return renderOwnerHome();
}

async function renderOwnerHome() {
  setScreenName('Dashboard');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d;
  try { d = await api('GET', `/api/owner/box/${ownerBox.box_id}/dashboard`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const p = d.participation, r = d.rank;
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Box dashboard</h1>
      <p class="subtitle">${escapeHtml(d.box.name)}${d.box.location ? ' · ' + escapeHtml(d.box.location) : ''}</p>

      <div class="card hero">
        <div class="big">${p.trained_today}</div>
        <div class="lab">members trained today</div>
        <div class="stat-row">
          <div class="mini-stat"><div class="n">${p.trained_week}</div><div class="l">This week</div></div>
          <div class="mini-stat"><div class="n">${p.total_members}</div><div class="l">Members</div></div>
          <div class="mini-stat"><div class="n">${pct(p.trained_week / Math.max(p.total_members, 1))}%</div><div class="l">Weekly active</div></div>
        </div>
      </div>

      ${r ? `<div class="rank-card">
        <div class="rc-top">
          <div class="pos">#${r.position}<span class="of"> / ${r.total_boxes}</span></div>
          <div class="rc-meta">Box vs Box<br/>${escapeHtml(r.workout_name)}</div>
        </div>
        <div class="rc-gap">${r.ahead
          ? `<b>${r.ahead.gap}</b> points behind <b>${escapeHtml(r.ahead.name)}</b>`
          : 'Top of the standings 🏆'}</div>
        <button class="btn-outline" id="toCompete">View competition →</button>
      </div>` : ''}

      <div class="sec-title danger-title">⚠ Members going quiet</div>
      <div id="churn"></div>

      <div class="sec-title">🔥 On a hot streak this week</div>
      <div id="streaks"></div>
    </div>
  `);
  content.appendChild(wrap);

  const churnEl = wrap.querySelector('#churn');
  if (!d.churn.length) churnEl.appendChild(el(`<div class="empty">Everyone's been active lately 🎉</div>`));
  d.churn.forEach((c) => churnEl.appendChild(el(`
    <div class="list-row warn">
      <div class="lr-main"><div class="nm">${escapeHtml(c.display_name)}</div>
        <div class="meta">${c.days_since == null ? 'No logs yet' : 'Last trained ' + c.days_since + ' days ago'}</div></div>
      <div class="pill-warn">${c.days_since == null ? 'inactive' : c.days_since + 'd'}</div>
    </div>`)));

  const streakEl = wrap.querySelector('#streaks');
  if (!d.streaks.length) streakEl.appendChild(el(`<div class="empty">No multi-day streaks yet this week.</div>`));
  d.streaks.forEach((s) => streakEl.appendChild(el(`
    <div class="list-row">
      <div class="lr-main"><div class="nm">${escapeHtml(s.display_name)}</div></div>
      <div class="pill-hot">${s.days_this_week} days 🔥</div>
    </div>`)));

  const cmp = wrap.querySelector('#toCompete');
  if (cmp) cmp.addEventListener('click', () => setOwnerView('compete'));
}

async function renderOwnerCompete() {
  setScreenName('Compete');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w, data;
  try { w = await ensureWorkout(); data = await api('GET', `/api/leaderboard/boxes/${w.workout_id}`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const boxes = data.boxes || [];
  const myIdx = boxes.findIndex((b) => b.box_id === ownerBox.box_id);
  const me = myIdx >= 0 ? boxes[myIdx] : null;
  const above = myIdx > 0 ? boxes[myIdx - 1] : null;

  let action = '';
  if (me && above) {
    const avg = me.avg_score || 1;
    const needLogged = Math.floor((above.score * me.total_members) / avg) + 1;
    const n = Math.max(1, needLogged - me.logged_members);
    action = `Log <b>${n}</b> more ${escapeHtml(w.name)} ${n === 1 ? 'result' : 'results'} to pass <b>${escapeHtml(above.name)}</b> — your turnout ${pct(me.participation)}% vs their ${pct(above.participation)}%.`;
  } else if (me && myIdx === 0) {
    action = `You're <b>#1</b> 🏆 — keep turnout high to hold the top spot.`;
  }

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Box vs Box</h1>
      <p class="subtitle">${fmtDate(w.wod_date)} · ${escapeHtml(w.name)} · avg × turnout</p>
      ${action ? `<div class="action-banner">${action}</div>` : ''}
      <div id="rows"></div>
    </div>
  `);
  content.appendChild(wrap);
  const rowsEl = wrap.querySelector('#rows');
  boxes.forEach((b, i) => {
    const mine = b.box_id === ownerBox.box_id;
    rowsEl.appendChild(el(`
      <div class="box-row ${mine ? 'mine' : ''}">
        <div class="box-rank">${i + 1}</div>
        <div class="box-main">
          <div class="box-name">${escapeHtml(b.name)}${mine ? ' · your box' : ''}</div>
          <div class="box-breakdown"><b>${b.avg_score}</b> avg × <b>${pct(b.participation)}%</b> turnout · ${b.logged_members}/${b.total_members} logged</div>
        </div>
        <div class="box-score">${b.score}</div>
      </div>`));
  });
}

async function renderOwnerThrowdown() {
  setScreenName('Throwdown');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w, challenges, boxesList, workoutsList;
  try {
    w = await ensureWorkout();
    [challenges, boxesList, workoutsList] = await Promise.all([
      api('GET', `/api/challenges/box/${ownerBox.box_id}`).then((r) => r.challenges),
      api('GET', '/api/boxes').then((r) => r.boxes),
      api('GET', '/api/workouts').then((r) => r.workouts),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const active = challenges.filter((c) => c.status === 'active');
  const completed = challenges.filter((c) => c.status !== 'active');
  const [activeStandings, completedStandings] = await Promise.all([
    Promise.all(active.map((c) => api('GET', `/api/challenges/${c.id}/standing`).catch(() => null))),
    Promise.all(completed.map((c) => api('GET', `/api/challenges/${c.id}/standing`).catch(() => null))),
  ]);

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Throwdowns</h1>
      <p class="subtitle">Challenge another box — live head-to-head scoring</p>
      <div id="active"></div>
      ${completed.length ? `<div class="sec-title">Recent throwdowns</div><div id="completed"></div>` : ''}
      <div class="sec-title">Start a throwdown</div>
      <div class="card">
        <label class="field"><span class="lbl">Rival box</span>
          <select id="rival">${boxesList.filter((b) => b.box_id !== ownerBox.box_id)
            .map((b) => `<option value="${b.box_id}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
        <label class="field"><span class="lbl">WOD</span>
          <select id="wod">${workoutsList.map((x) =>
            `<option value="${x.workout_id}" ${x.workout_id === w.workout_id ? 'selected' : ''}>${escapeHtml(x.name)} · ${fmtDate(x.wod_date)}</option>`).join('')}</select></label>
        <div class="range2">
          <label class="field"><span class="lbl">Starts</span><input type="date" id="starts" value="${ymd(new Date())}" /></label>
          <label class="field"><span class="lbl">Ends</span><input type="date" id="ends" value="${ymd(new Date(Date.now() + 7 * 86400000))}" /></label>
        </div>
        <button class="btn-primary" id="send">Send challenge ⚔</button>
        <div class="error" id="err"></div>
      </div>
    </div>
  `);
  content.appendChild(wrap);

  const activeEl = wrap.querySelector('#active');
  if (!active.length) activeEl.appendChild(el(`<div class="empty">No active throwdowns yet. Start one below.</div>`));
  activeStandings.filter(Boolean).forEach((s) => activeEl.appendChild(throwdownCard(s)));

  const completedEl = wrap.querySelector('#completed');
  if (completedEl) completedStandings.filter(Boolean).forEach((s) => completedEl.appendChild(completedRow(s)));

  const err = wrap.querySelector('#err');
  const btn = wrap.querySelector('#send');
  btn.addEventListener('click', async () => {
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await api('POST', '/api/challenges', {
        challengerBoxId: ownerBox.box_id,
        opponentBoxId: wrap.querySelector('#rival').value,
        workoutId: wrap.querySelector('#wod').value,
        startsAt: wrap.querySelector('#starts').value,
        endsAt: wrap.querySelector('#ends').value,
      });
      showToast('Challenge sent ⚔');
      renderOwnerThrowdown();
    } catch (e) {
      err.textContent = e.message; btn.disabled = false; btn.textContent = 'Send challenge ⚔';
    }
  });
}

function throwdownCard(s) {
  const ch = s.challenge;
  const mineIsChallenger = ch.challenger_box_id === ownerBox.box_id;
  const mine = mineIsChallenger ? s.challenger : s.opponent;
  const them = mineIsChallenger ? s.opponent : s.challenger;
  const winMine = mine.score >= them.score;
  const total = (mine.score + them.score) || 1;
  return el(`
    <div class="card td-card">
      <div class="td-head"><b>${escapeHtml(ch.workout_name)}</b> · ${fmtDate(ch.starts_at)} – ${fmtDate(ch.ends_at)}</div>
      <div class="vs">
        <div class="side ${winMine ? 'win' : ''}">
          <div class="tag">YOU</div><div class="sub">${escapeHtml(mine.name)}</div>
          <div class="s">${mine.score}</div>
          <div class="brk">${mine.avg_score} avg × ${pct(mine.participation)}%</div>
        </div>
        <div class="mid">VS</div>
        <div class="side ${!winMine ? 'win' : ''}">
          <div class="tag">RIVAL</div><div class="sub">${escapeHtml(them.name)}</div>
          <div class="s">${them.score}</div>
          <div class="brk">${them.avg_score} avg × ${pct(them.participation)}%</div>
        </div>
      </div>
      <div class="vsbar"><span class="a" style="flex:${mine.score + 0.01}"></span><span class="b" style="flex:${them.score + 0.01}"></span></div>
      <div class="vs-note">${winMine ? 'You\'re ahead' : 'You\'re behind'} — updates live as members log ${escapeHtml(ch.workout_name)}.</div>
    </div>
  `);
}

function completedRow(s) {
  const ch = s.challenge;
  const mineIsChallenger = ch.challenger_box_id === ownerBox.box_id;
  const mine = mineIsChallenger ? s.challenger : s.opponent;
  const them = mineIsChallenger ? s.opponent : s.challenger;
  const won = mine.score >= them.score;
  return el(`
    <div class="list-row">
      <div class="lr-main">
        <div class="nm">${escapeHtml(ch.workout_name)} · vs ${escapeHtml(them.name)}</div>
        <div class="meta">${mine.score} – ${them.score} · ${fmtDate(ch.ends_at)}</div>
      </div>
      <div class="${won ? 'pill-hot' : 'pill-warn'}">${won ? 'WON' : 'LOST'}</div>
    </div>`);
}

async function renderOwnerEngage() {
  setScreenName('Engage');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w;
  try { w = await ensureWorkout(); } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Engage your box</h1>
      <p class="subtitle">Mobilize members in a tap</p>
      <div class="card">
        <div class="wod-head"><h2 class="wod-name">${escapeHtml(w.name)}</h2>${w.type ? `<span class="type-badge">${escapeHtml(w.type)}</span>` : ''}</div>
        <div class="wod-date">${fmtDate(w.wod_date)}</div>
        <p class="wod-desc">${escapeHtml(w.description)}</p>
      </div>
      <button class="btn-primary" id="postWod">📣 Post today's WOD to the box</button>
      <button class="btn-outline wide" id="rally">💪 Rally members going quiet</button>
      <p class="subtitle" style="margin-top:14px">These notifications are mocked for the demo — taps confirm visually.</p>
    </div>
  `);
  content.appendChild(wrap);
  // Engagement sends are MOCK for the demo (no push/email wired up).
  wrap.querySelector('#postWod').addEventListener('click', () =>
    showToast(`Posted ${w.name} to ${ownerBox.name} (mock)`));
  wrap.querySelector('#rally').addEventListener('click', () =>
    showToast('Rally sent to quiet members 💪 (mock)'));
}

// ---- bootstrap --------------------------------------------------------------
async function loadProfile() {
  try { profile = await api('GET', `/api/profile/${userId}`); }
  catch (e) { localStorage.removeItem(STORAGE_KEY); userId = null; profile = null; }
  go();
}

renderNav();
updateRoleToggle();
if (userId) loadProfile(); else go();
