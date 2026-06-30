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
let currentView = 'profile';     // 'profile' | 'log' | 'leaderboard' | 'compete' | 'community' | 'feed'
let competeTab = 'comps';        // 'comps' | 'people'
let todayWorkout = null;
let lbTab = 'box';               // 'box' | 'boxes'
let communitySpace = 'all';      // selected Circle space (mock)
let communityTab = 'box';        // 'box' (engagement) | 'global' | 'circle' (mock embed)
let globalTab = 'feed';          // 'feed' | 'top' | 'following'
let globalScope = 'today';       // global leaderboard scope: 'today' | 'overall'
let followingSet = null;         // Set of user_ids the current user follows
const likedPosts = new Set();    // client-only like state for the Circle mock
let pendingAvatarUrl = null;

// WurQ app integration (MOCK). In production the WurQ iOS app POSTs workouts to
// the ingestion endpoint with its own credentials — the browser never holds this
// token. It lives here ONLY to power the demo "Simulate WurQ sync" affordance.
// TODO(wurq-integration): remove the client-side token; real syncs are
// app-authenticated, and "Connect" becomes a real WurQ SSO/OAuth handshake.
const WURQ_DEMO_TOKEN = 'wurq-demo-secret';

// Build a realistic WurQ-shaped workout payload (auto-captured sensor metrics),
// the way the WurQ app would for today's WOD. Randomized a little per call.
function buildWurqPayload(email, workout) {
  const r = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));
  const time = r(170, 260);
  const rom = r(88, 98);
  const avg = r(160, 176);
  return {
    athlete: { email, wurq_user_id: 'wq_' + (email || 'demo').split('@')[0] },
    workout: { name: workout.name, type: workout.type || 'For Time', performed_at: new Date().toISOString() },
    metrics: {
      duration_sec: time,
      range_of_motion_pct: rom,
      unbroken_sets: r(4, 9),
      heart_rate: { avg_bpm: avg, peak_bpm: avg + r(10, 20) },
      calories_kcal: r(120, 170),
      power_output_w: Math.round((280 + Math.random() * 180) * 10) / 10,
      work_volume_kg: r(4200, 6200),
      // holistic_score intentionally omitted — let the platform compute it, like
      // the manual path, so the demo shows server-side scoring of a sync too.
    },
  };
}

// Post a workout exactly as the WurQ app would (mock). In production this fires
// from the WurQ app, NOT a button — see the "Simulate WurQ sync" demo control.
async function postWurqSync(payload) {
  const res = await fetch('/api/integrations/wurq/workout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wurq-token': WURQ_DEMO_TOKEN },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Sync failed (${res.status})`);
  return data;
}

async function setWurqConnected(connected) {
  const r = await api('POST', '/api/integrations/wurq/connect', { userId, action: connected ? 'connect' : 'disconnect' });
  if (profile) profile.wurq_connected = r.wurq_connected;
  return r.wurq_connected;
}

// Mock OAuth-style handshake to link the WurQ account. Visual confirm only.
// TODO(wurq-integration): replace with real WurQ SSO/OAuth — redirect/authorize,
// exchange a token, then persist the connection.
function openWurqConnect(onDone) {
  const ov = el(`
    <div class="wurq-overlay">
      <div class="wurq-modal">
        <div class="wurq-logo big">Wur<span>Q</span></div>
        <div class="wm-title">Connect your WurQ account</div>
        <div class="wm-sub">Authorize WurQ to sync your workouts to this community automatically — scores, ROM, power, heart rate &amp; more, captured by the app.</div>
        <div class="wm-scopes">
          <div>✓ Read your completed workouts</div>
          <div>✓ Sync sensor metrics</div>
          <div>✓ Keep your leaderboard live</div>
        </div>
        <button class="btn-primary" id="wmAuth">Authorize &amp; connect</button>
        <button class="link" id="wmCancel">Not now</button>
        <div class="demo-note">Mock OAuth for the demo — becomes real WurQ SSO once we have access.</div>
      </div>
    </div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#wmCancel').addEventListener('click', close);
  ov.querySelector('#wmAuth').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Authorizing…';
    try { await setWurqConnected(true); showToast('WurQ connected ⌚'); close(); if (onDone) onDone(); }
    catch (err) { btn.disabled = false; btn.textContent = 'Authorize & connect'; showToast(err.message); }
  });
}

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
  ['log', '▦', 'WOD'], ['leaderboard', '≡', 'Board'], ['compete', '◈', 'Compete'],
  ['community', '❖', 'Community'], ['feed', '✦', 'Feed'], ['profile', '◉', 'Profile'],
];
const NAV_OWNER = [
  ['home', '◧', 'Home'], ['business', '$', 'Business'], ['compete', '≡', 'Compete'],
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
  if (currentView === 'compete') return renderCompete();
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
      const wasOnboarding = onboarding;
      profile = await api('PUT', `/api/profile/${userId}`, payload);
      showToast('Saved ✓');
      // First-time completion → connection-driven onboarding wizard.
      if (wasOnboarding && profile.profile_complete) renderOnboarding();
      else renderProfile(); // -> rich profile once complete
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

async function renderRichProfile(targetId, opts) {
  opts = opts || {};
  const id = targetId || userId;
  const ro = !!opts.readOnly; // viewing another athlete (e.g. a coach)
  setScreenName(ro ? 'Athlete' : 'Profile');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d, sessions;
  try {
    [d, sessions] = await Promise.all([
      api('GET', `/api/athlete/${id}/profile`),
      api('GET', `/api/athlete/${id}/history`).then((r) => r.sessions),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const u = d.user, s = d.summary, prs = d.prs, cmp = d.comparison;
  const avatar = u.avatar_url;
  const coachBadge = u.is_coach ? ' <span class="coach-tag">Coach</span>' : '';
  const wurqChip = u.wurq_connected ? ' <span class="wurq-tag">⌚ WurQ</span>' : '';
  const backLink = ro ? `<button class="back-link" id="profBack">← Back</button>` : '';
  const header = `
    ${backLink}
    <div class="prof-head">
      <div class="avatar ${avatar ? 'has-img' : ''}" style="width:64px;height:64px">
        ${avatar ? `<img src="${escapeAttr(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover"/>` : initials(u.display_name)}
      </div>
      <div class="prof-id">
        <div class="prof-name">${escapeHtml(u.display_name || 'Athlete')}${coachBadge}${wurqChip}</div>
        <div class="prof-sub">${u.is_coach ? 'Coaches at ' : ''}${escapeHtml(u.gym_name || 'No box')}${u.experience_level ? ' · ' + labelFor(u.experience_level) : ''}</div>
      </div>
      ${ro ? '' : '<button class="edit-btn" id="editProfile">Edit</button>'}
    </div>`;
  const wireHeader = () => {
    const eb = content.querySelector('#editProfile'); if (eb) eb.addEventListener('click', () => renderProfileForm());
    const bb = content.querySelector('#profBack'); if (bb) bb.addEventListener('click', opts.back || (() => setView('profile')));
  };

  if (!s.sessions_total) {
    content.innerHTML = '';
    content.appendChild(el(`<div>${header}
      <div class="empty">No training history yet.${ro ? '' : '<br/>Log today\'s WOD to start building your record.'}</div>
      ${ro ? '' : '<button class="btn-primary" id="goLog">Log today\'s WOD</button>'}</div>`));
    wireHeader();
    const gl = content.querySelector('#goLog'); if (gl) gl.addEventListener('click', () => setView('log'));
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

      ${(!ro && u.is_coach) ? '<button class="coach-cta" id="coachTools">🎯 Coach tools — program, roster &amp; announce</button>' : ''}

      ${!ro ? (u.wurq_connected
        ? '<div class="wurq-prof on"><span><span class="wurq-dot"></span> WurQ connected — workouts sync automatically</span><button class="link" id="wurqManage">Disconnect</button></div>'
        : '<button class="wurq-prof off" id="wurqConnectProf">⌚ Connect your WurQ app to sync workouts</button>') : ''}

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

      ${ro ? '' : '<div class="center" style="margin-top:16px"><button class="link" id="reset2">Not you? Start over</button></div>'}
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
    row.addEventListener('click', () => renderSession(x.result_id, id, ro ? opts : null));
    sessEl.appendChild(row);
  });

  wireHeader();
  const ct = wrap.querySelector('#coachTools');
  if (ct) ct.addEventListener('click', () => renderCoach());
  const wcp = wrap.querySelector('#wurqConnectProf');
  if (wcp) wcp.addEventListener('click', () => openWurqConnect(() => renderRichProfile()));
  const wmg = wrap.querySelector('#wurqManage');
  if (wmg) wmg.addEventListener('click', async () => {
    try { await setWurqConnected(false); showToast('WurQ disconnected'); renderRichProfile(); } catch (e) { showToast(e.message); }
  });
  if (!ro) {
    const r2 = wrap.querySelector('#reset2');
    if (r2) r2.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY); userId = null; profile = null; setView('profile');
    });
  }
}

async function renderSession(resultId, athleteId, backOpts) {
  const aid = athleteId || userId;
  setScreenName('Session');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let s;
  try { s = (await api('GET', `/api/athlete/${aid}/session/${resultId}`)).session; }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  const b = s.breakdown;
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <button class="back-link" id="back">← Training history</button>
      <h1 class="title">${escapeHtml(s.name)}</h1>
      <p class="subtitle">${fmtDate(s.wod_date)} · ${escapeHtml(s.type || '')}</p>
      ${s.source === 'wurq' ? '<div class="synced-banner">⌚ Synced from WurQ · metrics auto-captured</div>' : ''}

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
  content.querySelector('#back').addEventListener('click', () => {
    if (athleteId && athleteId !== userId) renderRichProfile(athleteId, backOpts || { readOnly: true });
    else renderRichProfile();
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

  const connected = !!(profile && profile.wurq_connected);
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">Today's WOD</h1>

      <div class="card">
        <div class="wod-head">
          <h2 class="wod-name">${escapeHtml(w.name)}</h2>
          ${w.type ? `<span class="type-badge">${escapeHtml(w.type)}</span>` : ''}
        </div>
        <div class="wod-date">${fmtDate(w.wod_date)}</div>
        ${w.programmed_by_name ? `<div class="wod-by">🧢 Programmed by Coach ${escapeHtml(w.programmed_by_name)}</div>` : ''}
        <p class="wod-desc">${escapeHtml(w.description)}</p>
        ${w.scaling ? `<div class="wod-scale"><span class="ws-lab">Scaling</span>${escapeHtml(w.scaling)}</div>` : ''}
      </div>

      <!-- WurQ sync is the primary flow: workouts arrive from the app. -->
      <div class="wurq-card ${connected ? 'on' : 'off'}">
        <div class="wurq-top">
          <div class="wurq-logo">Wur<span>Q</span></div>
          <div class="wurq-state">${connected
            ? '<span class="wurq-dot"></span> Connected — workouts sync automatically'
            : 'Connect your WurQ app to sync workouts automatically'}</div>
        </div>
        ${connected ? `
          <p class="wurq-sub">Finish a workout in the WurQ app and it lands here with full sensor metrics — ROM, power, heart rate &amp; work volume, auto-captured.</p>
          <button class="btn-primary wurq-sim" id="wurqSim">⌚ Simulate WurQ sync</button>
          <div class="demo-note">Demo control — in production this fires from the WurQ app, not a button.</div>
        ` : `
          <button class="btn-primary" id="wurqConnect">Connect WurQ app</button>
        `}
        <div class="error" id="wErr"></div>
      </div>

      <button class="link manual-toggle" id="manualToggle">${connected ? 'Log manually instead' : 'Or log manually'}</button>
      <div class="card manual-card ${connected ? 'hidden' : ''}" id="manualCard">
        <div class="manual-lab">✍️ Manual entry</div>
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

  // WurQ connect (mock OAuth) — flips the connected state.
  const wErr = content.querySelector('#wErr');
  const connectBtn = content.querySelector('#wurqConnect');
  if (connectBtn) connectBtn.addEventListener('click', () => openWurqConnect(() => renderLog()));

  // Simulate a workout arriving from the WurQ app.
  const simBtn = content.querySelector('#wurqSim');
  if (simBtn) simBtn.addEventListener('click', async () => {
    wErr.textContent = '';
    simBtn.disabled = true; simBtn.textContent = '⌚ Syncing from WurQ…';
    try {
      const payload = buildWurqPayload(profile.email, w);
      const resp = await postWurqSync(payload);
      showToast('Synced from WurQ ⌚');
      renderLogged(resp.result, w, resp.newBadges || [], resp.prs || [], resp.comeback, { synced: true, metrics: payload.metrics });
    } catch (e) { wErr.textContent = e.message; simBtn.disabled = false; simBtn.textContent = '⌚ Simulate WurQ sync'; }
  });

  const manualToggle = content.querySelector('#manualToggle');
  manualToggle.addEventListener('click', () => content.querySelector('#manualCard').classList.toggle('hidden'));

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
      showToast(resp.prs && resp.prs.length ? 'New PR! 🎉' : (resp.comeback ? 'Welcome back! 🔥' : 'Logged ✓'));
      renderLogged(resp.result, w, resp.newBadges || [], resp.prs || [], resp.comeback);
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

function renderLogged(saved, w, newBadges, prs, comeback, opts) {
  prs = prs || [];
  opts = opts || {};
  const score = Number(saved.holistic_score);
  const m = opts.metrics || {};
  const hr = m.heart_rate || {};
  // Sensor metrics auto-captured by WurQ (shown as captured, not typed).
  const sensorGrid = opts.synced ? `
    <div class="synced-banner">⌚ Synced from your WurQ app · <span>auto-captured</span></div>
    <div class="sensor-grid">
      <div class="sensor"><div class="sv">${Math.round(saved.rom_pct)}%</div><div class="sl">ROM</div></div>
      <div class="sensor"><div class="sv">${m.power_output_w != null ? Math.round(m.power_output_w) + 'W' : '—'}</div><div class="sl">Avg power</div></div>
      <div class="sensor"><div class="sv">${hr.avg_bpm ?? '—'}</div><div class="sl">Avg HR</div></div>
      <div class="sensor"><div class="sv">${hr.peak_bpm ?? '—'}</div><div class="sl">Peak HR</div></div>
      <div class="sensor"><div class="sv">${m.calories_kcal ?? '—'}</div><div class="sl">Calories</div></div>
      <div class="sensor"><div class="sv">${m.work_volume_kg != null ? Math.round(m.work_volume_kg) : '—'}</div><div class="sl">Volume kg</div></div>
    </div>` : '';
  content.innerHTML = '';
  content.appendChild(el(`
    <div>
      <h1 class="title">${prs.length ? 'New PR! 🎉' : (comeback ? 'You\'re back! 🔥' : (opts.synced ? 'Workout synced ⌚' : 'Nice work!'))}</h1>
      <p class="subtitle">${escapeHtml(w.name)} · ${fmtTime(saved.time_seconds)} · ${Math.round(saved.rom_pct)}% ROM</p>
      ${sensorGrid}
      ${comeback ? `<div class="pr-celebrate"><div class="pc-burst">🔥</div><div class="pc-title">Comeback</div><div class="pc-msg">${escapeHtml(comeback.message || 'Welcome back!')}</div></div>` : ''}
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
      <div id="goalTick"></div>
      <button class="btn-primary" id="toLb">View leaderboard</button>
      <div class="center" style="margin-top:14px"><button class="link" id="again">Edit my result</button></div>
    </div>
  `));
  countUp(content.querySelector('#scoreNum'), score);
  content.querySelector('#toLb').addEventListener('click', () => { lbTab = 'box'; setView('leaderboard'); });
  // Show the box team goal ticking up from this logged workout.
  if (profile && profile.box_id) {
    api('GET', `/api/box/${profile.box_id}/team-goal`).then((res) => {
      const g = res.goal; const node = content.querySelector('#goalTick');
      if (g && node) node.appendChild(el(`<div class="goal-tick">▲ +1 to your box goal · <b>${g.current}/${g.target}</b> ${escapeHtml(g.label)}</div>`));
    }).catch(() => {});
  }
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
          <div class="lb-name">${escapeHtml(r.display_name)}${r.is_coach ? ' <span class="coach-tag">Coach</span>' : ''}${me ? ' · you' : ''}</div>
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
  const name = `<b>${escapeHtml(ev.display_name)}</b>${ev.is_coach ? ' <span class="coach-tag">Coach</span>' : ''}`;
  const p = ev.payload || {};
  if (ev.type === 'announcement') {
    return `${name} posted a box announcement 📣<div class="feed-post">${escapeHtml(p.text || '')}</div>`;
  }
  if (ev.type === 'result_logged') {
    const wurq = p.source === 'wurq' ? ' <span class="wurq-tag">⌚ WurQ</span>' : '';
    return `${name} ${p.source === 'wurq' ? 'synced' : 'logged'} <b>${escapeHtml(p.workout_name || 'a workout')}</b> — <span class="accent">${num(p.holistic_score)}</span>${wurq}`;
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
  if (ev.type === 'shoutout') {
    return `${name} gave a shout-out to <span class="accent">${escapeHtml(p.to_name || 'a teammate')}</span> 🙌<div class="feed-post">“${escapeHtml(p.text || '')}”</div>`;
  }
  if (ev.type === 'comeback') {
    return `${name} <span class="accent">is back! 🔥</span> returned after ${p.gap_days || 7}+ days and logged ${escapeHtml(p.workout_name || 'a WOD')}`;
  }
  if (ev.type === 'referral_joined') {
    return `${name} grew the box — a friend just joined 🎉 <span class="accent">+${p.points || 50} pts</span>`;
  }
  if (ev.type === 'training_partner') {
    return `${name} teamed up with <span class="accent">${escapeHtml(p.partner_name || 'an athlete')}</span> as training partners 🤝${p.partner_box ? `<div class="feed-sub-line">${escapeHtml(p.partner_box)}</div>` : ''}`;
  }
  if (ev.type === 'h2h_start') {
    return `${name} started a head-to-head vs <span class="accent">${escapeHtml(p.opponent_name || 'a rival')}</span> ⚔️ <span class="muted-note">(${escapeHtml(p.unit || 'avg score')})</span>`;
  }
  if (ev.type === 'h2h_result') {
    return `${name} won a head-to-head vs <span class="accent">${escapeHtml(p.opponent_name || 'a rival')}</span> 🏆`;
  }
  if (ev.type === 'comp_win') {
    return `${name} won <span class="accent">${escapeHtml(p.title || 'a competition')}</span> 🏆${p.value != null ? ` <span class="muted-note">(${num(p.value)})</span>` : ''}`;
  }
  if (ev.type === 'highfive') {
    return `${name} high-fived <span class="accent">${escapeHtml(p.to_name || 'an athlete')}</span> ✋`;
  }
  if (ev.type === 'commit_made') {
    return `${name} ${p.by_coach ? 'took the coach up on it' : 'made a commitment'} ✊<div class="feed-post">${escapeHtml(p.target || '')}</div>`;
  }
  if (ev.type === 'commit_kept') {
    return `${name} kept ${p.by_coach ? "their coach's" : 'a'} commitment 🎯 <span class="accent">followed through!</span><div class="feed-post">${escapeHtml(p.target || '')}</div>`;
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

// Community area: a "Community" engagement hub + the "Circle" embed mock.
function renderCommunity() {
  setScreenName('Community');
  if (!userId) return setView('profile');
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <div class="tabs tabs3" id="commTabs">
        <button data-ct="box">Box</button>
        <button data-ct="global">Global</button>
        <button data-ct="circle">Circle</button>
      </div>
      <div id="commBody"></div>
    </div>
  `);
  content.appendChild(wrap);
  const tabsEl = wrap.querySelector('#commTabs');
  tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.ct === communityTab));
  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    communityTab = b.dataset.ct; renderCommunity();
  });
  const body = wrap.querySelector('#commBody');
  if (communityTab === 'circle') return renderCircleInto(body);
  if (communityTab === 'global') return renderGlobalInto(body);
  return renderCommunityHub(body);
}

// Team-goal progress card (centerpiece).
function teamGoalCardHtml(g) {
  const top = g.top.slice(0, 3).map((t) => escapeHtml(t.display_name.split(' ')[0])).join(', ');
  return `
    <div class="goal-card">
      <div class="goal-head"><span class="goal-title">🎯 Box goal</span><span class="goal-days">${g.days_remaining}d left</span></div>
      <div class="goal-metric">${g.current}<span class="goal-of"> / ${g.target} ${escapeHtml(g.label)}</span></div>
      <div class="goal-bar"><span style="width:${g.pct}%"></span></div>
      <div class="goal-sub"><b>${g.remaining}</b> to go · ${g.contributors} contributors</div>
      ${top ? `<div class="goal-top">🔝 Top: ${top}</div>` : ''}
    </div>`;
}

function affiliateCardHtml(a) {
  const medal = a.tier === 'Gold' ? '🥇' : a.tier === 'Silver' ? '🥈' : '🥉';
  return `
    <div class="affiliate-card tier-${a.tier.toLowerCase()}">
      <div class="aff-top">
        <div class="aff-tier">${medal} ${a.tier} affiliate</div>
        <div class="aff-pts">${a.owner_referral_points} referral pts</div>
      </div>
      <div class="aff-sub">${Math.round(a.participation * 100)}% weekly turnout · ${a.referrals_joined} referrals joined</div>
      <div class="aff-next">${a.next_tier ? `<b>${a.to_next}</b> pts to ${a.next_tier} ${a.next_tier === 'Gold' ? '🥇' : '🥈'}` : 'Top tier reached 🏆'}</div>
      <div class="aff-perks">${a.perks.map((p) => `<span class="aff-perk">✓ ${escapeHtml(p)}</span>`).join('')}</div>
    </div>`;
}

function feedItemEl(ev) {
  const elevated = ev.is_coach || ev.type === 'announcement';
  const item = el(`
    <div class="feed-item ${elevated ? 'feed-elevated' : ''}">
      ${avatarHtml(ev.avatar_url, ev.display_name, 'feed-av')}
      <div class="feed-body">
        <div class="feed-text">${feedText(ev)}</div>
        <div class="feed-meta">
          <span class="feed-time">${timeAgo(ev.created_at)}</span>
          <button class="kudos" data-id="${escapeAttr(ev.event_id)}">👏 <span class="kudos-n">${ev.kudos}</span></button>
        </div>
      </div>
    </div>`);
  const btn = item.querySelector('.kudos');
  btn.addEventListener('click', async () => {
    try { const r = await api('POST', `/api/feed/${ev.event_id}/kudos`); item.querySelector('.kudos-n').textContent = r.kudos; btn.classList.add('kudosed'); }
    catch (e) { showToast(e.message); }
  });
  return item;
}

async function renderCommunityHub(container) {
  if (!profile || !profile.box_id) {
    container.innerHTML = '';
    container.appendChild(el(`<div class="empty">Set your gym / box on your profile to join the community.</div>
      <button class="btn-primary" id="toProf">Set your gym</button>`));
    container.querySelector('#toProf').addEventListener('click', () => setView('profile'));
    return;
  }
  container.innerHTML = '<p class="subtitle">Loading…</p>';
  const boxId = profile.box_id;
  let goal, squads, newcomers, members;
  try {
    [goal, squads, newcomers, members] = await Promise.all([
      api('GET', `/api/box/${boxId}/team-goal`).then((r) => r.goal),
      api('GET', `/api/box/${boxId}/squads?userId=${userId}`).then((r) => r.squads),
      api('GET', `/api/box/${boxId}/newcomers`).then((r) => r.newcomers),
      api('GET', `/api/box/${boxId}/members`).then((r) => r.members),
    ]);
  } catch (e) { container.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  container.innerHTML = '';
  const wrap = el(`
    <div>
      ${goal ? teamGoalCardHtml(goal) : ''}
      <div class="commit-cta" id="commitCta">
        <div class="cc-l"><div class="cc-t">🎯 Commitments</div><div class="cc-s" id="commitRally">Loading…</div></div>
        <span class="cc-go">Make one →</span>
      </div>
      <button class="btn-primary" id="bringFriend">🤝 Bring a friend — grow your box</button>
      <button class="btn-outline wide" id="giveShout">🙌 Give a shout-out</button>
      <div id="shoutComposer"></div>
      <div class="sec-title">Squads in ${escapeHtml(profile.box_name || 'your box')}</div>
      <div id="squads"></div>
      <div class="sec-title">👋 New this week</div>
      <div id="newcomers"></div>
    </div>
  `);
  container.appendChild(wrap);

  const sqEl = wrap.querySelector('#squads');
  if (!squads.length) sqEl.appendChild(el('<div class="muted-note">No squads yet.</div>'));
  squads.forEach((s) => {
    const row = el(`
      <div class="squad-row">
        <div class="squad-main" data-id="${s.id}">
          <div class="nm">${escapeHtml(s.name)}</div>
          <div class="meta">${s.member_count} member${s.member_count === 1 ? '' : 's'}</div>
        </div>
        <button class="squad-join ${s.is_member ? 'joined' : ''}" data-member="${s.is_member}">${s.is_member ? 'Joined' : 'Join'}</button>
      </div>`);
    row.querySelector('.squad-main').addEventListener('click', () => renderSquadDetail(s.id));
    const jb = row.querySelector('.squad-join');
    jb.addEventListener('click', async () => {
      const isMember = jb.dataset.member === 'true';
      try {
        await api('POST', `/api/squads/${s.id}/${isMember ? 'leave' : 'join'}`, { userId });
        jb.dataset.member = String(!isMember);
        jb.classList.toggle('joined', !isMember);
        jb.textContent = !isMember ? 'Joined' : 'Join';
        showToast(!isMember ? `Joined ${s.name}` : `Left ${s.name}`);
      } catch (e) { showToast(e.message); }
    });
    sqEl.appendChild(row);
  });

  const ncEl = wrap.querySelector('#newcomers');
  if (!newcomers.length) ncEl.appendChild(el('<div class="muted-note">No new members this week.</div>'));
  newcomers.forEach((n) => {
    const row = el(`<div class="list-row"><div class="lr-main"><div class="nm">${escapeHtml(n.display_name)}</div>
      <div class="meta">joined ${timeAgo(n.joined_at)}</div></div><button class="pill-btn welcome-btn">👋 Welcome</button></div>`);
    row.querySelector('.welcome-btn').addEventListener('click', (e) => {
      showToast(`Welcome sent to ${n.display_name} 👋`); e.currentTarget.textContent = 'Welcomed ✓'; e.currentTarget.disabled = true;
    });
    ncEl.appendChild(row);
  });

  wrap.querySelector('#giveShout').addEventListener('click', () =>
    openShoutComposer(wrap.querySelector('#shoutComposer'), members));
  wrap.querySelector('#bringFriend').addEventListener('click', () => renderReferral());
  wrap.querySelector('#commitCta').addEventListener('click', () => renderCommitments());
  (async () => {
    try {
      const s = await api('GET', `/api/box/${boxId}/commitment-stats`);
      const r = wrap.querySelector('#commitRally');
      if (r) r.textContent = `${s.committed} member${s.committed === 1 ? '' : 's'} committed this week · ${s.kept_this_week} kept`;
    } catch (_) { const r = wrap.querySelector('#commitRally'); if (r) r.textContent = 'Make a public commitment'; }
  })();
}

// "Bring a friend" — referral screen.
async function renderReferral() {
  setScreenName('Refer');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let data, leaders;
  try {
    [data, leaders] = await Promise.all([
      api('GET', `/api/users/${userId}/referrals`),
      profile.box_id ? api('GET', `/api/box/${profile.box_id}/referral-leaderboard`).then((r) => r.leaders) : Promise.resolve([]),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const myRank = leaders.findIndex((l) => l.user_id === userId);
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <button class="back-link" id="back">← Community</button>
      <h1 class="title">Bring a friend</h1>
      <p class="subtitle">Grow your box. When a friend joins, you both earn points.</p>

      <div class="pr-grid" style="grid-template-columns:1fr 1fr">
        <div class="pr-card"><div class="pr-v">${data.points}</div><div class="pr-l">Referral points</div></div>
        <div class="pr-card"><div class="pr-v">${myRank >= 0 ? '#' + (myRank + 1) : '—'}</div><div class="pr-l">Rank in your box</div></div>
      </div>

      <div class="card">
        <label class="field"><span class="lbl">Invite a friend by email</span>
          <input type="email" id="refEmail" placeholder="friend@email.com" autocomplete="off" /></label>
        <button class="btn-primary" id="sendInvite">Send invite</button>
        <div id="inviteOut"></div>
        <div class="error" id="refErr"></div>
      </div>

      <div class="sec-title">Your invites (${data.joined_count} joined · ${data.pending_count} pending)</div>
      <div id="myRefs"></div>

      <div class="sec-title">🏆 Top referrers in your box</div>
      <div id="refBoard"></div>
    </div>
  `);
  content.appendChild(wrap);

  const myRefsEl = wrap.querySelector('#myRefs');
  if (!data.referrals.length) myRefsEl.appendChild(el('<div class="muted-note">No invites yet — send your first above.</div>'));
  data.referrals.forEach((r) => myRefsEl.appendChild(el(`
    <div class="list-row">
      <div class="lr-main"><div class="nm">${escapeHtml(r.referred_name || r.referred_email)}</div>
        <div class="meta">${r.status === 'joined' ? `joined · +${r.points_awarded} pts` : 'invite pending'}</div></div>
      <div class="${r.status === 'joined' ? 'pill-hot' : 'pill-warn'}">${r.status === 'joined' ? 'Joined' : 'Pending'}</div>
    </div>`)));

  const boardEl = wrap.querySelector('#refBoard');
  if (!leaders.length) boardEl.appendChild(el('<div class="muted-note">No referrals in your box yet.</div>'));
  leaders.slice(0, 10).forEach((l, i) => boardEl.appendChild(el(`
    <div class="lb-row ${l.user_id === userId ? 'me' : ''}">
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-main"><div class="lb-name">${escapeHtml(l.display_name)}${l.user_id === userId ? ' · you' : ''}</div>
        <div class="lb-sub">${l.joined} joined</div></div>
      <div class="lb-score"><div class="s">${l.points}</div><div class="t">pts</div></div>
    </div>`)));

  const err = wrap.querySelector('#refErr');
  const out = wrap.querySelector('#inviteOut');
  const btn = wrap.querySelector('#sendInvite');
  btn.addEventListener('click', async () => {
    err.textContent = ''; out.innerHTML = '';
    const email = wrap.querySelector('#refEmail').value.trim();
    if (!email) { err.textContent = 'Enter a friend\'s email.'; return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('POST', '/api/referrals', { referrerUserId: userId, referredEmail: email });
      showToast('Invite created 🤝');
      out.appendChild(el(`<div class="invite-link">Invite link<br/><b>${escapeHtml(r.invite_url)}</b></div>`));
      wrap.querySelector('#refEmail').value = '';
      btn.disabled = false; btn.textContent = 'Send invite';
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Send invite'; }
  });
  wrap.querySelector('#back').addEventListener('click', () => setView('community'));
}

// ---- Global community (cross-box) -------------------------------------------
async function ensureFollowing() {
  if (followingSet) return;
  try { followingSet = new Set((await api('GET', `/api/users/${userId}/following`)).following); }
  catch (_) { followingSet = new Set(); }
}
function makeFollowButton(uid) {
  if (uid === userId) return null;
  const following = followingSet.has(uid);
  const btn = el(`<button class="follow-btn ${following ? 'following' : ''}">${following ? 'Following' : '+ Follow'}</button>`);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isF = followingSet.has(uid);
    try {
      await api('POST', '/api/follows', { followerUserId: userId, followeeUserId: uid, action: isF ? 'unfollow' : 'follow' });
      if (isF) followingSet.delete(uid); else followingSet.add(uid);
      btn.classList.toggle('following', !isF); btn.textContent = !isF ? 'Following' : '+ Follow';
    } catch (err) { showToast(err.message); }
  });
  return btn;
}
function globalFeedItemEl(ev) {
  const isCb = ev.type === 'comeback';
  const elevated = ev.is_coach || ev.type === 'announcement';
  const item = el(`
    <div class="feed-item ${isCb ? 'feed-comeback' : ''} ${elevated ? 'feed-elevated' : ''}">
      ${avatarHtml(ev.avatar_url, ev.display_name, 'feed-av')}
      <div class="feed-body">
        <div class="feed-text">${feedText(ev)}</div>
        ${ev.box_name ? `<div class="gf-box">${escapeHtml(ev.box_name)}</div>` : ''}
        <div class="feed-meta">
          <span class="feed-time">${timeAgo(ev.created_at)}</span>
          <button class="kudos">${isCb ? '💪 Lift up' : '👏'} <span class="kudos-n">${ev.kudos}</span></button>
          <span class="gf-follow"></span>
        </div>
      </div>
    </div>`);
  item.querySelector('.kudos').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/feed/${ev.event_id}/kudos`);
      item.querySelector('.kudos-n').textContent = r.kudos;
      item.querySelector('.kudos').classList.add('kudosed');
      if (isCb) showToast(`Lifted up ${ev.display_name.split(' ')[0]} 💪`);
    } catch (e) { showToast(e.message); }
  });
  const fb = makeFollowButton(ev.user_id);
  if (fb) item.querySelector('.gf-follow').appendChild(fb);
  return item;
}

async function renderGlobalInto(container) {
  if (!userId) { container.innerHTML = '<div class="empty">Set up your profile to join the community.</div>'; return; }
  container.innerHTML = '';
  const wrap = el(`
    <div>
      <div class="tabs tabs3" id="gTabs">
        <button data-gt="feed">Feed</button>
        <button data-gt="top">Top</button>
        <button data-gt="following">Following</button>
      </div>
      <div id="gBody"></div>
    </div>`);
  container.appendChild(wrap);
  const t = wrap.querySelector('#gTabs');
  t.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.gt === globalTab));
  t.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; globalTab = b.dataset.gt; renderGlobalInto(container); });
  const body = wrap.querySelector('#gBody');
  await ensureFollowing();
  if (globalTab === 'top') return renderGlobalTop(body);
  if (globalTab === 'following') return renderGlobalFollowing(body);
  return renderGlobalFeed(body);
}

async function renderGlobalFeed(body) {
  body.innerHTML = '<p class="subtitle">Loading…</p>';
  let events, comebacks;
  try {
    [events, comebacks] = await Promise.all([
      api('GET', '/api/global/feed').then((r) => r.events),
      api('GET', '/api/global/comebacks').then((r) => r.comebacks),
    ]);
  } catch (e) { body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  body.innerHTML = '';
  if (comebacks.length) {
    const strip = el(`<div class="comeback-strip"><div class="cb-title">🔥 Comebacks this week</div><div class="cb-list"></div></div>`);
    const cl = strip.querySelector('.cb-list');
    comebacks.forEach((c) => cl.appendChild(el(`<div class="cb-chip"><b>${escapeHtml(c.display_name.split(' ')[0])}</b> is back<span class="cb-box">${escapeHtml(c.box_name || '')}</span></div>`)));
    body.appendChild(strip);
  }
  const list = el('<div></div>'); body.appendChild(list);
  events.forEach((ev) => list.appendChild(globalFeedItemEl(ev)));
}

async function renderGlobalTop(body) {
  body.innerHTML = '<p class="subtitle">Loading…</p>';
  let rows = [], w = null;
  try {
    if (globalScope === 'overall') rows = await api('GET', '/api/global/leaderboard/overall').then((r) => r.results);
    else { w = await ensureWorkout(); rows = await api('GET', `/api/global/leaderboard/today/${w.workout_id}`).then((r) => r.results); }
  } catch (e) { body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  body.innerHTML = '';
  const head = el(`<div>
    <div class="tabs" id="scope"><button data-s="today">Today's WOD</button><button data-s="overall">Overall</button></div>
    <div id="rows"></div></div>`);
  body.appendChild(head);
  const sc = head.querySelector('#scope');
  sc.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === globalScope));
  sc.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; globalScope = b.dataset.s; renderGlobalTop(body); });
  const rowsEl = head.querySelector('#rows');
  if (!rows.length) rowsEl.appendChild(el('<div class="muted-note">No results yet.</div>'));
  rows.forEach((r, i) => {
    const me = r.user_id === userId;
    const row = el(`
      <div class="lb-row ${me ? 'me' : ''}">
        <div class="lb-rank">${i + 1}</div>
        <div class="lb-main"><div class="lb-name">${escapeHtml(r.display_name)}${me ? ' · you' : ''}</div>
          <div class="lb-sub">${escapeHtml(r.box_name || '')}</div></div>
        <div class="lb-score"><div class="s">${globalScope === 'overall' ? r.avg_score : num(r.holistic_score)}</div>
          <div class="t">${globalScope === 'overall' ? 'avg' : fmtTime(r.time_seconds)}</div></div>
        <span class="lb-follow"></span>
      </div>`);
    const fb = makeFollowButton(r.user_id);
    if (fb) row.querySelector('.lb-follow').appendChild(fb);
    rowsEl.appendChild(row);
  });
}

async function renderGlobalFollowing(body) {
  body.innerHTML = '<p class="subtitle">Loading…</p>';
  let events;
  try { events = await api('GET', `/api/users/${userId}/following-feed`).then((r) => r.events); }
  catch (e) { body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  body.innerHTML = '';
  if (!events.length) {
    body.appendChild(el(`<div class="empty">You're not following anyone yet.<br/>Tap <b>+ Follow</b> on athletes in the Feed or Top tabs to build your cross-box feed.</div>`));
    return;
  }
  const list = el('<div></div>'); body.appendChild(list);
  events.forEach((ev) => list.appendChild(globalFeedItemEl(ev)));
}

function openShoutComposer(container, members) {
  if (container.dataset.open === '1') { container.innerHTML = ''; container.dataset.open = '0'; return; }
  container.dataset.open = '1';
  container.innerHTML = '';
  const c = el(`
    <div class="card">
      <label class="field"><span class="lbl">Shout out a teammate</span>
        <input list="shoutMembers" id="shoutTo" placeholder="Who pushed you?" autocomplete="off" />
        <datalist id="shoutMembers">${members.filter((m) => m.user_id !== userId)
          .map((m) => `<option value="${escapeAttr(m.display_name)}"></option>`).join('')}</datalist></label>
      <label class="field"><span class="lbl">Message</span>
        <input type="text" id="shoutText" placeholder="thanks for pushing me through Murph!" /></label>
      <button class="btn-primary" id="postShout">Post shout-out 🙌</button>
      <div class="error" id="shoutErr"></div>
    </div>`);
  container.appendChild(c);
  c.querySelector('#postShout').addEventListener('click', async () => {
    const err = c.querySelector('#shoutErr'); err.textContent = '';
    const toName = c.querySelector('#shoutTo').value.trim();
    const text = c.querySelector('#shoutText').value.trim();
    const m = members.find((x) => x.display_name === toName);
    if (!m) { err.textContent = 'Pick a teammate from the list.'; return; }
    if (!text) { err.textContent = 'Add a short message.'; return; }
    try {
      await api('POST', '/api/shoutout', { fromUserId: userId, toUserId: m.user_id, text });
      showToast('Shout-out posted 🙌'); container.innerHTML = ''; container.dataset.open = '0';
    } catch (e) { err.textContent = e.message; }
  });
}

async function renderSquadDetail(squadId) {
  setScreenName('Squad');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let w, board, quiet, feed;
  try {
    w = await ensureWorkout();
    [board, quiet, feed] = await Promise.all([
      api('GET', `/api/squads/${squadId}/leaderboard/${w.workout_id}`),
      api('GET', `/api/squads/${squadId}/quiet`).then((r) => r.members),
      api('GET', `/api/squads/${squadId}/feed`).then((r) => r.events),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <button class="back-link" id="back">← Community</button>
      <h1 class="title">${escapeHtml(board.squad.name)}</h1>
      <p class="subtitle">Squad · ${escapeHtml(w.name)} today</p>
      <div class="sec-title">Squad leaderboard</div><div id="board"></div>
      ${quiet.length ? '<div class="sec-title">💪 Cheer on your squad</div><div id="quiet"></div>' : ''}
      <div class="sec-title">Squad feed</div><div id="feed"></div>
    </div>
  `);
  content.appendChild(wrap);

  const bEl = wrap.querySelector('#board');
  if (!board.results.length) bEl.appendChild(el(`<div class="muted-note">No one in this squad has logged ${escapeHtml(w.name)} today.</div>`));
  board.results.forEach((r, i) => {
    const me = r.user_id === userId;
    bEl.appendChild(el(`
      <div class="lb-row ${me ? 'me' : ''}">
        <div class="lb-rank">${i + 1}</div>
        <div class="lb-main"><div class="lb-name">${escapeHtml(r.display_name)}${me ? ' · you' : ''}</div>
          <div class="lb-sub">${Math.round(r.rom_pct)}% ROM · ${r.unbroken_sets} unbroken</div></div>
        <div class="lb-score"><div class="s">${num(r.holistic_score)}</div><div class="t">${fmtTime(r.time_seconds)}</div></div>
      </div>`));
  });

  const qEl = wrap.querySelector('#quiet');
  if (qEl) quiet.forEach((m) => {
    const row = el(`<div class="list-row"><div class="lr-main"><div class="nm">${escapeHtml(m.display_name)}</div>
      <div class="meta">${m.days_since == null ? 'hasn’t logged yet' : 'quiet ' + m.days_since + ' days'}</div></div>
      <button class="pill-btn nudge-btn">💪 Send a push</button></div>`);
    row.querySelector('.nudge-btn').addEventListener('click', (e) => {
      showToast(`Push sent to ${m.display_name} 💪`); e.currentTarget.textContent = 'Pushed ✓'; e.currentTarget.disabled = true;
    });
    qEl.appendChild(row);
  });

  const fEl = wrap.querySelector('#feed');
  if (!feed.length) fEl.appendChild(el('<div class="muted-note">No squad activity yet.</div>'));
  feed.forEach((ev) => fEl.appendChild(feedItemEl(ev)));

  wrap.querySelector('#back').addEventListener('click', () => setView('community'));
}

function renderCircleInto(container) {
  const posts = communitySpace === 'all'
    ? COMMUNITY_POSTS
    : COMMUNITY_POSTS.filter((p) => p.space === communitySpace);

  container.innerHTML = '';
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
  container.appendChild(wrap);

  // Space switcher
  wrap.querySelector('#spaceChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-space]'); if (!b) return;
    communitySpace = b.dataset.space; renderCircleInto(container);
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
  if (ownerView === 'business') return renderOwnerBusiness();
  if (ownerView === 'compete') return renderOwnerCompete();
  if (ownerView === 'throwdown') return renderOwnerThrowdown();
  if (ownerView === 'engage') return renderOwnerEngage();
  if (ownerView === 'coaches') return renderManageCoaches();
  return renderOwnerHome();
}

async function renderOwnerHome() {
  setScreenName('Dashboard');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d, goal, aff;
  try {
    [d, goal, aff] = await Promise.all([
      api('GET', `/api/owner/box/${ownerBox.box_id}/dashboard`),
      api('GET', `/api/box/${ownerBox.box_id}/team-goal`).then((r) => r.goal).catch(() => null),
      api('GET', `/api/box/${ownerBox.box_id}/affiliate`).catch(() => null),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

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

      <button class="btn-outline wide" id="toCoaches">🧢 Manage coaches</button>

      ${aff ? `<div class="sec-title">🏅 WurQ affiliate status</div>${affiliateCardHtml(aff)}` : ''}

      ${goal ? `<div class="sec-title">🎯 Team goal</div>${teamGoalCardHtml(goal)}` : ''}

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
  const tc = wrap.querySelector('#toCoaches');
  if (tc) tc.addEventListener('click', () => setOwnerView('coaches'));
}

async function renderManageCoaches() {
  setScreenName('Coaches');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  const boxId = ownerBox.box_id;
  // The acting user must be the box owner; in the demo that's the saved profile.
  const actingUserId = userId;
  let data;
  try { data = await api('GET', `/api/box/${boxId}/manage-coaches`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  const coaches = data.members.filter((m) => m.is_coach || m.is_owner);
  const wrap = el(`
    <div>
      <button class="back-link" id="mcBack">← Back to dashboard</button>
      <h1 class="title">Manage coaches</h1>
      <p class="subtitle">${escapeHtml(ownerBox.name)} · ${coaches.length} on staff</p>
      <div class="action-banner">Tap to promote a member to coach or step them down. Owners always keep coach powers.</div>
      <div id="mcList"></div>
    </div>
  `);
  content.appendChild(wrap);
  wrap.querySelector('#mcBack').addEventListener('click', () => setOwnerView('home'));

  const list = wrap.querySelector('#mcList');
  const render = () => {
    list.innerHTML = '';
    data.members.forEach((m) => {
      const badge = m.is_owner ? '<span class="coach-tag owner-tag">Owner</span>'
        : (m.is_coach ? '<span class="coach-tag">Coach</span>' : '');
      const btn = m.is_owner
        ? '<span class="muted-note">always coach</span>'
        : `<button class="mc-btn ${m.is_coach ? 'demote' : 'promote'}" data-id="${m.user_id}" data-act="${m.is_coach ? 'demote' : 'promote'}">${m.is_coach ? 'Remove coach' : 'Make coach'}</button>`;
      list.appendChild(el(`
        <div class="mc-row ${m.is_coach || m.is_owner ? 'is-coach' : ''}">
          <div class="rr-main"><div class="nm">${escapeHtml(m.display_name)} ${badge}</div></div>
          <div class="mc-action">${btn}</div>
        </div>`));
    });
    list.querySelectorAll('.mc-btn').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id, action = b.dataset.act;
      b.disabled = true; b.textContent = '…';
      try {
        const r = await api('POST', `/api/box/${boxId}/coaches`, { actingUserId, targetUserId: id, action });
        const m = data.members.find((x) => x.user_id === id);
        if (m) m.is_coach = r.is_coach;
        showToast(r.is_coach ? 'Promoted to coach 🧢' : 'Stepped down from coach');
        render();
      } catch (e) { showToast(e.message); b.disabled = false; b.textContent = action === 'demote' ? 'Remove coach' : 'Make coach'; }
    }));
  };
  render();
}

// ---- Owner business dashboard (plain-language financial clarity) -------------
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();

async function renderOwnerBusiness() {
  setScreenName('Business');
  content.innerHTML = '<p class="subtitle">Loading your numbers…</p>';
  const boxId = ownerBox.box_id;
  let d, leaders;
  try {
    [d, leaders] = await Promise.all([
      api('GET', `/api/owner/box/${boxId}/business`),
      api('GET', `/api/box/${boxId}/referral-leaderboard`).then((r) => r.leaders).catch(() => []),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const ch = d.churn, acq = d.acquisition, f = d.funnel;
  const above = d.above_break_even;
  const churnTone = ch.pct <= ch.target ? 'good' : ch.pct <= ch.benchmark ? 'ok' : 'warn';
  const churnMsg = ch.pct <= ch.target ? "that's excellent — well below target"
    : ch.pct <= ch.benchmark ? "you're better than the industry average" : "above the industry average — worth a push";

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Your business</h1>
      <p class="subtitle">Plain numbers, no spreadsheet. We filled in what we know — you tweak the rest.</p>

      <div class="biz-hero ${above >= 0 ? 'good' : 'warn'}">
        <div class="bh-lab">Break-even</div>
        <div class="bh-line">You need <b>${d.break_even ?? '—'}</b> members to cover costs.</div>
        <div class="bh-big">You have <b>${d.members}</b> — ${above >= 0 ? `<span class="up">${above} above break-even 🎉</span>` : `<span class="down">${Math.abs(above)} short</span>`}</div>
      </div>

      <div class="biz-grid">
        <div class="biz-stat"><div class="bs-v">${money(d.revenue)}</div><div class="bs-l">Monthly revenue</div></div>
        <div class="biz-stat"><div class="bs-v">${money(d.overhead)}</div><div class="bs-l">Monthly overhead</div></div>
        <div class="biz-stat ${d.profit >= 0 ? 'pos' : 'neg'}"><div class="bs-v">${money(d.profit)}</div><div class="bs-l">Monthly margin (${d.margin_pct}%)</div></div>
      </div>

      <div class="sec-title">🔁 Keeping members (retention)</div>
      <div class="card biz-churn ${churnTone}">
        <div class="churn-row">
          <div class="churn-big">${ch.pct}%</div>
          <div class="churn-meta"><div class="cm-1">monthly churn</div><div class="cm-2">${ch.retention_pct}% retention · ${ch.lapsed} of ${ch.established} went quiet</div></div>
        </div>
        <div class="churn-scale"><span class="cs-target">target &lt;${ch.target}%</span><span class="cs-bench">industry ~${ch.benchmark}%</span></div>
        <div class="churn-msg">${churnMsg}. Keeping a member costs <b>5–25× less</b> than finding a new one — small retention wins pay off big.</div>
      </div>

      <div class="sec-title">📣 Cost to get a member (CAC)</div>
      <div class="card">
        <div class="cac-row"><div class="cac-v">${acq.cac != null ? money(acq.cac) : '—'}</div>
          <div class="cac-l">per new member<br/><span class="muted-note">${money(acq.marketing_spend)} marketing ÷ ${acq.new_members} new this month</span></div></div>
        <div class="cac-ref">🤝 <b>${acq.referred_new}</b> of your ${acq.new_members} new members came from referrals — a referred member costs you <b>almost nothing</b>. It's your cheapest, best channel.</div>
      </div>

      <div class="sec-title">🌱 Member-driven growth (referral funnel)</div>
      <div class="funnel">
        <div class="fn-step"><div class="fn-v">${f.invites}</div><div class="fn-l">invites sent</div></div>
        <div class="fn-arrow">→</div>
        <div class="fn-step"><div class="fn-v">${f.pending}</div><div class="fn-l">pending</div></div>
        <div class="fn-arrow">→</div>
        <div class="fn-step joined"><div class="fn-v">${f.joined}</div><div class="fn-l">joined</div></div>
      </div>
      <div class="sec-title">🏆 Top recruiters</div>
      <div id="recruiters"></div>

      <div class="sec-title">⚙️ Your inputs <span class="muted-note" style="font-weight:400">tap to adjust</span></div>
      <button class="btn-outline wide" id="editInputs">Edit costs &amp; pricing</button>
      <div id="inputsForm"></div>
    </div>`);
  content.appendChild(wrap);

  const rEl = wrap.querySelector('#recruiters');
  const recr = leaders.filter((l) => l.joined > 0).slice(0, 6);
  if (!recr.length) rEl.appendChild(el('<div class="muted-note">No referrals yet — encourage members to invite friends.</div>'));
  recr.forEach((l, i) => rEl.appendChild(el(`
    <div class="lb-row"><div class="lb-rank">${i + 1}</div>
      <div class="lb-main"><div class="lb-name">${escapeHtml(l.display_name)}</div><div class="lb-sub">${l.joined} joined</div></div>
      <div class="lb-score"><div class="s">${l.points}</div><div class="t">pts</div></div></div>`)));

  wrap.querySelector('#editInputs').addEventListener('click', () => {
    const host = wrap.querySelector('#inputsForm');
    if (host.childElementCount) { host.innerHTML = ''; return; }
    const i = d.inputs;
    const fld = (k, lbl, hint) => `<label class="field"><span class="lbl">${lbl}</span>
      <input type="number" min="0" id="bf_${k}" value="${Math.round(i[k])}" />${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
    host.appendChild(el(`<div class="card">
      ${fld('rent', 'Rent / month', 'usually the big one')}
      ${fld('staff', 'Staff / month')}
      ${fld('insurance', 'Insurance / month')}
      ${fld('equipment', 'Equipment / month')}
      ${fld('affiliate_fee', 'CrossFit affiliate fee / month')}
      ${fld('software', 'Software / month')}
      ${fld('membership_price', 'Average membership price')}
      ${fld('marketing_spend', 'Marketing spend / month')}
      <button class="btn-primary" id="saveBf">Save &amp; recompute</button>
      <div class="error" id="bfErr"></div>
    </div>`));
    host.querySelector('#saveBf').addEventListener('click', async () => {
      const payload = {};
      ['rent', 'staff', 'insurance', 'equipment', 'affiliate_fee', 'software', 'membership_price', 'marketing_spend']
        .forEach((k) => { payload[k] = Number(host.querySelector(`#bf_${k}`).value); });
      try { await api('PUT', `/api/owner/box/${boxId}/business`, payload); showToast('Updated ✓'); renderOwnerBusiness(); }
      catch (e) { host.querySelector('#bfErr').textContent = e.message; }
    });
  });
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

// ---- Coach tools ------------------------------------------------------------
async function renderCoach() {
  setScreenName('Coach');
  if (!profile || !profile.box_id) { needBoxPrompt('Set your gym / box to use coach tools.'); return; }
  const boxId = profile.box_id;
  content.innerHTML = '<p class="subtitle">Loading roster…</p>';
  let roster, commits;
  try {
    [roster, commits] = await Promise.all([
      api('GET', `/api/box/${boxId}/roster?userId=${userId}`),
      api('GET', `/api/box/${boxId}/commitments?userId=${userId}`).catch(() => null),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <button class="back-link" id="cBack">← Back to profile</button>
      <h1 class="title">Coach tools</h1>
      <p class="subtitle">${escapeHtml(profile.box_name || profile.gym_name || 'Your box')}</p>

      <div class="coach-stats">
        <div class="cstat"><div class="n">${roster.logged_today}</div><div class="l">trained today</div></div>
        <div class="cstat"><div class="n">${roster.total}</div><div class="l">athletes</div></div>
        <div class="cstat warn"><div class="n">${roster.quiet_count}</div><div class="l">going quiet</div></div>
      </div>

      <div class="sec-title">🏋 Program today's WOD</div>
      <div class="card">
        <label class="field"><span class="lbl">WOD name ★</span>
          <input type="text" id="wName" placeholder="e.g. Fran" maxlength="60" /></label>
        <label class="field"><span class="lbl">Format</span>
          <input type="text" id="wType" placeholder="e.g. For Time" /></label>
        <label class="field"><span class="lbl">Description</span>
          <textarea id="wDesc" placeholder="21-15-9 Thrusters &amp; Pull-ups"></textarea></label>
        <label class="field"><span class="lbl">Scaling</span>
          <textarea id="wScale" placeholder="Scaled: 65/45 lb, banded pull-ups"></textarea></label>
        <button class="btn-primary" id="wSave">Program WOD</button>
        <div class="error" id="wErr"></div>
      </div>

      <div class="sec-title">📣 Message the box</div>
      <div class="card">
        <textarea id="annText" placeholder="Drop an announcement everyone will see in the feed…" maxlength="500"></textarea>
        <button class="btn-primary" id="annSave">Post announcement</button>
        <div class="error" id="annErr"></div>
      </div>

      ${commits ? `<div class="sec-title">🎯 Accountability</div>
      <div class="coach-stats">
        <div class="cstat"><div class="n">${commits.summary.active}</div><div class="l">committed</div></div>
        <div class="cstat"><div class="n">${commits.summary.kept}</div><div class="l">kept</div></div>
        <div class="cstat warn"><div class="n">${commits.summary.at_risk}</div><div class="l">missed · at-risk</div></div>
      </div>
      <div class="card">
        <label class="field"><span class="lbl">Ask an athlete to commit</span>
          <select id="askWho"><option value="">Choose a member…</option></select></label>
        <label class="field"><span class="lbl">Commitment</span>
          <select id="askWhat">
            <option value="2">2× per week</option>
            <option value="3">3× per week</option>
          </select></label>
        <button class="btn-primary" id="askSend">Ask to commit</button>
        <div class="error" id="askErr"></div>
      </div>
      ${commits.missed.length ? '<div class="sub-lab danger-title">⚠ Missed — reach out</div><div id="atRisk"></div>' : ''}
      ${commits.active.length ? '<div class="sub-lab">In flight</div><div id="cActive"></div>' : ''}` : ''}

      <div class="sec-title">👥 My athletes <span class="muted-note" style="font-weight:400">tap for detail</span></div>
      <div id="roster"></div>
    </div>
  `);
  content.appendChild(wrap);

  wrap.querySelector('#cBack').addEventListener('click', () => renderRichProfile());

  if (commits) {
    const sel = wrap.querySelector('#askWho');
    roster.members.filter((m) => !m.is_coach).forEach((m) => sel.appendChild(el(`<option value="${m.user_id}">${escapeHtml(m.display_name)}</option>`)));
    const askErr = wrap.querySelector('#askErr');
    wrap.querySelector('#askSend').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      askErr.textContent = '';
      const who = sel.value, n = wrap.querySelector('#askWhat').value;
      if (!who) { askErr.textContent = 'Pick a member.'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await api('POST', '/api/commitments/coach-request', { coachId: userId, userId: who, type: 'weekly_count', target: `Coach asked: ${n}x/week`, goalCount: Number(n) });
        showToast('Ask sent — they\'ll accept or decline 🙌');
        btn.textContent = 'Asked ✓'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Ask to commit'; }, 1500);
      } catch (err) { askErr.textContent = err.message; btn.disabled = false; btn.textContent = 'Ask to commit'; }
    });
    const ar = wrap.querySelector('#atRisk');
    if (ar) commits.missed.slice(0, 8).forEach((c) => ar.appendChild(el(`
      <div class="list-row warn"><div class="lr-main"><div class="nm">${escapeHtml(c.display_name)}</div>
        <div class="meta">missed: ${escapeHtml(c.target)}</div></div><div class="pill-warn">at-risk</div></div>`)));
    const ca = wrap.querySelector('#cActive');
    if (ca) commits.active.slice(0, 10).forEach((c) => ca.appendChild(el(`
      <div class="list-row"><div class="lr-main"><div class="nm">${escapeHtml(c.display_name)}${c.created_by === 'coach' ? ' <span class="coach-ask-tag">coach ask</span>' : ''}</div>
        <div class="meta">${escapeHtml(c.target)} · ${c.progress || 0}/${c.goal}</div></div><div class="pill-hot">${c.progress || 0}/${c.goal}</div></div>`)));
  }

  // Pre-fill from today's programmed WOD if any.
  (async () => {
    try {
      const w = await api('GET', '/api/wod/today');
      if (w && w.name) {
        wrap.querySelector('#wName').value = w.name || '';
        wrap.querySelector('#wType').value = w.type || '';
        wrap.querySelector('#wDesc').value = w.description || '';
        wrap.querySelector('#wScale').value = w.scaling || '';
      }
    } catch (_) { /* best effort */ }
  })();

  const wSave = wrap.querySelector('#wSave'), wErr = wrap.querySelector('#wErr');
  wSave.addEventListener('click', async () => {
    wErr.textContent = '';
    const payload = {
      actingUserId: userId,
      name: wrap.querySelector('#wName').value.trim(),
      type: wrap.querySelector('#wType').value.trim(),
      description: wrap.querySelector('#wDesc').value.trim(),
      scaling: wrap.querySelector('#wScale').value.trim(),
    };
    wSave.disabled = true; wSave.textContent = 'Programming…';
    try {
      await api('POST', `/api/box/${boxId}/wod`, payload);
      showToast('WOD programmed ✓ — shown as “programmed by you”');
      wSave.textContent = 'Programmed ✓';
      setTimeout(() => { wSave.disabled = false; wSave.textContent = 'Program WOD'; }, 1500);
    } catch (e) { wErr.textContent = e.message; wSave.disabled = false; wSave.textContent = 'Program WOD'; }
  });

  const annSave = wrap.querySelector('#annSave'), annErr = wrap.querySelector('#annErr');
  annSave.addEventListener('click', async () => {
    annErr.textContent = '';
    const text = wrap.querySelector('#annText').value.trim();
    if (!text) { annErr.textContent = 'Write something to announce.'; return; }
    annSave.disabled = true; annSave.textContent = 'Posting…';
    try {
      await api('POST', `/api/box/${boxId}/announce`, { actingUserId: userId, text });
      showToast('Announcement posted to the box 📣');
      wrap.querySelector('#annText').value = '';
      annSave.textContent = 'Posted ✓';
      setTimeout(() => { annSave.disabled = false; annSave.textContent = 'Post announcement'; }, 1500);
    } catch (e) { annErr.textContent = e.message; annSave.disabled = false; annSave.textContent = 'Post announcement'; }
  });

  const rosterEl = wrap.querySelector('#roster');
  if (!roster.members.length) rosterEl.appendChild(el('<div class="empty">No athletes in this box yet.</div>'));
  roster.members.forEach((m) => {
    const trend = (m.week_avg != null && m.prev_avg != null)
      ? `<span class="delta ${m.week_avg >= m.prev_avg ? 'up' : 'down'}">${m.week_avg >= m.prev_avg ? '▲' : '▼'} ${Math.abs(Math.round((m.week_avg - m.prev_avg) * 10) / 10)}</span>`
      : '';
    const status = m.logged_today
      ? '<span class="pill-hot">trained today</span>'
      : (m.quiet ? `<span class="pill-warn">${m.days_since == null ? 'no logs' : m.days_since + 'd quiet'}</span>` : '');
    const tags = [];
    if (m.is_coach) tags.push('<span class="coach-tag">Coach</span>');
    if (m.under_connected) tags.push('<span class="conn-warn">⚠ ' + m.connection_count + ' connections</span>');
    const row = el(`
      <div class="roster-row">
        <div class="rr-main">
          <div class="nm">${escapeHtml(m.display_name)} ${tags.join(' ')}</div>
          <div class="meta">${m.sessions} logged · week avg ${m.week_avg ?? '—'} ${trend} · ${m.connection_count} connections</div>
        </div>
        <div class="rr-status">${status}</div>
      </div>`);
    row.addEventListener('click', () => renderRichProfile(m.user_id, { readOnly: true, back: () => renderCoach() }));
    rosterEl.appendChild(row);
  });
}

// ---- Connection-driven onboarding -------------------------------------------
async function renderOnboarding() {
  setScreenName('Welcome');
  content.innerHTML = '<p class="subtitle">Setting up your crew…</p>';
  let d;
  try { d = await api('GET', `/api/users/${userId}/onboarding`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  if (!d.box) { renderRichProfile(); return; }
  await ensureFollowing();

  const finish = () => { showToast('You\'re all set — welcome to the crew! 🎉'); renderRichProfile(); };

  content.innerHTML = '';
  const wrap = el(`
    <div>
      <h1 class="title">Welcome to ${escapeHtml(d.box.name)} 👋</h1>
      <p class="subtitle">Let's get you connected — athletes with a crew stick around.</p>

      <div class="ob-step">
        <div class="ob-head"><span class="ob-num">1</span> Your box</div>
        <div class="card ob-card">You're training at <b>${escapeHtml(d.box.name)}</b>. This is your home community.</div>
      </div>

      <div class="ob-step">
        <div class="ob-head"><span class="ob-num">2</span> Join the new crew</div>
        <div class="card ob-card">
          <div><b>${escapeHtml(d.cohort.name)}</b><div class="muted-note">${d.cohort.member_count} members finding their feet together</div></div>
          <span class="pill-hot" id="cohortBadge">Joined ✓</span>
        </div>
      </div>

      <div class="ob-step">
        <div class="ob-head"><span class="ob-num">3</span> Follow a few people</div>
        <div class="muted-note" style="margin-bottom:8px">Follow 3–5 to fill your feed with familiar faces.</div>
        <div id="obSuggest"></div>
      </div>

      ${d.coaches.length ? `<div class="ob-step">
        <div class="ob-head"><span class="ob-num">4</span> Meet your coaches</div>
        <div id="obCoaches"></div>
      </div>` : ''}

      <div class="ob-step">
        <div class="ob-head"><span class="ob-num">${d.coaches.length ? 5 : 4}</span> Connect your WurQ app</div>
        <div class="card ob-card" id="obWurq">
          <div><b>Sync workouts automatically</b><div class="muted-note" id="obWurqState">Link WurQ so every workout lands here with full sensor metrics.</div></div>
          <button class="btn-primary" id="obWurqBtn" style="width:auto">Connect</button>
        </div>
      </div>

      <button class="btn-primary" id="obDone">I'm ready — let's go</button>
      <div class="center" style="margin-top:10px"><button class="link" id="obSkip">Skip for now</button></div>
    </div>
  `);
  content.appendChild(wrap);

  const sg = wrap.querySelector('#obSuggest');
  if (!d.suggestions.length) sg.appendChild(el('<div class="empty">No suggestions yet — check back as your box grows.</div>'));
  d.suggestions.forEach((s) => {
    const row = el(`
      <div class="ob-person">
        ${avatarHtml(null, s.display_name, 'feed-av')}
        <div class="op-id"><div class="nm">${escapeHtml(s.display_name)}${s.is_coach ? ' <span class="coach-tag">Coach</span>' : ''}</div></div>
        <span class="op-follow"></span>
      </div>`);
    const fb = makeFollowButton(s.user_id);
    if (fb) row.querySelector('.op-follow').appendChild(fb);
    sg.appendChild(row);
  });

  const cc = wrap.querySelector('#obCoaches');
  if (cc) d.coaches.forEach((c) => {
    const row = el(`
      <div class="ob-person">
        ${avatarHtml(null, c.display_name, 'feed-av')}
        <div class="op-id"><div class="nm">${escapeHtml(c.display_name)} <span class="coach-tag">Coach</span></div></div>
        <span class="op-follow"></span>
      </div>`);
    const fb = makeFollowButton(c.user_id);
    if (fb) row.querySelector('.op-follow').appendChild(fb);
    cc.appendChild(row);
  });

  // WurQ connect step (mock OAuth). Reflects the connected state in place.
  const obWurqBtn = wrap.querySelector('#obWurqBtn');
  const paintWurq = () => {
    if (profile && profile.wurq_connected) {
      wrap.querySelector('#obWurqState').innerHTML = '<span class="wurq-dot"></span> Connected — workouts sync automatically';
      obWurqBtn.textContent = 'Connected ✓'; obWurqBtn.disabled = true;
    }
  };
  paintWurq();
  obWurqBtn.addEventListener('click', () => openWurqConnect(paintWurq));

  wrap.querySelector('#obDone').addEventListener('click', finish);
  wrap.querySelector('#obSkip').addEventListener('click', () => renderRichProfile());
}

// ============================================================================
// Compete — recurring competitions + performance-based matchmaking
// ============================================================================
function fmtRemaining(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'ended';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d left`;
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60000))}m left`;
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function scopeBadge(c) {
  return c.scope === 'box'
    ? `<span class="scope-badge box">${escapeHtml(c.box_name || 'Your box')}</span>`
    : `<span class="scope-badge comm">Community</span>`;
}

function renderCompete() {
  setScreenName('Compete');
  if (!userId) return setView('profile');
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <div class="tabs" id="competeTabs">
        <button data-tab="comps">🏆 Competitions</button>
        <button data-tab="people">🤝 Find people</button>
      </div>
      <div id="competeBody"></div>
    </div>`);
  content.appendChild(wrap);
  const tabs = wrap.querySelector('#competeTabs');
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === competeTab));
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; competeTab = b.dataset.tab; renderCompete(); });
  const body = wrap.querySelector('#competeBody');
  if (competeTab === 'people') return renderMatchesInto(body);
  return renderCompetitionsInto(body);
}

function compCard(c) {
  const me = c.me;
  const rankStr = me ? `${ordinal(me.rank)} / ${me.total}` : '—';
  const meClass = me && me.rank <= 3 ? 'podium' : '';
  const leader = c.leader ? `🥇 ${escapeHtml(c.leader.display_name)}` : '';
  const unitVal = me ? `<span class="cc-val">${num(me.value)}<span class="cc-unit"> ${escapeHtml(c.unit)}</span></span>` : '';
  return `
    <div class="comp-card" data-id="${c.id}">
      <div class="cc-top">
        <div class="cc-icon">${c.icon || '🏅'}</div>
        <div class="cc-head">
          <div class="cc-title">${escapeHtml(c.title)}</div>
          <div class="cc-meta">${scopeBadge(c)} <span class="cc-rem">⏳ ${fmtRemaining(c.ends_at)}</span></div>
        </div>
      </div>
      <div class="cc-bottom">
        <div class="cc-rank ${meClass}">${me ? `You're <b>${rankStr}</b>` : '<span class="muted-note">Log to enter</span>'}</div>
        ${unitVal}
      </div>
      ${leader ? `<div class="cc-leader">${leader}${c.leader && c.leader.box_name ? ` · ${escapeHtml(c.leader.box_name)}` : ''}</div>` : ''}
    </div>`;
}

async function renderCompetitionsInto(container) {
  container.innerHTML = '<p class="subtitle">Loading competitions…</p>';
  let standings, list;
  try {
    [standings, list] = await Promise.all([
      api('GET', `/api/users/${userId}/competitions`).then((r) => r.standings),
      api('GET', `/api/competitions?userId=${userId}`),
    ]);
  } catch (e) { container.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const comps = list.competitions || [];
  const winners = list.winners || [];
  const weekly = comps.filter((c) => c.cadence === 'weekly');
  const monthly = comps.filter((c) => c.cadence === 'monthly');
  // Best placement first, so even non-elite athletes see themselves winning something.
  const best = standings.slice().sort((a, b) => a.rank - b.rank)[0];

  container.innerHTML = '';
  const wrap = el(`
    <div>
      ${best ? `<div class="stand-hero">
        <div class="sh-lab">You're winning something 🎉</div>
        <div class="sh-big">${ordinal(best.rank)}<span class="sh-of"> of ${best.total}</span></div>
        <div class="sh-title">${best.icon || ''} ${escapeHtml(best.title)}</div>
      </div>` : ''}

      ${standings.length ? `<div class="sec-title">Your standings</div><div class="stand-strip" id="strip"></div>` : ''}

      <div class="sec-title">📅 This week</div>
      <div id="weekly"></div>

      <div class="sec-title">🗓️ This month</div>
      <div id="monthly"></div>

      ${winners.length ? `<div class="sec-title">🏆 Recent champions</div><div id="winners"></div>` : ''}
    </div>`);
  container.appendChild(wrap);

  const strip = wrap.querySelector('#strip');
  if (strip) standings.forEach((s) => {
    const chip = el(`<div class="stand-chip ${s.rank <= 3 ? 'podium' : ''}">
      <div class="sc-rank">${ordinal(s.rank)}</div>
      <div class="sc-title">${escapeHtml(s.type_label)}</div>
      <div class="sc-sub">${escapeHtml(s.cadence)} · ${s.scope === 'box' ? 'box' : 'community'}</div>
    </div>`);
    chip.addEventListener('click', () => renderCompetitionDetail(s.id));
    strip.appendChild(chip);
  });

  const wkEl = wrap.querySelector('#weekly');
  if (!weekly.length) wkEl.appendChild(el('<div class="muted-note">No weekly competitions right now.</div>'));
  weekly.forEach((c) => { const node = el(compCard(c)); node.addEventListener('click', () => renderCompetitionDetail(c.id)); wkEl.appendChild(node); });

  const moEl = wrap.querySelector('#monthly');
  if (!monthly.length) moEl.appendChild(el('<div class="muted-note">No monthly competitions right now.</div>'));
  monthly.forEach((c) => { const node = el(compCard(c)); node.addEventListener('click', () => renderCompetitionDetail(c.id)); moEl.appendChild(node); });

  const winEl = wrap.querySelector('#winners');
  if (winEl) winners.forEach((w) => winEl.appendChild(el(`
    <div class="winner-row">
      <div class="wr-medal">🏅</div>
      <div class="wr-main"><div class="nm">${escapeHtml(w.winner ? w.winner.display_name : 'TBD')}</div>
        <div class="meta">${escapeHtml(w.title)}</div></div>
      ${w.winner && w.winner.box_name ? `<div class="wr-box">${escapeHtml(w.winner.box_name)}</div>` : ''}
    </div>`)));
}

async function renderCompetitionDetail(id) {
  setScreenName('Competition');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d;
  try { d = await api('GET', `/api/competitions/${id}/leaderboard?userId=${userId}`); }
  catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  const c = d.competition;
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <button class="back-link" id="back">← Competitions</button>
      <h1 class="title">${c.icon || ''} ${escapeHtml(c.title)}</h1>
      <p class="subtitle">${scopeBadge(c)} · ${escapeHtml(c.cadence)} · ⏳ ${c.status === 'completed' ? 'ended' : fmtRemaining(c.ends_at)} · ${d.total} athletes</p>
      ${c.movement ? `<div class="muted-note" style="margin-bottom:8px">Scored on ${escapeHtml(c.movement)} volume</div>` : ''}
      ${d.me ? `<div class="action-banner">You're <b>${ordinal(d.me.rank)}</b> of ${d.me.total} — <b>${num(d.me.value)}</b> ${escapeHtml(c.unit)}.</div>` : ''}
      <div id="lb"></div>
    </div>`);
  content.appendChild(wrap);
  const lb = wrap.querySelector('#lb');
  if (!d.leaderboard.length) lb.appendChild(el('<div class="empty">No results in this window yet.</div>'));
  d.leaderboard.forEach((r) => {
    const meRow = r.user_id === userId;
    lb.appendChild(el(`
      <div class="lb-row ${meRow ? 'me' : ''} ${r.rank <= 3 ? 'podium' : ''}">
        <div class="lb-rank">${r.rank}</div>
        <div class="lb-main"><div class="lb-name">${escapeHtml(r.display_name)}${r.is_coach ? ' <span class="coach-tag">Coach</span>' : ''}${meRow ? ' · you' : ''}</div>
          <div class="lb-sub">${escapeHtml(r.box_name || '')}</div></div>
        <div class="lb-score"><div class="s">${num(r.value)}</div><div class="t">${escapeHtml(c.unit)}</div></div>
      </div>`));
  });
  wrap.querySelector('#back').addEventListener('click', () => setView('compete'));
}

// ---- Find your people (matchmaking) -----------------------------------------
const BASIS_META = {
  similar_performance: { tag: '⚡ Similar pace', cls: 'b-perf' },
  shared_struggle:     { tag: '🎯 Shared goal', cls: 'b-strug' },
  similar_journey:     { tag: '🧭 Same journey', cls: 'b-jrny' },
};

async function renderMatchesInto(container) {
  container.innerHTML = '<p class="subtitle">Finding your people…</p>';
  await ensureFollowing();
  let m, partners, h2h;
  try {
    [m, partners, h2h] = await Promise.all([
      api('GET', `/api/users/${userId}/matches`),
      api('GET', `/api/users/${userId}/training-partners`).then((r) => r.partners),
      api('GET', `/api/users/${userId}/head-to-heads`).then((r) => r.head_to_heads),
    ]);
  } catch (e) { container.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  container.innerHTML = '';
  const wrap = el(`
    <div>
      <p class="subtitle" style="margin-top:4px">Every connection is a reason to come back. Here's who you'd click with.</p>
      ${h2h.length ? `<div class="sec-title">⚔️ Head-to-head</div><div id="h2h"></div>` : ''}
      ${partners.length ? `<div class="sec-title">🤝 Your training partners</div><div id="partners"></div>` : ''}
      <div class="sec-title">✨ Suggested matches</div>
      <div id="matches"></div>
    </div>`);
  container.appendChild(wrap);

  // Head-to-head
  const h2hEl = wrap.querySelector('#h2h');
  if (h2hEl) h2h.forEach((h) => {
    const total = (h.my_value + h.opp_value) || 1;
    const myPct = Math.round((h.my_value / total) * 100);
    const leading = h.status === 'completed'
      ? (h.winner_user_id ? (h.my_value >= h.opp_value ? 'You won 🏆' : `${h.opponent.display_name.split(' ')[0]} won`) : 'Final')
      : (h.my_value >= h.opp_value ? 'You lead' : 'Behind');
    h2hEl.appendChild(el(`
      <div class="h2h-card ${h.status}">
        <div class="h2h-head"><span>vs <b>${escapeHtml(h.opponent.display_name)}</b> · ${escapeHtml(h.opponent.box_name || '')}</span>
          <span class="h2h-state">${h.status === 'active' ? `⏳ ${h.ends_in_days}d` : '✓ done'}</span></div>
        <div class="h2h-bar"><span class="h2h-fill" style="width:${myPct}%"></span></div>
        <div class="h2h-nums"><span>You <b>${num(h.my_value)}</b></span><span class="h2h-lead">${leading}</span><span><b>${num(h.opp_value)}</b> them</span></div>
        <div class="h2h-foot muted-note">${escapeHtml(h.unit)}</div>
      </div>`));
  });

  // Training partners
  const pEl = wrap.querySelector('#partners');
  if (pEl) partners.forEach((p) => {
    pEl.appendChild(el(`
      <div class="partner-row">
        ${avatarHtml(p.avatar_url, p.display_name, 'feed-av')}
        <div class="pr-main"><div class="nm">${escapeHtml(p.display_name)}</div>
          <div class="meta">${escapeHtml(p.box_name || '')}${p.basis ? ' · ' + escapeHtml(p.basis) : ''}</div>
          <div class="meta partner-note">🔔 You'll be notified when they train${p.last_trained ? ` · last ${timeAgo(p.last_trained)}` : ''}</div></div>
      </div>`));
  });

  // Suggested matches
  const mEl = wrap.querySelector('#matches');
  if (!m.matches.length) { mEl.appendChild(el('<div class="empty">Log a few workouts and we\'ll find your people.</div>')); return; }
  m.matches.forEach((mt) => {
    const bm = BASIS_META[mt.basis] || { tag: 'Match', cls: '' };
    const card = el(`
      <div class="match-card">
        <div class="mc-head">
          ${avatarHtml(null, mt.display_name, 'feed-av')}
          <div class="mc-id">
            <div class="nm">${escapeHtml(mt.display_name)}${mt.is_coach ? ' <span class="coach-tag">Coach</span>' : ''}</div>
            <div class="meta">${escapeHtml(mt.box_name || '')} ${mt.same_box ? '<span class="same-box">· your box</span>' : '<span class="x-box">· cross-box</span>'}</div>
          </div>
          <span class="basis-chip ${bm.cls}">${bm.tag}</span>
        </div>
        <div class="match-reason">"${escapeHtml(mt.reason)}"</div>
        <div class="match-actions">
          <button class="m-act hi" data-act="hi">✋ High-five</button>
          <button class="m-act fol ${mt.following ? 'done' : ''}" data-act="follow">${mt.following ? '✓ Following' : '+ Follow'}</button>
          <button class="m-act part" data-act="partner">🤝 Partner</button>
        </div>
        <button class="m-challenge" data-act="challenge">⚔️ Challenge head-to-head next week</button>
      </div>`);
    card.querySelector('[data-act="hi"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // capture before await (currentTarget nulls out)
      try { await api('POST', '/api/highfive', { fromUserId: userId, toUserId: mt.user_id }); showToast(`High-fived ${mt.display_name.split(' ')[0]} ✋`); btn.textContent = '✓ High-fived'; btn.disabled = true; }
      catch (err) { showToast(err.message); }
    });
    const folBtn = card.querySelector('[data-act="follow"]');
    folBtn.addEventListener('click', async () => {
      const isF = followingSet.has(mt.user_id);
      try {
        await api('POST', '/api/follows', { followerUserId: userId, followeeUserId: mt.user_id, action: isF ? 'unfollow' : 'follow' });
        if (isF) followingSet.delete(mt.user_id); else followingSet.add(mt.user_id);
        folBtn.classList.toggle('done', !isF); folBtn.textContent = !isF ? '✓ Following' : '+ Follow';
      } catch (err) { showToast(err.message); }
    });
    card.querySelector('[data-act="partner"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await api('POST', '/api/training-partners', { aUserId: userId, bUserId: mt.user_id, basis: mt.reason });
        showToast(`You and ${mt.display_name.split(' ')[0]} are training partners 🤝`);
        btn.textContent = '✓ Partners'; btn.disabled = true;
      } catch (err) { showToast(err.message); }
    });
    card.querySelector('[data-act="challenge"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const start = new Date(); start.setDate(start.getDate() + 1);
      const end = new Date(); end.setDate(end.getDate() + 8);
      try {
        await api('POST', '/api/head-to-heads', { aUserId: userId, bUserId: mt.user_id, metric: 'highest_avg', startsAt: start.toISOString(), endsAt: end.toISOString() });
        showToast(`Head-to-head started vs ${mt.display_name.split(' ')[0]} ⚔️`);
        btn.textContent = '✓ Challenge sent'; btn.disabled = true;
      } catch (err) { showToast(err.message); }
    });
    mEl.appendChild(card);
  });
}

// ============================================================================
// Commitments — public accountability for members
// ============================================================================
const COMMIT_PRESETS = [
  { type: 'session', target: "I'll be at 5am tomorrow 💪", goalCount: 1, period: 'day', label: '🌅 5am tomorrow' },
  { type: 'weekly_count', target: 'Commit to 2x this week', goalCount: 2, period: 'week', label: '2× this week' },
  { type: 'weekly_count', target: 'Commit to 3x this week', goalCount: 3, period: 'week', label: '3× this week' },
  { type: 'streak', target: '30-day streak', goalCount: 30, period: 'month', label: '🔥 30-day streak' },
];

async function renderCommitments() {
  setScreenName('Commitments');
  if (!userId) return setView('profile');
  content.innerHTML = '<p class="subtitle">Loading…</p>';
  let d, stats;
  try {
    [d, stats] = await Promise.all([
      api('GET', `/api/users/${userId}/commitments`),
      profile && profile.box_id ? api('GET', `/api/box/${profile.box_id}/commitment-stats`) : Promise.resolve(null),
    ]);
  } catch (e) { content.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }

  const active = d.commitments.filter((c) => c.status === 'active');
  const history = d.commitments.filter((c) => c.status === 'kept' || c.status === 'missed');
  content.innerHTML = '';
  const wrap = el(`
    <div>
      <button class="back-link" id="cmBack">← Community</button>
      <h1 class="title">Commitments</h1>
      <p class="subtitle">Say it out loud — public commitments get kept.</p>

      ${stats ? `<div class="rally">🔥 <b>${stats.committed}</b> member${stats.committed === 1 ? '' : 's'} committed this week · <b>${stats.kept_this_week}</b> kept so far</div>` : ''}

      <div class="commit-mine">
        <div class="cmi"><div class="cmi-v">${d.follow_through_rate == null ? '—' : d.follow_through_rate + '%'}</div><div class="cmi-l">follow-through</div></div>
        <div class="cmi"><div class="cmi-v">${d.active_count}</div><div class="cmi-l">active</div></div>
        <div class="cmi"><div class="cmi-v">${d.kept_count}</div><div class="cmi-l">kept</div></div>
      </div>

      ${d.pending.length ? `<div class="sec-title">🙋 Your coach asked</div><div id="pending"></div>` : ''}

      <div class="sec-title">Make a commitment</div>
      <div class="commit-presets" id="presets"></div>
      <div class="card">
        <label class="field"><span class="lbl">Or write your own</span>
          <input type="text" id="cmText" placeholder="e.g. I'll PR my back squat this month" maxlength="120" /></label>
        <button class="btn-primary" id="cmSave">Commit publicly</button>
        <div class="error" id="cmErr"></div>
      </div>

      <div class="sec-title">Your active commitments</div>
      <div id="active"></div>
      ${history.length ? `<div class="sec-title">History</div><div id="history"></div>` : ''}
    </div>`);
  content.appendChild(wrap);
  wrap.querySelector('#cmBack').addEventListener('click', () => setView('community'));

  // Pending coach requests — accept / decline.
  const pEl = wrap.querySelector('#pending');
  if (pEl) d.pending.forEach((c) => {
    const row = el(`
      <div class="card commit-pending">
        <div class="cp-text">Coach <b>${escapeHtml(c.coach_name || 'Coach')}</b> asks: <b>${escapeHtml(c.target)}</b></div>
        <div class="cp-actions"><button class="btn-primary" data-a="accept">Accept</button><button class="btn-outline" data-a="decline">Decline</button></div>
      </div>`);
    row.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
      try { await api('POST', `/api/commitments/${c.id}/respond`, { userId, action: btn.dataset.a });
        showToast(btn.dataset.a === 'accept' ? 'Committed ✊' : 'Declined'); renderCommitments(); }
      catch (e) { showToast(e.message); }
    }));
    pEl.appendChild(row);
  });

  // Quick presets.
  const prEl = wrap.querySelector('#presets');
  COMMIT_PRESETS.forEach((p) => {
    const b = el(`<button class="preset-chip">${escapeHtml(p.label)}</button>`);
    b.addEventListener('click', () => makeCommitment(p));
    prEl.appendChild(b);
  });
  async function makeCommitment(payload) {
    try { await api('POST', '/api/commitments', { userId, ...payload }); showToast('Committed publicly ✊'); renderCommitments(); }
    catch (e) { showToast(e.message); }
  }
  wrap.querySelector('#cmSave').addEventListener('click', () => {
    const text = wrap.querySelector('#cmText').value.trim();
    if (!text) { wrap.querySelector('#cmErr').textContent = 'Write what you\'re committing to.'; return; }
    makeCommitment({ type: 'custom', target: text, goalCount: 1, period: 'week' });
  });

  const aEl = wrap.querySelector('#active');
  if (!active.length) aEl.appendChild(el('<div class="muted-note">No active commitments — make one above.</div>'));
  active.forEach((c) => {
    const pct = Math.min(100, Math.round(((c.progress || 0) / (c.goal || 1)) * 100));
    aEl.appendChild(el(`
      <div class="commit-row">
        <div class="cr-main"><div class="nm">${escapeHtml(c.target)}${c.created_by === 'coach' ? ' <span class="coach-ask-tag">coach</span>' : ''}</div>
          <div class="commit-bar"><span style="width:${pct}%"></span></div>
          <div class="meta">${c.progress || 0} / ${c.goal} · due ${fmtRemaining(c.due_at)}</div></div>
      </div>`));
  });

  const hEl = wrap.querySelector('#history');
  if (hEl) history.forEach((c) => hEl.appendChild(el(`
    <div class="commit-row ${c.status}">
      <div class="cr-main"><div class="nm">${escapeHtml(c.target)}</div>
        <div class="meta">${c.status === 'kept' ? '✓ kept' : '✗ missed'}</div></div>
      <div class="${c.status === 'kept' ? 'pill-hot' : 'pill-warn'}">${c.status === 'kept' ? 'kept 🎯' : 'missed'}</div>
    </div>`)));
}

// ---- bootstrap --------------------------------------------------------------
async function loadProfile() {
  followingSet = null; // refresh follow state for this login
  try { profile = await api('GET', `/api/profile/${userId}`); }
  catch (e) { localStorage.removeItem(STORAGE_KEY); userId = null; profile = null; }
  go();
}

renderNav();
updateRoleToggle();
if (userId) loadProfile(); else go();
