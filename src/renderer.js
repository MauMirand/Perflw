'use strict';
/* Perflw renderer — planner design (Calendar, Whim, Routine, Activities, Analytics, Chat, Home, Settings) */
(() => {
  // ───────────────────────── helpers
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MON3 = MONTHS.map(m => m.slice(0, 3));
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const PLAN_COLORS = ['#FF4F6B','#3B82F6','#F5A524','#A855F7','#2DD4BF'];
  const PREFS_KEY = 'perflw-ui-v2';
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => iso(new Date());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const longDate = s => { const d = parse(s); return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const initials = name => (name || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';

  const PATH = {
    calendar: '<rect x="3" y="4" width="14" height="14" rx="2"/><line x1="3" y1="9" x2="17" y2="9"/><line x1="7" y1="2" x2="7" y2="6"/><line x1="13" y1="2" x2="13" y2="6"/>',
    whim: '<path d="M15 10c0-3.314-2.686-6-6-6S3 6.686 3 10c0 2 .857 3.79 2.2 5h7.6A5.978 5.978 0 0 0 15 10zM7 17h6M10 14.5V17" transform="translate(1 0)"/>',
    folder: '<path d="M2 6a2 2 0 0 1 2-2h3.172a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 10.828 6H16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/>',
    model: '<rect x="4" y="4" width="12" height="12" rx="2.5"/><path d="M8 8h4v4H8zM10 2v2M10 16v2M2 10h2M16 10h2"/>',
    panel: '<rect x="3" y="4" width="14" height="12" rx="2"/><line x1="12" y1="4" x2="12" y2="16"/>',
    chatplus: '<path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8l-4 3v-3H5a2 2 0 0 1-2-2V5z"/><path d="M10 6v4M8 8h4"/>',
    routine: '<path d="M7 9l3 3L18 4M17 11v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h9" transform="translate(1 0.5) scale(.95)"/>',
    learning: '<path d="M10 4 2 8l8 4 8-4-8-4z"/><path d="M5 10v4c0 1 2 2 5 2s5-1 5-2v-4"/><path d="M18 8v5"/>',
    activities: '<path d="M17.5 3.5a5 5 0 0 0-7 0L10 4.6l-.5-.6a5 5 0 0 0-7 7L10 18l7.5-7a5 5 0 0 0 0-7.5z"/>',
    analytics: '<path d="M2 2v16h16M6 13l3.5-5 3.5 3.5 4-6"/>',
    chat: '<path d="M3.5 4.5h13v9h-8l-4 3v-3h-1z"/>',
    home: '<path d="M3 9.5 10 3l7 6.5V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z"/>',
    settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M2.5 10h2M15.5 10h2M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>',
    clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.8V10l2.8 1.8"/>',
    plus: '<line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/>',
    x: '<line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/>',
    left: '<polyline points="12,5 7,10 12,15"/>',
    right: '<polyline points="8,5 13,10 8,15"/>',
    down: '<polyline points="5,8 10,13 15,8"/>',
    grip: '<circle cx="7.5" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.5" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="7.5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.5" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.5" cy="15" r="1.3" fill="currentColor" stroke="none"/>',
    edit: '<path d="M13.5 3.5a1.5 1.5 0 0 1 2 2L6 15l-3 .8.8-3L13.5 3.5z"/>',
    image: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m4 15 4-4 3 3 2-2 3 3"/>',
    camera: '<path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h2L8 3.5h4l1.5 2h2A1.5 1.5 0 0 1 17 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/><circle cx="10" cy="10.5" r="2.8"/>',
    archive: '<path d="M3 4h14v4H3zM4.5 8v8h11V8M8.5 11h3"/>',
    trash: '<path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10"/>',
    send: '<path d="M3 10 17 3l-4 14-3-6z"/><path d="m10 11 7-8"/>',
    logout: '<path d="M8 3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3M13 14l4-4-4-4M17 10H8"/>',
    user: '<circle cx="10" cy="7" r="3"/><path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/>',
    search: '<circle cx="8.5" cy="8.5" r="5"/><line x1="13" y1="13" x2="17.5" y2="17.5"/>',
    page: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M12 2.5V6h3.5"/>',
    undo: '<path d="M7 5 3 9l4 4"/><path d="M3 9h9a5 5 0 0 1 0 10h-2"/>',
    unarchive: '<path d="M3 4h14v4H3zM4.5 8v8h11V8M10 15v-5M7.8 12.2 10 10l2.2 2.2"/>',
    flow: '<rect x="2.5" y="3" width="5.5" height="5" rx="1.3"/><rect x="12" y="12" width="5.5" height="5" rx="1.3"/><path d="M8 5.5h4.7a2 2 0 0 1 2 2V12"/>',
    skill: '<path d="M10 2.8l1.9 4.1 4.5.5-3.4 3 1 4.4L10 12.5l-4 2.3 1-4.4-3.4-3 4.5-.5z"/>',
    agent: '<rect x="4" y="7" width="12" height="9.5" rx="2.6"/><path d="M10 7V4.4M7.6 11.2v1.3M12.4 11.2v1.3"/><circle cx="10" cy="3.4" r="1"/>'
  };
  const icon = (name, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${PATH[name] || ''}</svg>`;

  // ───────────────────────── preferences
  const DEFAULT_PREFS = { collapsed: false, calView: 'month', weekStart: 0, timeFormat: '12', motion: 'auto', view: 'calendar', chatCat: 'work', chatOutput: true, homeLayout: null, navGroups: {} };
  let prefs = { ...DEFAULT_PREFS };
  try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { /* storage unavailable */ }
  if (!prefs.navGroups || typeof prefs.navGroups !== 'object' || Array.isArray(prefs.navGroups)) prefs.navGroups = {};
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
  const reduceMotion = () => prefs.motion === 'on' || (prefs.motion === 'auto' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function applyMotionPref() {
    document.body.classList.toggle('motion-off', prefs.motion === 'on');
    document.body.classList.toggle('motion-on', prefs.motion === 'off');
  }
  const fmtTime = hhmm => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    if (prefs.timeFormat === '24') return `${pad(h)}:${pad(m)}`;
    return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const hourLabel = h => prefs.timeFormat === '24' ? `${pad(h)}:00` : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  const clockOf = isoString => { const d = new Date(isoString); return fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`); };
  const stamp = isoString => { const d = new Date(isoString); const day = iso(d); const label = day === todayISO() ? 'Today' : day === addDays(todayISO(), -1) ? 'Yesterday' : `${MON3[d.getMonth()]} ${d.getDate()}`; return `${label}, ${clockOf(isoString)}`; };

  // Agentic Automation lives in automation.js; it registers the Workflows and Agents views.
  const AF = window.PerflwAutomation || null;
  // Chat sessions (messages, live progress, model / workflow / skill controls) live in chat.js.
  const CH = window.PerflwChat && window.PerflwChat.ready() ? window.PerflwChat : null;
  // Project pages (upper project tabs and the block editor) live in projects.js. Calendar stays its own page.
  const PJ = window.PerflwProjects || null;
  const SB = window.PerflwSchedules || null;
  const LN = window.PerflwLearning || null;
  // Today page card order (pure layout rules) lives in home-layout.js.
  const HL = window.PerflwHomeLayout;

  // ───────────────────────── state
  const now = new Date();
  const S = {
    user: null, version: '',
    view: 'calendar', selected: iso(now), year: now.getFullYear(), month: now.getMonth(),
    items: { plan: [], whim: [], routine: [], activity: [], learning: [] },
    chats: [], archivedChats: [], showArchived: false, activeChat: null, messages: {},
    editing: null, renamingChat: false, editingProfile: false, justAdded: null, planTime: '', scrollToMorning: true,
    lastToday: iso(now)
  };

  // ───────────────────────── toasts / confirm
  function toast(message, { error = false, action = null, timeout = 4200 } = {}) {
    const box = document.createElement('div');
    box.className = `toast${error ? ' error' : ''}`;
    box.setAttribute('role', error ? 'alert' : 'status');
    const text = document.createElement('span'); text.textContent = message; box.append(text);
    let timer;
    const close = () => { clearTimeout(timer); box.remove(); };
    if (action) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
      button.addEventListener('click', () => { close(); action.run(); });
      box.append(button);
    }
    $('#toasts').append(box);
    timer = setTimeout(close, timeout);
  }
  async function api(task, quiet = false) {
    try { return await task(); }
    catch (error) {
      if (!quiet) toast(error.message || 'Something went wrong.', { error: true });
      throw error;
    }
  }
  function confirmDialog({ title, text, ok = 'Delete' }) {
    return new Promise(resolve => {
      const overlay = $('#confirm-overlay');
      $('#confirm-title').textContent = title;
      $('#confirm-text').textContent = text;
      $('#confirm-ok').textContent = ok;
      overlay.hidden = false;
      const previous = document.activeElement;
      $('#confirm-cancel').focus();
      const finish = value => {
        overlay.hidden = true; overlay.onclick = null; $('#confirm-ok').onclick = null; $('#confirm-cancel').onclick = null;
        document.removeEventListener('keydown', onKey, true);
        if (previous && previous.isConnected) previous.focus();
        resolve(value);
      };
      const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); finish(false); } };
      document.addEventListener('keydown', onKey, true);
      $('#confirm-ok').onclick = () => finish(true);
      $('#confirm-cancel').onclick = () => finish(false);
      overlay.onclick = event => { if (event.target === overlay) finish(false); };
    });
  }

  // ───────────────────────── window chrome
  function setMaxIcon(maximized) {
    const button = $('[data-window="maximize"]');
    button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    button.innerHTML = maximized
      ? '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="7" height="7" rx="1.5"/><path d="M4.5 4.5V3.8A1.3 1.3 0 0 1 5.8 2.5h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3h-.7"/></svg>'
      : '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" rx="2"/></svg>';
  }
  function initWindowControls() {
    const controls = window.windowControls;
    if (!controls) { $$('.wm-btn').forEach(button => { button.hidden = true; }); return; }
    $$('[data-window]').forEach(button => button.addEventListener('click', () => {
      const action = button.dataset.window;
      if (action === 'minimize') controls.minimize();
      else if (action === 'maximize') controls.toggleMaximize().then(setMaxIcon).catch(() => {});
      else if (action === 'close') controls.close();
    }));
    $('.wm-drag').addEventListener('dblclick', () => controls.toggleMaximize().then(setMaxIcon).catch(() => {}));
    controls.onMaximizeChange(setMaxIcon);
    controls.isMaximized().then(setMaxIcon).catch(() => {});
    controls.version().then(v => { S.version = v; }).catch(() => {});
  }

  // ───────────────────────── auth scenes
  const SCENES = ['loading-page', 'login-page', 'register-page', 'profile-page', 'main-page'];
  let currentScene = 'loading-page';
  function showScene(id) {
    // Between Sign in and Create account only the form moves (sideways, in reading order); the brand panel stays.
    const swap = ['login-page', 'register-page'].includes(currentScene) && ['login-page', 'register-page'].includes(id) && currentScene !== id;
    SCENES.forEach(scene => { $(`#${scene}`).hidden = scene !== id; });
    const el = $(`#${id}`);
    el.classList.remove('auth-swap', 'from-left', 'from-right');
    if (swap) { void el.offsetWidth; el.classList.add('auth-swap', id === 'register-page' ? 'from-right' : 'from-left'); }
    currentScene = id;
    document.body.classList.toggle('is-auth', id !== 'main-page');
    const heading = $(`#${id} h1`);
    if (heading) heading.focus({ preventScroll: true });
  }
  function feedback(form, message) {
    const box = $('.form-feedback', form);
    box.textContent = message || '';
    box.hidden = !message;
    if (message) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
  }
  /* Submit buttons show a small spinner and stay disabled while the account call runs. */
  function busy(form, on) {
    form.classList.toggle('is-busy', on);
    const submit = $('[type=submit]', form); if (submit) { submit.disabled = on; submit.setAttribute('aria-busy', String(on)); }
  }
  /* Create account: the four password rules tick as they are met; the confirmation shows when it matches. */
  const PW_RULES = { length: v => v.length >= 12 && v.length <= 128, upper: v => /[A-Z]/.test(v), lower: v => /[a-z]/.test(v), number: v => /\d/.test(v) };
  function paintPasswordRules() {
    const form = $('#register-form'); if (!form) return;
    const value = form.password.value;
    $$('[data-rule]', form).forEach(li => { const met = PW_RULES[li.dataset.rule](value); li.classList.toggle('met', met); const state = $('.sr-only', li); if (state) state.textContent = met ? ', met' : ', not met'; });
    const match = $('[data-match]', form);
    if (match) match.classList.toggle('matches', !!form.confirmation.value && form.confirmation.value === value);
  }
  async function route(state) {
    S.user = state && state.user ? state.user : null;
    if (!S.user) { closeLayers(); showScene('login-page'); return; }
    if (!S.user.profileCompleted) { prepareProfileForm(); showScene('profile-page'); return; }
    showScene('main-page');
    await loadWorkspace();
  }
  let pendingImage = null;
  function paintAvatar(element, image, name) {
    element.style.backgroundImage = image ? `url("${image}")` : '';
    element.textContent = image ? '' : initials(name);
  }
  function prepareProfileForm() {
    pendingImage = S.user.imageName ? { imageName: S.user.imageName, image: S.user.image } : null;
    $('#profile-name').value = S.user.displayName || '';
    $('#profile-bio').value = S.user.bio || '';
    paintAvatar($('#profile-preview'), pendingImage && pendingImage.image, S.user.displayName || S.user.email);
  }
  function bindAuth() {
    $$('.password-toggle').forEach(button => button.addEventListener('click', () => {
      const input = button.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const label = show ? 'Hide password' : 'Show password';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', label); button.title = label;
      input.focus({ preventScroll: true });
    }));
    // Caps Lock note under a password field while it has focus.
    $$('.auth-form input[type="password"]').forEach(input => {
      const hint = $('.caps-hint', input.closest('.auth-field'));
      const check = event => { if (hint && event.getModifierState) hint.hidden = !event.getModifierState('CapsLock'); };
      input.addEventListener('keydown', check); input.addEventListener('keyup', check);
      input.addEventListener('blur', () => { if (hint) hint.hidden = true; });
    });
    $('#register-form').addEventListener('input', paintPasswordRules);
    $$('.auth-form').forEach(form => form.addEventListener('input', () => { const box = $('.form-feedback', form); if (!box.hidden) feedback(form, ''); }));
    $$('[data-auth]').forEach(button => button.addEventListener('click', () => {
      const target = button.dataset.auth === 'register' ? 'register-page' : 'login-page';
      $$('.auth-scene form').forEach(form => feedback(form, ''));
      // The email typed on one form carries over to the other.
      const from = target === 'register-page' ? $('#login-email') : $('#register-email');
      const to = target === 'register-page' ? $('#register-email') : $('#login-email');
      if (from.value && !to.value) to.value = from.value;
      showScene(target);
    }));
    $('#login-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      feedback(form, ''); busy(form, true);
      try { await route(await window.account.login(form.email.value, form.password.value)); form.reset(); }
      catch (error) { feedback(form, error.message); }
      finally { busy(form, false); }
    });
    $('#register-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      feedback(form, ''); busy(form, true);
      try { await route(await window.account.register(form.email.value, form.password.value, form.confirmation.value)); form.reset(); paintPasswordRules(); }
      catch (error) { feedback(form, error.message); }
      finally { busy(form, false); }
    });
    $('#pick-image').addEventListener('click', async () => {
      const form = $('#profile-form');
      try {
        const picked = await window.account.pickImage();
        if (picked) { pendingImage = picked; paintAvatar($('#profile-preview'), picked.image, ''); }
      } catch (error) { feedback(form, error.message); }
    });
    $('#profile-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget; const submit = $('[type=submit]', form);
      feedback(form, ''); submit.disabled = true;
      try {
        const u = S.user;
        await route(await window.account.saveProfile(form.displayName.value, form.bio.value, pendingImage ? pendingImage.imageName : null, u.coverImageName || null, u.coverTheme || 'aurora', u.coverPosition || 'center 52%'));
      } catch (error) { feedback(form, error.message); }
      finally { submit.disabled = false; }
    });
  }
  async function logout() {
    closeLayers();
    if (PJ && !(await PJ.settleAll())) return;
    // Study marks still waiting to be saved are written while the account is still signed in.
    if (window.PerflwAnnotate) await window.PerflwAnnotate.flush();
    try { await route(await window.account.logout()); }
    catch (error) { toast(error.message, { error: true }); }
    S.items = { plan: [], whim: [], routine: [], activity: [], learning: [] }; S.chats = []; S.archivedChats = []; S.messages = {}; S.activeChat = null;
    if (AF) AF.reset();
    if (CH) CH.reset();
    if (PJ) PJ.reset();
    if (SB) SB.reset();
    if (LN) LN.reset();
  }

  // ───────────────────────── data
  async function loadWorkspace() {
    try {
      const [items, chats, archived] = await Promise.all([
        window.plannerData.items(), window.workspaceData.chats(false), window.workspaceData.chats(true)
      ]);
      S.items = { plan: [], whim: [], routine: [], activity: [], learning: [] };
      for (const item of items) S.items[item.kind].push(item);
      S.chats = chats; S.archivedChats = archived;
    } catch (error) { toast(error.message || 'Your workspace could not be loaded.', { error: true }); }
    if (PJ) { await PJ.load(S.user.id); S.items.whim = []; }
    if (SB) await SB.load();
    if (LN) await LN.load();
    S.view =['calendar','whim','routine','learning','activities','analytics','chat','home','settings','automation','agents','skills'].includes(prefs.view) ? prefs.view : 'calendar';
    S.scrollToMorning = true;
    renderAll(true);
  }
  const plansFor = day => S.items.plan.filter(p => p.day === day).sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1; if (b.time) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const routineDone = item => item.doneOn === todayISO();

  async function createItem(item, { focus } = {}) {
    const created = await api(() => window.plannerData.create(item));
    S.items[created.kind].push(created);
    S.justAdded = created.id;
    rerender({ focus });
    return created;
  }
  async function updateItem(id, changes) {
    const updated = await api(() => window.plannerData.update(id, changes));
    const list = S.items[updated.kind];
    const index = list.findIndex(x => x.id === id);
    if (index >= 0) list[index] = updated;
    rerender();
    return updated;
  }
  async function removeItem(id, label = 'Item') {
    const item = Object.values(S.items).flat().find(x => x.id === id);
    if (!item) return;
    await api(() => window.plannerData.remove(id));
    S.items[item.kind] = S.items[item.kind].filter(x => x.id !== id);
    if (S.editing === id) S.editing = null;
    rerender();
    toast(`${label} removed.`, { action: { label: 'Undo', run: () => restoreItem(item) } });
  }
  async function restoreItem(item) {
    const created = await api(() => window.plannerData.create({ kind: item.kind, text: item.text, day: item.day, time: item.time, at: item.kind === 'activity' ? item.createdAt : undefined }));
    if (item.doneOn) {
      const updated = await api(() => window.plannerData.update(created.id, { doneOn: item.doneOn }));
      S.items[updated.kind].push(updated);
    } else S.items[created.kind].push(created);
    rerender();
  }

  // ───────────────────────── navigation & rendering
  let swapTimer = null;
  function go(view, { focus, force = false } = {}) {
    // Leaving the Agents or Skills page with unsaved file or settings edits asks first.
    if (!force && AF && view !== S.view && (S.view === 'agents' || S.view === 'skills') && AF.hasUnsaved()) {
      confirmDialog({ title: 'Discard unsaved changes?', text: 'Your edits have not been saved.' }).then(ok => { if (ok) { AF.discardUnsaved(); go(view, { focus, force: true }); } });
      return;
    }
    closeLayers();
    cancelHomeDrag(true); // a Today card held mid-drag goes back without saving
    if (view === S.view && !focus) return;
    if (PJ && S.view === 'whim' && view !== 'whim') PJ.flush(); // project edits stay in their tab; this only saves them
    clearTimeout(swapTimer);
    const stage = $('#stage');
    const apply = () => {
      if (SB) SB.close();
      S.view = view; S.editing = null; S.renamingChat = false; S.editingProfile = false;
      prefs.view = view; savePrefs();
      if (view === 'calendar') S.scrollToMorning = true;
      renderAll(true);
      revealNavGroupOf(view);
      $('#main-panel').scrollTop = 0;
      if (focus) focusLater(focus);
    };
    if (view === S.view || reduceMotion()) { apply(); return; }
    stage.className = 'stage view-out';
    swapTimer = setTimeout(apply, 120);
  }
  function focusLater(id) { requestAnimationFrame(() => { const el = document.getElementById(id); if (el) el.focus(); }); }

  function renderAll(animate = false) {
    renderRail();
    renderSidebar();
    renderStage(animate);
  }
  function rerender({ focus } = {}) {
    const panel = $('#main-panel');
    const grid = $('.timegrid-scroll');
    const active = document.activeElement;
    const restore = active && active.dataset && active.dataset.action && active.dataset.id ? `[data-action="${active.dataset.action}"][data-id="${CSS.escape(active.dataset.id)}"]` : null;
    const keep = { main: panel.scrollTop, grid: grid ? grid.scrollTop : null, list: $('.plan-list') ? $('.plan-list').scrollTop : null, msgs: $('.chat-messages') ? $('.chat-messages').scrollTop : null };
    renderSidebar(false);
    renderStage(false);
    panel.scrollTop = keep.main;
    const newGrid = $('.timegrid-scroll'); if (newGrid && keep.grid !== null) newGrid.scrollTop = keep.grid;
    const newList = $('.plan-list'); if (newList && keep.list !== null) newList.scrollTop = keep.list;
    if (focus) { const el = document.getElementById(focus); if (el) el.focus(); }
    else if (restore && !document.querySelector('[data-autofocus]')) { const el = document.querySelector(restore); if (el) el.focus(); }
  }
  function applyDynamic(root) {
    $$('[data-w]', root).forEach(el => { el.style.width = el.dataset.w; });
    $$('[data-h]', root).forEach(el => { el.style.height = el.dataset.h; });
    $$('[data-accent]', root).forEach(el => { el.style.borderLeftColor = el.dataset.accent; });
    $$('[data-dot]', root).forEach(el => { el.style.background = el.dataset.dot; });
    $$('[data-img]', root).forEach(el => { el.style.backgroundImage = el.dataset.img ? `url("${el.dataset.img}")` : ''; });
    $$('[data-bgpos]', root).forEach(el => { el.style.backgroundPosition = el.dataset.bgpos; });
  }

  function renderRail() {
    $$('.rail [data-go]').forEach(button => button.classList.toggle('active', button.dataset.go === S.view));
    const avatar = $('#rail-avatar');
    if (S.user) paintAvatar(avatar, S.user.image, S.user.displayName);
  }

  function navItem(view, label, iconName, tag = '') {
    const active = S.view === view;
    return `<button class="nav-item${active ? ' active' : ''}" type="button" data-go="${view}"${active ? ' aria-current="page"' : ''}>${icon(iconName)}<span>${esc(label)}</span>${tag ? `<small class="nav-item-tag">(${esc(tag)})</small>` : ''}</button>`;
  }
  function navIcon(view, label, iconName) {
    const active = S.view === view;
    return `<button class="nav-icon-btn${active ? ' active' : ''}" type="button" data-go="${view}" data-tip="${esc(label)}" aria-label="${esc(label)}"${active ? ' aria-current="page"' : ''}>${icon(iconName)}</button>`;
  }
  function renderSidebar(animate = false) {
    const sel = parse(S.selected);
    const nav = $('#sidebar');
    nav.classList.toggle('collapsed', prefs.collapsed);
    const toggle = $('#sidebar-toggle');
    toggle.setAttribute('aria-label', prefs.collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.setAttribute('aria-expanded', String(!prefs.collapsed));
    const swoop = animate ? ' swoop-in' : '';
    $('#sidebar-body').innerHTML = prefs.collapsed ? `
      <div class="nav-collapsed${swoop}">
        <div class="nav-divider" aria-hidden="true"></div>
        ${navIcon('calendar', 'Calendar', 'calendar')}
        <button class="date-card mini" type="button" data-action="date-card" aria-label="Selected date ${esc(longDate(S.selected))}. Open calendar">
          <span class="dc-day">${sel.getDate()}</span><span class="dc-weekday">${DAYS[sel.getDay()].slice(0, 3)}</span><span class="dc-month">${MON3[sel.getMonth()]}</span>
        </button>
        ${navIcon('routine', 'Routine', 'routine')}
        <div class="nav-divider" aria-hidden="true"></div>
        ${navIcon('learning', 'Learning', 'learning')}
        <div class="nav-divider" aria-hidden="true"></div>
        ${navIcon('whim', 'Projects', 'folder')}
        <div class="nav-divider" aria-hidden="true"></div>
        ${navIcon('automation', 'Workflows', 'flow')}
        ${navIcon('agents', 'Agents', 'agent')}
        ${navIcon('skills', 'Skills', 'skill')}
        <div class="nav-divider" aria-hidden="true"></div>
        ${navIcon('chat', 'Chat sessions', 'chat')}
      </div>` : `
      <div class="nav-expanded${swoop}">
        ${navGroup('plan', 'Plan', `
        ${navItem('calendar', 'Calendar', 'calendar')}
        <button class="date-card" type="button" data-action="date-card" aria-label="Selected date ${esc(longDate(S.selected))}. Open calendar">
          <span class="dc-day">${sel.getDate()}</span>
          <span class="dc-meta"><span class="dc-weekday">${DAYS[sel.getDay()]}</span><span class="dc-month">${MON3[sel.getMonth()]} ${sel.getFullYear()}</span></span>
        </button>
        ${navItem('routine', 'Routine', 'routine')}`)}
        ${navGroup('learn', 'Learn', navItem('learning', 'Learning', 'learning', LN ? LN.profile() : ''))}
        ${navGroup('create', 'Create', navItem('whim', 'Projects', 'folder'))}
        ${navGroup('automate', 'Automate', `${navItem('automation', 'Workflows', 'flow')}${navItem('agents', 'Agents', 'agent')}${navItem('skills', 'Skills', 'skill')}`)}
        ${navGroup('chat', 'Chat sessions', `
        <button class="nav-item" type="button" data-action="new-chat">${icon('chatplus')}<span>New session</span></button>
        ${(() => {
          const pool = (S.showArchived ? S.archivedChats : S.chats).filter(c => catOf(c) === chatCat());
          const rows = pool.slice(0, 6).map(c => `<button class="nav-item${S.view === 'chat' && S.activeChat === c.id ? ' active' : ''}" type="button" data-action="side-chat" data-id="${c.id}" title="${esc(c.title)}">${icon('chat')}<span class="nav-clip">${esc(c.title)}</span></button>`).join('');
          const more = pool.length > 6 ? `<p class="nav-empty">+${pool.length - 6} more · use Search (Ctrl+K)</p>` : '';
          const none = pool.length ? '' : `<p class="nav-empty">No ${S.showArchived ? 'archived ' : ''}${esc(catLabel(chatCat()).toLowerCase())} sessions yet.</p>`;
          const archivedCount = S.archivedChats.filter(c => catOf(c) === chatCat()).length;
          const toggle = S.showArchived || archivedCount ? `<button class="nav-item nav-sub" type="button" data-action="side-archived">${icon(S.showArchived ? 'unarchive' : 'archive')}<span>${S.showArchived ? 'Back to active' : `Archived (${archivedCount})`}</span></button>` : '';
          return rows + more + none + toggle;
        })()}`, `<span class="nav-tag">${esc(catLabel(chatCat()))}</span>`)}
      </div>`;
  }
  // Expanded sidebar groups fold away under their label. Open or closed is saved per device; the collapsed rail is not grouped.
  const NAV_GROUPS = { plan: ['calendar', 'routine'], learn: ['learning'], create: ['whim'], automate: ['automation', 'agents', 'skills'], chat: ['chat'] };
  const navGroupOpen = id => prefs.navGroups[id] !== false;
  function navGroup(id, label, items, extra = '') {
    const open = navGroupOpen(id);
    const hasActive = !open && NAV_GROUPS[id].includes(S.view);
    return `<div class="nav-group" data-group="${id}"><button class="nav-label${hasActive ? ' has-active' : ''}" type="button" data-action="nav-group" data-id="${id}" aria-expanded="${open}" aria-controls="nav-g-${id}"${hasActive ? ' title="Current page is in this group"' : ''}>${esc(label)}${extra}${icon('down', 'class="nav-chev"')}</button><div class="nav-group-body" id="nav-g-${id}" role="group" aria-label="${esc(label)}"${open ? '' : ' hidden'}>${items}</div></div>`;
  }
  /* Opens or closes one group in place (no sidebar repaint), with the same swoop as the sidebar toggle. */
  function setNavGroup(id, open, { save = true } = {}) {
    if (!NAV_GROUPS[id]) return;
    prefs.navGroups = { ...prefs.navGroups, [id]: open };
    if (save) savePrefs();
    const label = document.querySelector(`.nav-label[data-id="${id}"]`);
    const body = document.getElementById(`nav-g-${id}`);
    if (!label || !body) return;
    label.setAttribute('aria-expanded', String(open));
    const active = !open && NAV_GROUPS[id].includes(S.view);
    label.classList.toggle('has-active', active);
    if (active) label.title = 'Current page is in this group'; else label.removeAttribute('title');
    const wasHidden = body.hidden;
    const height = wasHidden ? 0 : body.getBoundingClientRect().height;
    const opacity = wasHidden ? 0 : Number(getComputedStyle(body).opacity);
    const margin = wasHidden ? '0px' : getComputedStyle(body).marginTop;
    body.getAnimations().forEach(a => a.cancel());
    body.classList.remove('anim');
    if (!open && body.contains(document.activeElement)) label.focus({ preventScroll: true }); // focus must not fall to the page
    if (reduceMotion()) { body.hidden = !open; return; }
    body.classList.add('anim');
    if (open) {
      body.hidden = false;
      const target = { height: `${body.scrollHeight}px`, marginTop: getComputedStyle(body).marginTop };
      const run = body.animate([{ height: `${height}px`, opacity, marginTop: margin, transform: wasHidden ? 'translateX(-12px)' : 'none' }, { height: target.height, opacity: 1, marginTop: target.marginTop, transform: 'none' }], { duration: 160, easing: 'ease' });
      run.onfinish = () => { body.classList.remove('anim'); };
    } else {
      if (wasHidden) { body.classList.remove('anim'); return; }
      const run = body.animate([{ height: `${height}px`, opacity, marginTop: margin, transform: 'none' }, { height: '0px', opacity: 0, marginTop: '0px', transform: 'translateX(-16px)' }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
      run.onfinish = () => { body.hidden = true; run.cancel(); body.classList.remove('anim'); };
    }
  }
  /* Going to a page inside a folded group opens that group so the current page is visible. */
  function revealNavGroupOf(view) {
    if (prefs.collapsed) return;
    const id = Object.keys(NAV_GROUPS).find(g => NAV_GROUPS[g].includes(view));
    if (id && !navGroupOpen(id)) setNavGroup(id, true);
  }
  let sidebarTimer = null;
  function toggleSidebar() {
    clearTimeout(sidebarTimer);
    const flip = () => { prefs.collapsed = !prefs.collapsed; savePrefs(); renderSidebar(!reduceMotion()); };
    if (reduceMotion()) { flip(); return; }
    const body = $('#sidebar-body').firstElementChild;
    if (body) body.className = `${body.className.replace(' swoop-in', '')} swoop-out`;
    sidebarTimer = setTimeout(flip, 90);
  }

  const VIEWS = {
    calendar: { render: renderCalendar },
    whim: { title: 'Projects', subtitle: 'Keep every idea and project in one place.', render: () => (PJ ? PJ.render() : '<p class="empty">Projects are unavailable.</p>'), mount: () => { if (PJ) PJ.mount(); } },
    routine: { title: 'Routine', subtitle: 'Your daily checklist. Ticks reset each day.', render: () => renderList('routine') },
    learning: { title: 'Learning', subtitle: 'Subjects you are studying.', render: () => (LN ? LN.render() : '<p class="empty">Learning is unavailable.</p>'), mount: () => { if (LN) LN.mount(); } },
    activities: { title: 'Activities', subtitle: 'Log what you did and when.', render: () => renderList('activity') },
    analytics: { title: 'Analytics', subtitle: 'A quick look at how your days are going.', render: renderAnalytics },
    chat: { title: 'Chat', subtitle: 'Conversations with their own model, workflow and skills.', render: renderChat, mount: () => { if (CH) CH.mount(); } },
    home: { title: 'Today', subtitle: 'Plan, learn, create and automate from one page.', render: renderHome },
    settings: { title: 'Settings', subtitle: 'Manage your preferences for this workspace.', render: renderSettings },
    ...(AF ? AF.views : {})
  };
  function renderStage(animate) {
    const stage = $('#stage');
    const view = VIEWS[S.view] || VIEWS.calendar;
    // A Today card is held or settling: repaint after the drop instead of pulling the page out from under it.
    if (homeDrag && homeDrag.lifted && S.view === 'home') { homeDrag.dirty = true; return; }
    stage.className = `stage${animate && !reduceMotion() ? ' view-in' : ''}`;
    stage.innerHTML = view.render();
    if (view.mount) view.mount(stage);
    applyDynamic(stage);
    if (SB && S.view === 'calendar') SB.mount(stage);
    if (S.justAdded) { const el = stage.querySelector(`[data-id="${CSS.escape(S.justAdded)}"]`); if (el) el.classList.add('item-in'); S.justAdded = null; }
    if (S.view === 'calendar' && S.scrollToMorning) {
      const grid = $('.timegrid-scroll', stage);
      if (grid) { const row = grid.querySelector('[data-hour="6"]'); const allDay = grid.querySelector('[data-hour="all"]'); if (row && allDay) grid.scrollTop += row.getBoundingClientRect().top - grid.getBoundingClientRect().top; S.scrollToMorning = false; }
    }
    if (S.view === 'chat') { const msgs = $('.chat-messages', stage); if (msgs) msgs.scrollTop = msgs.scrollHeight; }
    const editor = stage.querySelector('[data-autofocus]');
    if (editor) { editor.focus(); if (editor.select) editor.select(); }
  }
  const pageHead = (title, subtitle, extra = '') => `<header class="page-head"><div><h1 tabindex="-1">${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${extra}</header>`;

  // ───────────────────────── calendar
  function calLabel() {
    const cv = prefs.calView;
    if (cv === 'month') return `${MONTHS[S.month]} ${S.year}`;
    if (cv === 'day') { const d = parse(S.selected); return `${MON3[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
    const days = weekDays(); const a = parse(days[0]); const b = parse(days[6]);
    return a.getMonth() === b.getMonth() ? `${MON3[a.getMonth()]} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}` : `${MON3[a.getMonth()]} ${a.getDate()} – ${MON3[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  }
  function weekDays() {
    const sel = parse(S.selected);
    const offset = (sel.getDay() - prefs.weekStart + 7) % 7;
    const start = iso(new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() - offset));
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  function selectDate(day) {
    const d = parse(day);
    S.selected = day; S.year = d.getFullYear(); S.month = d.getMonth(); S.editing = null; S.calFocus = null;
  }
  /* Opens Calendar on a date and marks the linked project record (schedule, task, milestone or deadline) there. */
  function openCalendar(day, ref) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day || '')) return;
    selectDate(day); S.calFocus = ref || null; S.scrollToMorning = true;
    if (S.view === 'calendar') rerenderCalendar(); else go('calendar');
  }
  // Project records for a day. They are read from the project tables, never copied into plans.
  const linkedFor = day => (PJ ? PJ.entriesFor(day) : []);
  const LINK_KIND = { schedule: 'Schedule', task: 'Task', milestone: 'Milestone', deadline: 'Deadline' };
  const linkChip = e => `<span class="event-chip linked${e.done ? ' done' : ''}${S.calFocus === e.id ? ' focus' : ''}" role="button" tabindex="0" data-action="open-project" data-id="${esc(e.projectId)}" title="${esc(`${LINK_KIND[e.kind]} · ${e.project}`)}">${e.time ? `${esc(fmtTime(e.time))} ` : ''}${esc(e.title)}</span>`;
  function shiftPeriod(direction) {
    const cv = prefs.calView;
    if (cv === 'month') {
      let m = S.month + direction, y = S.year;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      S.month = m; S.year = y;
      const sel = parse(S.selected);
      if (sel.getMonth() !== m || sel.getFullYear() !== y) {
        const last = new Date(y, m + 1, 0).getDate();
        S.selected = iso(new Date(y, m, Math.min(sel.getDate(), last)));
      }
    } else selectDate(addDays(S.selected, direction * (cv === 'week' ? 7 : 1)));
    rerenderCalendar();
  }
  let calTimer = null;
  function switchCalView(cv) {
    if (prefs.calView === cv) return;
    clearTimeout(calTimer);
    const apply = () => { prefs.calView = cv; savePrefs(); S.scrollToMorning = true; const d = parse(S.selected); S.year = d.getFullYear(); S.month = d.getMonth(); rerender(); };
    const body = $('.cal-body');
    if (!body || reduceMotion()) { apply(); return; }
    body.className = 'cal-body cal-out';
    calTimer = setTimeout(() => { apply(); const next = $('.cal-body'); if (next && !reduceMotion()) next.className = 'cal-body cal-in'; }, 100);
  }
  function rerenderCalendar() { rerender(); renderSidebar(false); }

  function renderCalendar() {
    const cv = prefs.calView;
    const pill = (name, label) => `<button class="toggle-pill${cv === name ? ' active' : ''}" type="button" data-action="cal-view" data-value="${name}" aria-pressed="${cv === name}">${label}</button>`;
    let body = '';
    if (cv === 'month') body = renderMonth();
    else if (cv === 'week') body = renderWeek();
    else body = renderDay();
    return `
      <div class="cal-layout">
        <section class="cal-area" aria-label="Calendar">
          <header class="page-head cal-head"><div><h1 tabindex="-1">Calendar</h1><p class="subtitle">See commitments in time and manage schedule details.</p></div></header>
          <div class="cal-toolbar">
            <div class="cal-nav">
              <button class="icon-btn" type="button" data-action="cal-prev" aria-label="Previous ${cv}">${icon('left')}</button>
              <span class="cal-label" aria-live="polite">${esc(calLabel())}</span>
              <button class="icon-btn" type="button" data-action="cal-next" aria-label="Next ${cv}">${icon('right')}</button>
              <button class="today-btn" type="button" data-action="cal-today">Today</button>
            </div>
            <div class="cal-toolbar-right">
              <button class="icon-btn sm solid timer-btn${SB && SB.timerRunning() ? ' running' : ''}" type="button" data-action="timer" aria-label="Timer" aria-haspopup="dialog" title="Timer">${icon('clock')}</button>
              <div class="toggle-track" role="group" aria-label="Calendar view">${pill('day', 'Days')}${pill('week', 'Weeks')}${pill('month', 'Months')}</div>
            </div>
          </div>
          <div class="cal-body">${body}</div>
        </section>
        ${renderPlanPanel()}
      </div>`;
  }
  function dowOrder() { return Array.from({ length: 7 }, (_, i) => (i + prefs.weekStart) % 7); }
  function renderMonth() {
    const first = new Date(S.year, S.month, 1);
    const offset = (first.getDay() - prefs.weekStart + 7) % 7;
    const today = todayISO();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(S.year, S.month, 1 - offset + i);
      const key = iso(d);
      const plans = S.items.plan.filter(p => p.day === key);
      const n = plans.length;
      const linked = linkedFor(key);
      const cls = ['cell', d.getMonth() !== S.month ? 'outside' : '', key === today ? 'today' : '', key === S.selected ? 'selected' : ''].filter(Boolean).join(' ');
      const dots = plans.slice(0, 5).map((p, idx) => `<span class="cell-dot" data-dot="${PLAN_COLORS[idx % PLAN_COLORS.length]}"></span>`).join('')
        + linked.slice(0, 3).map(() => '<span class="cell-dot linked"></span>').join('')
        + Array.from({ length: Math.min(3, SB ? SB.unlinkedCount(key) : 0) }, () => '<span class="cell-dot sched"></span>').join('');
      cells.push(`<button class="${cls}" type="button" data-action="pick-day" data-day="${key}" aria-label="${esc(`${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${n ? `, ${n} ${n === 1 ? 'plan' : 'plans'}` : ''}${linked.length ? `, ${linked.length} from projects` : ''}`)}" aria-pressed="${key === S.selected}">
        <span>${d.getDate()}</span>
        <span class="cell-foot"><span class="cell-count">${n ? `${n} ${n === 1 ? 'plan' : 'plans'}` : ''}</span><span class="cell-dots">${dots}</span></span>
      </button>`);
    }
    return `<div class="dow-row" aria-hidden="true">${dowOrder().map(i => `<div class="dow">${DAYS[i].slice(0, 3)}</div>`).join('')}</div>
      <div class="month-grid">${cells.join('')}</div>
      <p class="hint month-hint">Tip: double-click a day to open it in Days view.</p>`;
  }
  function chip(plan, idx) {
    return `<span class="event-chip${plan.doneOn ? ' done' : ''}" role="button" tabindex="0" data-action="chip" data-id="${plan.id}" data-day="${plan.day}" data-accent="${PLAN_COLORS[idx % PLAN_COLORS.length]}" title="${esc(`${plan.time ? fmtTime(plan.time) + ' · ' : ''}${plan.text}`)}">${plan.time ? `${esc(fmtTime(plan.time))} ` : ''}${esc(plan.text)}</span>`;
  }
  function hourRows(days, { single = false } = {}) {
    const rows = [];
    const sorted = Object.fromEntries(days.map(day => [day, plansFor(day)]));
    rows.push(`<div class="time-row" data-hour="all"><div class="time-label">All day</div>${days.map(day => {
      const list = sorted[day].map((p, idx) => ({ p, idx })).filter(x => !x.p.time);
      return `<div class="slot" role="button" tabindex="-1" data-action="slot" data-day="${day}" data-time="" aria-label="Add an all-day plan on ${esc(longDate(day))}">${list.map(x => chip(x.p, x.idx)).join('')}${linkedFor(day).filter(e => !e.time).map(linkChip).join('')}</div>`;
    }).join('')}</div>`);
    // Timed hours: click for a 1-hour schedule, drag for any length, right-click to set one (schedule-blocks.js).
    const hours = [];
    for (let h = 0; h < 24; h++) {
      hours.push(`<div class="time-row" data-hour="${h}"><div class="time-label">${hourLabel(h)}</div>${days.map(day => {
        const list = sorted[day].map((p, idx) => ({ p, idx })).filter(x => x.p.time && Number(x.p.time.slice(0, 2)) === h);
        const linked = linkedFor(day).filter(e => e.time && Number(e.time.slice(0, 2)) === h && !(SB && e.kind === 'schedule'));
        return `<div class="slot" role="button" tabindex="-1" data-action="${SB ? 'tslot' : 'slot'}" data-day="${day}" data-time="${pad(h)}:00" aria-label="${SB ? 'Add a schedule' : 'Add a plan'} at ${hourLabel(h)} on ${esc(longDate(day))}">${list.map(x => chip(x.p, x.idx)).join('')}${linked.map(linkChip).join('')}</div>`;
      }).join('')}</div>`);
    }
    rows.push(`<div class="tg-hours">${hours.join('')}${SB ? SB.layerHtml(days) : ''}</div>`);
    return rows.join('');
  }
  function renderWeek() {
    const days = weekDays(); const today = todayISO();
    const heads = days.map(day => {
      const d = parse(day);
      return `<button class="week-day-head${day === S.selected ? ' selected' : ''}${day === today ? ' today' : ''}" type="button" data-action="pick-day" data-day="${day}" aria-pressed="${day === S.selected}" aria-label="${esc(longDate(day))}"><span class="wd-dow">${DAYS[d.getDay()].slice(0, 3)}</span><span class="wd-num">${d.getDate()}</span></button>`;
    }).join('');
    return `<div class="timegrid"><div class="timegrid-head"><div class="gutter"></div>${heads}</div><div class="timegrid-scroll">${hourRows(days)}</div></div>`;
  }
  function renderDay() {
    const today = todayISO();
    const strip = Array.from({ length: 7 }, (_, i) => addDays(S.selected, i - 3)).map(day => {
      const d = parse(day);
      return `<button class="day-pill${day === S.selected ? ' selected' : ''}${day === today ? ' today' : ''}" type="button" data-action="pick-day" data-day="${day}" aria-pressed="${day === S.selected}" aria-label="${esc(longDate(day))}"><span class="dp-dow">${DAYS[d.getDay()].slice(0, 3)}</span><span class="dp-num">${d.getDate()}</span></button>`;
    }).join('');
    return `<div class="day-strip">${strip}</div>
      <div class="timegrid day-grid">
        <div class="day-head">${esc(longDate(S.selected))}</div>
        <div class="timegrid-scroll">${hourRows([S.selected], { single: true })}</div>
      </div>`;
  }
  function renderPlanPanel() {
    const plans = plansFor(S.selected);
    const isToday = S.selected === todayISO();
    const d = parse(S.selected);
    const done = plans.filter(p => p.doneOn).length;
    const rows = plans.map((p, idx) => {
      const color = PLAN_COLORS[idx % PLAN_COLORS.length];
      if (S.editing === p.id) {
        return `<form class="plan" data-form="edit-plan" data-id="${p.id}" data-accent="${color}">
          <div class="plan-main"><input class="field plan-edit" name="text" maxlength="500" value="${esc(p.text)}" aria-label="Plan text" data-autofocus>
          <input class="field plan-edit field-time" name="time" type="time" value="${esc(p.time || '')}" aria-label="Plan time"></div>
          <button class="icon-btn sm" type="submit" aria-label="Save plan">${icon('right')}</button>
        </form>`;
      }
      return `<div class="plan${p.doneOn ? ' done' : ''}" data-id="${p.id}" data-accent="${color}">
        <div class="plan-main">
          <button class="plan-text" type="button" data-action="edit" data-id="${p.id}" title="Click to edit">${esc(p.text)}</button>
          ${p.time ? `<span class="plan-time">${esc(fmtTime(p.time))}</span>` : ''}
        </div>
        <input type="checkbox" class="check" data-action="toggle-plan" data-id="${p.id}" aria-label="Mark “${esc(p.text)}” done" ${p.doneOn ? 'checked' : ''}>
        <button class="icon-btn sm" type="button" data-action="remove" data-id="${p.id}" data-label="Plan" aria-label="Remove “${esc(p.text)}”">${icon('x')}</button>
      </div>`;
    }).join('');
    const pct = plans.length ? Math.round(done / plans.length * 100) : 0;
    const linked = linkedFor(S.selected);
    const linkedHtml = linked.length ? `<div class="linked-list" role="group" aria-label="From projects"><div class="linked-label">From projects</div>${linked.map(e => `<button class="linked-row${e.done ? ' done' : ''}${S.calFocus === e.id ? ' focus' : ''}" type="button" data-action="open-project" data-id="${esc(e.projectId)}" data-ref="${esc(e.id)}" title="Open ${esc(e.project)}"><span class="linked-main"><strong>${esc(e.title)}</strong><small>${LINK_KIND[e.kind]}${e.time ? ` · ${esc(fmtTime(e.time))}` : ''} · ${esc(e.project)}</small></span>${icon('right')}</button>`).join('')}</div>` : '';
    const schedRows = SB ? SB.eventsFor(S.selected).filter(e => !e.project_id) : [];
    const schedHtml = schedRows.length ? `<div class="linked-list" role="group" aria-label="Schedules"><div class="linked-label">Schedules</div>${schedRows.map(e => `<button class="linked-row" type="button" data-sb-open="${esc(e.id)}" title="Edit schedule"><span class="linked-main"><strong>${esc(e.title)}</strong><small>${esc(e.when)}</small></span>${icon('right')}</button>`).join('')}</div>` : '';
    return `<aside class="plan-col" aria-label="Plans for ${esc(longDate(S.selected))}">
      <h1>${isToday ? "Today's Plan" : `${DAYS[d.getDay()]}'s Plan`}</h1>
      <h2>${esc(longDate(S.selected))}</h2>
      <div class="plan-card">
        <div class="plan-list">${plans.length ? rows : (schedRows.length ? '' : '<p class="empty">Nothing planned for this day yet.</p>')}</div>
        ${plans.length ? `<div class="progress" aria-label="${done} of ${plans.length} plans done"><div class="progress-track"><div class="progress-fill" data-w="${pct}%"></div></div><span>${done}/${plans.length}</span></div>` : ''}
        ${linkedHtml}
        ${schedHtml}
      </div>
    </aside>`;
  }

  // ───────────────────────── list views
  const LIST = {
    whim: { view: 'whim', input: 'New project', placeholder: 'Name a new project…', add: 'Add project', empty: 'No projects yet. Add the first one above.', label: 'Project' },
    routine: { view: 'routine', input: 'New routine step', placeholder: 'Add a routine step…', add: 'Add step', empty: 'No routine steps yet.', label: 'Routine step' },
    activity: { view: 'activities', input: 'New activity', placeholder: 'What did you just do?', add: 'Log it', empty: 'Nothing logged yet.', label: 'Activity' }
  };
  function listRow(kind, item) {
    const cfg = LIST[kind];
    if (S.editing === item.id) {
      return `<form class="row" data-form="edit-item" data-id="${item.id}"><input class="field" name="text" maxlength="500" value="${esc(item.text)}" aria-label="Edit ${esc(cfg.label.toLowerCase())}" data-autofocus><button class="btn btn-sm" type="submit">Save</button><button class="btn btn-sm btn-ghost" type="button" data-action="cancel-edit">Cancel</button></form>`;
    }
    const done = kind === 'routine' && routineDone(item);
    const meta = kind === 'whim' ? stamp(item.createdAt) : kind === 'activity' ? clockOf(item.createdAt) : '';
    return `<div class="row${done ? ' done' : ''}" data-id="${item.id}">
      ${kind === 'routine' ? `<input type="checkbox" class="check" data-action="toggle-${kind}" data-id="${item.id}" aria-label="Mark “${esc(item.text)}” done" ${done ? 'checked' : ''}>` : ''}
      <span class="row-text">${esc(item.text)}</span>
      ${meta ? `<span class="row-meta">${esc(meta)}</span>` : ''}
      <span class="row-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${item.id}" aria-label="Edit “${esc(item.text)}”" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" type="button" data-action="remove" data-id="${item.id}" data-label="${cfg.label}" aria-label="Remove “${esc(item.text)}”" title="Remove">${icon('x')}</button>
      </span>
    </div>`;
  }
  function renderList(kind) {
    const cfg = LIST[kind];
    const view = VIEWS[cfg.view];
    let items = S.items[kind].slice();
    if (kind !== 'routine') items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else items.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    let body = '';
    if (!items.length) body = `<p class="empty">${esc(cfg.empty)}</p>`;
    else if (kind === 'activity') {
      let lastDay = null;
      for (const item of items) {
        const day = iso(new Date(item.createdAt));
        if (day !== lastDay) {
          lastDay = day;
          const label = day === todayISO() ? 'Today' : day === addDays(todayISO(), -1) ? 'Yesterday' : longDate(day);
          body += `<div class="group-label">${esc(label)}</div>`;
        }
        body += listRow(kind, item);
      }
    } else body = items.map(item => listRow(kind, item)).join('');
    let progress = '';
    if (kind === 'routine' && items.length) {
      const done = items.filter(routineDone).length;
      progress = `<div class="progress lg" aria-label="${done} of ${items.length} routine steps done today"><div class="progress-track"><div class="progress-fill" data-w="${Math.round(done / items.length * 100)}%"></div></div><span>${done} of ${items.length} done today</span></div>`;
    }
    return `${pageHead(view.title, view.subtitle)}
      <div class="list-wrap">
        <form class="add-row" data-form="list" data-kind="${kind}">
          <input class="field" id="list-input" name="text" maxlength="500" aria-label="${esc(cfg.input)}" placeholder="${esc(cfg.placeholder)}" autocomplete="off">
          <button class="btn" type="submit">${esc(cfg.add)}</button>
        </form>
        ${progress}
        ${body}
      </div>`;
  }


  // ───────────────────────── analytics
  function renderAnalytics() {
    const view = VIEWS.analytics;
    const today = todayISO();
    const routine = S.items.routine;
    const rDone = routine.filter(routineDone).length;
    const monthPlans = S.items.plan.filter(p => { const d = parse(p.day); return d.getFullYear() === new Date().getFullYear() && d.getMonth() === new Date().getMonth(); });
    const monthDone = monthPlans.filter(p => p.doneOn).length;
    const stats = [
      { label: 'Routine today', value: routine.length ? `${Math.round(rDone / routine.length * 100)}%` : '—', sub: routine.length ? `${rDone} of ${routine.length} steps` : 'No steps yet' },
      { label: 'Activities logged', value: S.items.activity.length, sub: `${S.items.activity.filter(a => iso(new Date(a.createdAt)) === today).length} today` },
      { label: `Plans in ${MON3[new Date().getMonth()]}`, value: monthPlans.length, sub: `${monthDone} completed` },
      { label: 'Projects', value: PJ ? PJ.list().length : 0, sub: 'Ideas and projects kept' }
    ];
    const series = (count) => Array.from({ length: 7 }, (_, i) => {
      const day = addDays(today, i - 6);
      return { day, label: i === 6 ? 'Today' : DAYS[parse(day).getDay()].slice(0, 3), value: count(day) };
    });
    const bars = list => {
      const max = Math.max(0, ...list.map(b => b.value));
      return `<div class="bars" role="img" aria-label="${esc(list.map(b => `${b.label}: ${b.value}`).join(', '))}">${list.map(b => `<div class="bar-col"><span class="bar-value">${b.value}</span><div class="bar${b.day === today ? ' today' : ''}" data-h="${max ? Math.max(4, Math.round(b.value / max * 160)) : 4}px"></div><span class="bar-label">${b.label}</span></div>`).join('')}</div>`;
    };
    const acts = series(day => S.items.activity.filter(a => iso(new Date(a.createdAt)) === day).length);
    const plansDone = series(day => S.items.plan.filter(p => p.day === day && p.doneOn).length);
    const plansTotal = series(day => S.items.plan.filter(p => p.day === day).length);
    const weekTotal = plansTotal.reduce((t, b) => t + b.value, 0); const weekDone = plansDone.reduce((t, b) => t + b.value, 0);
    return `${pageHead(view.title, view.subtitle)}
      <div class="stats">${stats.map(s => `<div class="stat"><span class="stat-label">${esc(s.label)}</span><span class="stat-value">${esc(s.value)}</span><span class="stat-sub">${esc(s.sub)}</span></div>`).join('')}</div>
      <section class="chart-card" aria-label="Activities in the last 7 days"><h2 class="section-title">Activities logged, last 7 days</h2>${bars(acts)}</section>
      <section class="chart-card" aria-label="Plans completed in the last 7 days">
        <div class="chart-head"><h2 class="section-title">Plans completed, last 7 days</h2><span class="stat-sub">${weekDone} of ${weekTotal} planned</span></div>
        ${bars(plansDone)}
      </section>`;
  }

  // ───────────────────────── home
  /* Home is the Today page: the four pillars on one screen, built only from data the app already has.
     Plan: a month at a glance and today's agenda. Learn: subjects to continue. Create: recently edited projects.
     Automate: workflows, agents and chat. The right column is today's to-do (plans) and routine, done in place. */
  function greeting() { const h = new Date().getHours(); return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function homeMonth(today) {
    const t = parse(today);
    const first = new Date(t.getFullYear(), t.getMonth(), 1);
    const offset = (first.getDay() - prefs.weekStart + 7) % 7;
    const weeks = Math.ceil((offset + new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()) / 7);
    const head = dowOrder().map(i => `<span class="hm-dow">${DAYS[i].slice(0, 1)}</span>`).join('');
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), 1 - offset + i);
      const key = iso(d);
      const busy = S.items.plan.some(x => x.day === key) || linkedFor(key).length > 0 || (SB ? SB.unlinkedCount(key) > 0 : false);
      const cls = ['hm-day', d.getMonth() !== t.getMonth() ? 'outside' : '', key === today ? 'today' : '', busy ? 'busy' : ''].filter(Boolean).join(' ');
      cells.push(`<button class="${cls}" type="button" data-action="home-day" data-day="${key}" aria-label="${esc(longDate(key))}${busy ? ', has plans' : ''}">${d.getDate()}</button>`);
    }
    return `<div class="hm" role="group" aria-label="${esc(MONTHS[t.getMonth()])} ${t.getFullYear()}">
      <div class="hm-title">${esc(MONTHS[t.getMonth()])} <span>${t.getFullYear()}</span></div>
      <div class="hm-grid">${head}${cells.join('')}</div>
    </div>`;
  }
  function homeAgenda(today) {
    const sched = SB ? SB.eventsFor(today) : [];
    const linked = linkedFor(today);
    const rows = [
      ...sched.map(e => `<li><button class="ha-row" type="button" data-action="home-day" data-day="${today}" title="Open in the calendar"><span class="ha-bar sched" aria-hidden="true"></span><span class="ha-main"><strong>${esc(e.title)}</strong><small>${esc(e.when)}</small></span></button></li>`),
      ...linked.map(e => `<li><button class="ha-row${e.done ? ' done' : ''}" type="button" data-action="open-project" data-id="${esc(e.projectId)}" title="Open ${esc(e.project)}"><span class="ha-bar proj" aria-hidden="true"></span><span class="ha-main"><strong>${esc(e.title)}</strong><small>${LINK_KIND[e.kind]}${e.time ? ` · ${esc(fmtTime(e.time))}` : ''} · ${esc(e.project)}</small></span></button></li>`)
    ];
    return `<div class="ha">
      <div class="ha-head"><span>${esc(DAYS[parse(today).getDay()])}</span><button class="t-link" type="button" data-action="new" data-value="plan">${icon('plus')}Schedule</button></div>
      ${rows.length ? `<ul class="ha-list">${rows.join('')}</ul>` : '<p class="t-empty">No schedules today. Your day is open.</p>'}
    </div>`;
  }
  function renderHome() {
    const u = S.user || {};
    const today = todayISO();
    const plans = plansFor(today); const pDone = plans.filter(p => p.doneOn).length;
    const routine = S.items.routine; const rDone = routine.filter(routineDone).length;
    const editing = S.editingProfile;
    const profile = editing ? `
      <form class="profile-edit" data-form="profile">
        <input class="field profile-edit-name" name="displayName" maxlength="80" value="${esc(u.displayName)}" aria-label="Your name" data-autofocus required>
        <div class="profile-edit-row">
          <input class="field" name="bio" maxlength="500" value="${esc(u.bio)}" aria-label="Your bio" placeholder="Add a short bio about yourself">
          <button class="btn btn-sm" type="submit">Save</button><button class="btn btn-sm btn-ghost" type="button" data-action="cancel-profile">Cancel</button>
        </div>
      </form>` : `
      <div class="profile-name-row"><h1 class="profile-name" title="${esc(u.displayName)}">${esc(u.displayName)}</h1><button class="icon-btn" id="profile-edit-btn" type="button" data-action="edit-profile" aria-label="Edit profile" title="Edit profile">${icon('edit')}</button></div>
      ${u.bio ? `<p class="profile-bio" title="${esc(u.bio)}">${esc(u.bio)}</p>` : `<button class="link-btn profile-bio-add" type="button" data-action="edit-profile">Add a short bio</button>`}`;
    const focusLabel = { 'center 20%': 'Top', 'center 52%': 'Middle', 'center 85%': 'Bottom' }[u.coverPosition || 'center 52%'] || 'Middle';
    const coverTools = editing ? '' : `<div class="cover-tools">
            <button class="cover-btn" id="cover-image-btn" type="button" data-action="cover-image" aria-label="Change banner" title="Change banner">${icon('image')}<span>Change banner</span></button>
            ${u.coverImage ? `<button class="cover-btn" id="cover-position-btn" type="button" data-action="cover-position" aria-label="Reposition banner" title="Focus: ${focusLabel}"><span>Reposition</span></button>` : ''}
          </div>`;

    const subjects = LN ? LN.list().slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 4) : [];
    const learn = subjects.length ? `<ul class="t-list">${subjects.map(sub => `<li><button class="t-item" type="button" data-action="home-subject" data-id="${esc(sub.id)}">
        <span class="t-art${sub.image ? '' : ' none'}" ${sub.image ? `data-img="${esc(sub.image)}"` : ''} aria-hidden="true">${sub.image ? '' : esc(String(sub.name || '?').trim().charAt(0).toUpperCase())}</span>
        <span class="t-main"><strong>${esc(sub.name)}</strong><small data-ln-summary="${esc(sub.id)}">${sub.type === 'minor' ? 'Minor' : 'Major'} · ${esc(LN.summaryText(sub))}</small></span>
      </button></li>`).join('')}</ul>${LN.homeBlock(subjects)}` : `<p class="t-empty">No subjects yet. Add one and upload your study files.</p>`;

    const projects = PJ ? PJ.list().slice(0, 4) : [];
    const create = projects.length ? `<ul class="t-list">${projects.map(pr => {
      const open = Number(pr.open_tasks) || 0;
      return `<li><button class="t-item" type="button" data-action="open-project" data-id="${esc(pr.id)}">
        <span class="t-art proj" aria-hidden="true">${pr.icon ? esc(pr.icon) : icon('folder')}</span>
        <span class="t-main"><strong>${esc(pr.name)}</strong><small>Edited ${esc(stamp(pr.updated_at || pr.created_at))}${open ? ` · ${open} open task${open === 1 ? '' : 's'}` : ''}</small></span>
        ${icon('right', 'class="t-go"')}
      </button></li>`;
    }).join('')}</ul>` : `<p class="t-empty">No projects yet. Start one for an idea or a goal.</p>`;

    const automate = [['automation', 'Workflows', 'flow', 'Run repeated steps'], ['agents', 'Agents', 'agent', 'Your AI helpers'], ['chat', 'Chat', 'chat', 'Talk it through']];
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
    const todo = plans.map((pl, idx) => `<li class="t-todo${pl.doneOn ? ' done' : ''}" data-id="${pl.id}">
        <input type="checkbox" class="check" data-action="toggle-plan" data-id="${pl.id}" aria-label="Mark “${esc(pl.text)}” done" ${pl.doneOn ? 'checked' : ''}>
        <span class="t-todo-text">${esc(pl.text)}</span>
        ${pl.time ? `<span class="t-todo-time">${esc(fmtTime(pl.time))}</span>` : `<span class="t-todo-dot" data-dot="${PLAN_COLORS[idx % PLAN_COLORS.length]}" aria-hidden="true"></span>`}
      </li>`).join('');
    const routineRows = routine.map(r => `<li class="t-todo${routineDone(r) ? ' done' : ''}" data-id="${r.id}">
        <input type="checkbox" class="check" data-action="toggle-routine" data-id="${r.id}" aria-label="Mark “${esc(r.text)}” done" ${routineDone(r) ? 'checked' : ''}>
        <span class="t-todo-text">${esc(r.text)}</span>
      </li>`).join('');
    const grip = (id, title) => `<button class="t-grip" type="button" data-action="home-grip" data-id="${id}" aria-label="Move ${esc(title)} card" aria-describedby="home-move-hint">${icon('grip')}</button>`;
    const card = (id, pillar, ic, title, action, body) => `<section class="t-card" data-card="${id}" aria-label="${esc(title)}">
        <header class="t-card-head">${grip(id, title)}<span class="t-pillar">${icon(ic)}${esc(pillar)}</span>${action}</header>${body}</section>`;
    const cards = {
      plan: card('plan', 'Plan', 'calendar', 'Plan', `<button class="t-link" type="button" data-go="calendar">Calendar${icon('right')}</button>`, `<div class="t-plan">${homeMonth(today)}${homeAgenda(today)}</div>`),
      learn: card('learn', 'Learn', 'learning', 'Learn', `<button class="t-link" type="button" data-go="learning">All subjects${icon('right')}</button>`, learn),
      create: card('create', 'Create', 'folder', 'Create', `<button class="t-link" type="button" data-action="new" data-value="whim">${icon('plus')}New</button>`, create),
      automate: card('automate', 'Automate', 'flow', 'Automate', '', `<div class="t-auto">${automate.map(([v, label, ic, sub]) => `<button class="t-auto-btn" type="button" data-go="${v}"><span class="t-auto-ic">${icon(ic)}</span><span class="t-main"><strong>${label}</strong><small>${sub}</small></span></button>`).join('')}</div>`),
      todo: `<section class="t-card t-note" data-card="todo" aria-label="Today’s to-do">
            <header class="t-card-head">${grip('todo', 'Today’s to-do')}<h2 class="t-note-title">Today’s to-do</h2><span class="t-count">${pDone}/${plans.length}</span></header>
            <div class="progress" aria-hidden="true"><div class="progress-track"><div class="progress-fill" data-w="${pct(pDone, plans.length)}%"></div></div></div>
            ${plans.length ? `<ul class="t-todos">${todo}</ul>` : '<p class="t-empty">Nothing planned yet. Add the first thing below.</p>'}
            <form class="t-add" data-form="home-plan" aria-label="Add a plan for today">
              <span class="t-add-ic" aria-hidden="true">${icon('plus')}</span>
              <input class="t-add-input" id="home-plan-input" name="text" maxlength="500" placeholder="Add to today… (Enter)" autocomplete="off" aria-label="Add a plan for today">
            </form>
          </section>`,
      routine: `<section class="t-card t-note" data-card="routine" aria-label="Routine">
            <header class="t-card-head">${grip('routine', 'Routine')}<h2 class="t-note-title">Routine</h2><span class="t-count">${rDone}/${routine.length}</span></header>
            <div class="progress" aria-hidden="true"><div class="progress-track"><div class="progress-fill" data-w="${pct(rDone, routine.length)}%"></div></div></div>
            ${routine.length ? `<ul class="t-todos">${routineRows}</ul>` : `<p class="t-empty">No routine yet. <button class="link-btn" type="button" data-action="new" data-value="routine">Add a step</button></p>`}
          </section>`
    };
    const layout = HL.normalize(prefs.homeLayout);
    const wide = HL.spans(layout.main);
    const zoneHtml = zone => layout[zone].map(id => (zone === 'main' && wide.has(id) ? cards[id].replace('class="t-card', 'class="t-card t-wide') : cards[id])).join('');

    return `<div class="today">
      <div class="profile-card today-head">
        <div class="cover${u.coverImage ? ' has-image' : ''}" data-theme="${esc(u.coverTheme || 'aurora')}" ${u.coverImage ? `data-img="${esc(u.coverImage)}" data-bgpos="${esc(u.coverPosition || 'center 52%')}"` : ''}>${coverTools}</div>
        <div class="profile-body">
          <button class="profile-avatar" id="profile-avatar-btn" type="button" data-action="change-photo" aria-label="Change photo" title="Change photo" data-img="${esc(u.image || '')}"${editing ? ' disabled' : ''}>${u.image ? '' : `<span class="profile-initials">${esc(initials(u.displayName))}</span>`}<span class="profile-avatar-scrim" aria-hidden="true">${icon('camera')}</span></button>
          <div class="profile-info">${profile}</div>
          <div class="today-meta">
            <p class="today-hello">${greeting()} · ${esc(longDate(today))}</p>
            <div class="today-stats" aria-label="Today">
              ${HL.isDefault(prefs.homeLayout) ? '' : HOME_RESET}<span><strong>${pDone}/${plans.length}</strong>plans</span><span><strong>${rDone}/${routine.length}</strong>routine</span>
            </div>
          </div>
        </div>
      </div>
      <p id="home-move-hint" class="sr-only">Arrow up or down to reorder, left or right to change column. Moves save at once.</p>
      <div class="${homeGridClass(layout)}">
        <div class="today-main" data-zone="main">${zoneHtml('main')}</div>
        <aside class="today-side" data-zone="side" aria-label="Side column">${zoneHtml('side')}</aside>
      </div>
    </div>`;
  }

  // ───────────────────────── Today card layout: pointer drag, keyboard moves, reset
  // Cards are moved in place (no page repaint) and the new order is saved per device in prefs.homeLayout.
  const HOME_RESET = '<button class="t-link today-reset" type="button" data-action="home-reset">Reset layout</button>';
  const HOME_TITLES = { plan: 'Plan', learn: 'Learn', create: 'Create', automate: 'Automate', todo: 'Today’s to-do', routine: 'Routine' };
  const HOME_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const HOME_SKIP = 'button:not(.t-grip), a, input, select, textarea, label, [contenteditable="true"]';
  const homeGridClass = l => `today-grid${l.main.length ? '' : ' main-empty'}${l.side.length ? '' : ' side-empty'}`;
  let homeDrag = null;
  const homeRects = new WeakMap(); // settled layout boxes, read while siblings are still sliding

  function announce(message) {
    const live = $('#sr-live'); if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 40);
  }
  const zoneEl = zone => $(`.today [data-zone="${zone}"]`);
  const isCard = el => !!(el && el.dataset && el.dataset.card && !el.classList.contains('t-lifted'));
  const cardsIn = node => [...node.children].filter(isCard);
  const idOf = el => (el.classList.contains('t-ph') ? (homeDrag && homeDrag.id) : isCard(el) ? el.dataset.card : null);
  const zoneName = zone => (zone === 'main' ? 'main' : 'side');
  function domLayout() {
    const read = zone => { const node = zoneEl(zone); return node ? [...node.children].map(idOf).filter(Boolean) : []; };
    return { main: read('main'), side: read('side') };
  }
  /* Keeps full-row spans, empty-column targets, the grid shape and the Reset link in step with the order on screen. */
  function syncHomeChrome() {
    const l = domLayout();
    const wide = HL.spans(l.main);
    for (const zone of HL.ZONES) {
      const node = zoneEl(zone); if (!node) continue;
      for (const el of node.children) { const id = idOf(el); if (id) el.classList.toggle('t-wide', zone === 'main' && wide.has(id)); }
      const empty = node.querySelector(':scope > .t-zone-empty');
      if (empty) empty.classList.toggle('show', !l[zone].length);
    }
    if (homeDrag) return; // the grid keeps its shape while a card is held
    const grid = $('.today-grid'); if (grid) grid.className = homeGridClass(l);
    const meta = $('.today-meta .today-stats'); if (!meta) return;
    const link = meta.querySelector('[data-action="home-reset"]');
    const plain = HL.isDefault(prefs.homeLayout);
    if (plain && link) link.remove();
    else if (!plain && !link) meta.insertAdjacentHTML('afterbegin', HOME_RESET);
  }
  /* FLIP: record boxes, change the order, then slide every card from its old box to its new one. */
  function flipHome(mutate) {
    const today = $('.today'); if (!today) { mutate(); return; }
    const pick = () => $$('[data-card]:not(.t-lifted), .t-ph', today);
    const first = new Map(pick().map(el => [el, el.getBoundingClientRect()]));
    first.forEach((_, el) => el.getAnimations().forEach(a => { if (a.id === 'home-flip') a.cancel(); }));
    mutate();
    syncHomeChrome();
    const scroll = $('#main-panel').scrollTop;
    for (const el of pick()) {
      const last = el.getBoundingClientRect();
      homeRects.set(el, { rect: last, scroll });
      const f = first.get(el);
      if (!f || reduceMotion()) continue;
      const dx = f.left - last.left; const dy = f.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: HOME_EASE }).id = 'home-flip';
    }
  }
  /* The box a card will rest in, ignoring a slide still in progress. */
  function layoutRect(el) {
    const sliding = el.getAnimations().some(a => a.id === 'home-flip' && a.playState === 'running');
    const cached = homeRects.get(el);
    if (!sliding || !cached) return el.getBoundingClientRect();
    const dy = cached.scroll - $('#main-panel').scrollTop;
    const r = cached.rect;
    return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top + dy, bottom: r.bottom + dy };
  }
  const nextCard = el => { let n = el.nextElementSibling; while (n && !isCard(n)) n = n.nextElementSibling; return n; };
  /* Where the held card would land under the pointer. 8px of slack stops the order flickering at a boundary. */
  function homeTarget(x, y) {
    const ph = homeDrag.ph;
    const hit = document.elementFromPoint(x, y);
    const node = hit && hit.closest ? hit.closest('.today [data-zone]') : null;
    if (!node) return null;
    const main = node.dataset.zone === 'main';
    for (const sib of cardsIn(node)) {
      const r = layoutRect(sib);
      const slack = ph.parentElement === node && (ph.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING) ? 8 : -8;
      if (y < r.top) return { node, before: sib };
      if (y > r.bottom) continue;
      if (main && !sib.classList.contains('t-wide')) { if (x < r.left + r.width / 2 + slack) return { node, before: sib }; continue; }
      if (y < r.top + r.height / 2 + slack) return { node, before: sib };
    }
    return { node, before: null };
  }
  function retargetHome() {
    const d = homeDrag; if (!d || !d.lifted || d.settling) return;
    const t = homeTarget(d.x, d.y); if (!t) return;
    if (d.ph.parentElement === t.node && nextCard(d.ph) === t.before) return;
    flipHome(() => t.node.insertBefore(d.ph, t.before || t.node.querySelector(':scope > .t-zone-empty')));
    fitLifted();
  }
  /* The held card heads for the width of the slot under it: the side column, or its span in the main grid. */
  function fitLifted() {
    const d = homeDrag; if (!d || !d.ph.isConnected) return;
    d.tw = Math.max(160, Math.min(d.ph.getBoundingClientRect().width, window.innerWidth - 16));
    d.el.classList.toggle('t-in-side', d.ph.parentElement.dataset.zone === 'side');
    if (reduceMotion()) { d.w = d.tw; moveLifted(); }
  }
  function moveLifted() {
    const d = homeDrag;
    const scale = reduceMotion() ? 1 : 1.015;
    // The grab point stays at the same fraction of the card while its width follows the column under it.
    d.el.style.width = `${d.w}px`;
    d.el.style.transform = `translate(${d.x - d.fx * d.w - d.rl}px, ${d.y - d.y0}px) scale(${scale})`;
  }
  function liftHome() {
    const d = homeDrag; const el = d.el;
    if (!el.isConnected) { endHomeDrag(); return; }
    $('#stage').classList.remove('view-in'); // moved cards must not replay their entrance
    const r = el.getBoundingClientRect();
    d.lifted = true;
    d.ph = document.createElement('div');
    d.ph.className = `t-ph${el.classList.contains('t-wide') ? ' t-wide' : ''}`;
    d.ph.setAttribute('aria-hidden', 'true');
    d.ph.style.height = `${r.height}px`;
    el.before(d.ph);
    for (const zone of HL.ZONES) { const node = zoneEl(zone); if (!node) continue; const target = document.createElement('div'); target.className = 't-zone-empty'; target.setAttribute('aria-hidden', 'true'); node.append(target); }
    el.classList.add('t-lifted');
    el.style.width = `${r.width}px`; el.style.left = `${r.left}px`; el.style.top = `${r.top}px`;
    const placed = el.getBoundingClientRect(); // correct once if an ancestor shifts fixed boxes
    d.left = r.left + (r.left - placed.left); d.top = r.top + (r.top - placed.top);
    el.style.left = `${d.left}px`; el.style.top = `${d.top}px`;
    d.rl = r.left; d.rt = r.top; d.w = r.width; d.tw = r.width; d.fx = (d.x0 - r.left) / r.width;
    document.body.classList.add('home-dragging');
    // While a card is held the grid keeps both columns, so an empty column stays a visible target in place.
    flipHome(() => $('.today').classList.add('dragging'));
    try { el.setPointerCapture(d.pid); } catch { /* synthetic or finished pointer */ }
    syncHomeChrome();
    moveLifted();
    d.raf = requestAnimationFrame(homeTick);
  }
  /* Scrolls the page while the pointer is within 48px of its top or bottom edge. */
  function homeTick() {
    const d = homeDrag; if (!d || !d.lifted || d.settling) return;
    const panel = $('#main-panel'); const pr = panel.getBoundingClientRect(); const edge = 48;
    let v = 0;
    if (d.y < pr.top + edge) v = -Math.min(18, Math.ceil((pr.top + edge - d.y) / edge * 14));
    else if (d.y > pr.bottom - edge) v = Math.min(18, Math.ceil((d.y - (pr.bottom - edge)) / edge * 14));
    if (v) { const was = panel.scrollTop; panel.scrollTop += v; if (panel.scrollTop !== was) retargetHome(); }
    if (Math.abs(d.tw - d.w) > 0.5) { d.w += (d.tw - d.w) * 0.3; moveLifted(); } // about 160ms to the new width
    else if (d.w !== d.tw) { d.w = d.tw; moveLifted(); }
    d.raf = requestAnimationFrame(homeTick);
  }
  function onHomeMove(event) {
    const d = homeDrag; if (!d || event.pointerId !== d.pid || d.settling) return;
    d.x = event.clientX; d.y = event.clientY;
    if (!d.lifted) { if (Math.hypot(d.x - d.x0, d.y - d.y0) < 4) return; liftHome(); if (!homeDrag) return; }
    event.preventDefault();
    moveLifted();
    retargetHome();
  }
  function onHomeUp(event) { if (homeDrag && event.pointerId === homeDrag.pid) dropHome(); }
  function onHomeCancel(event) { if (homeDrag && event.pointerId === homeDrag.pid) cancelHomeDrag(); }
  function unlistenHome() {
    document.removeEventListener('pointermove', onHomeMove, true);
    document.removeEventListener('pointerup', onHomeUp, true);
    document.removeEventListener('pointercancel', onHomeCancel, true);
  }
  function endHomeDrag() { unlistenHome(); homeDrag = null; }
  /* The click that follows a drag must not open the link or button under the pointer. */
  function swallowClick() {
    const stop = event => { event.preventDefault(); event.stopPropagation(); };
    document.addEventListener('click', stop, true);
    setTimeout(() => document.removeEventListener('click', stop, true), 0);
  }
  /* Glides the held card into the placeholder, then puts it back in the page flow. */
  function settleHome(instant, done) {
    const d = homeDrag; if (!d || d.settling) return;
    d.settling = true; unlistenHome(); cancelAnimationFrame(d.raf);
    let anim = null;
    const finish = () => {
      if (d.finished) return; d.finished = true;
      if (anim) anim.cancel();
      const el = d.el; const focused = el.contains(document.activeElement) ? document.activeElement : null;
      try { el.releasePointerCapture(d.pid); } catch { /* already released */ }
      d.ph.replaceWith(el);
      el.classList.remove('t-lifted', 't-in-side');
      for (const prop of ['left', 'top', 'width', 'height', 'transform']) el.style.removeProperty(prop);
      $$('.today .t-zone-empty').forEach(n => n.remove());
      document.body.classList.remove('home-dragging');
      const today = $('.today'); if (today) today.classList.remove('dragging');
      homeDrag = null;
      done();
      syncHomeChrome();
      if (focused && focused.isConnected) focused.focus({ preventScroll: true });
      if (d.dirty) rerender();
    };
    d.finishNow = finish;
    if (instant || reduceMotion()) { finish(); return; }
    const to = d.ph.getBoundingClientRect();
    anim = d.el.animate([
      { transform: d.el.style.transform, width: `${d.el.offsetWidth}px`, height: `${d.el.offsetHeight}px` },
      { transform: `translate(${to.left - d.rl}px, ${to.top - d.rt}px) scale(1)`, width: `${to.width}px`, height: `${to.height}px` }
    ], { duration: 180, easing: HOME_EASE, fill: 'forwards' });
    anim.onfinish = finish;
    anim.oncancel = finish;
  }
  function dropHome() {
    const d = homeDrag; if (!d) return;
    if (!d.lifted) { endHomeDrag(); return; }
    if (d.settling) return;
    swallowClick();
    const node = d.ph.parentElement; const zone = node.dataset.zone;
    let index = 0; for (const el of node.children) { if (el === d.ph) break; if (isCard(el)) index++; }
    const before = HL.normalize(prefs.homeLayout);
    const next = HL.move(before, d.id, zone, index);
    settleHome(false, () => {
      if (JSON.stringify(next) === JSON.stringify(before)) return;
      prefs.homeLayout = next; savePrefs();
      announce(`${HOME_TITLES[d.id]} card moved to position ${next[zone].indexOf(d.id) + 1} in ${zoneName(zone)} column.`);
    });
  }
  /* Esc, a lost pointer, leaving the window or the page: the card returns to where it started, nothing is saved. */
  function cancelHomeDrag(instant = false) {
    const d = homeDrag; if (!d) return;
    if (!d.lifted) { endHomeDrag(); return; }
    if (d.settling) { if (instant && d.finishNow) d.finishNow(); return; }
    swallowClick();
    if (instant || reduceMotion()) d.el.before(d.ph);
    else flipHome(() => d.el.before(d.ph));
    settleHome(instant, () => {});
  }
  /* Arrow keys on a focused grip: up/down reorder within the column, left/right change column, Home/End jump. */
  function homeKey(event) {
    const grip = event.target.closest ? event.target.closest('.today .t-grip') : null;
    if (!grip || homeDrag || event.altKey || event.ctrlKey || event.metaKey) return false;
    const id = grip.dataset.id;
    const cur = HL.normalize(prefs.homeLayout);
    const zone = cur.main.includes(id) ? 'main' : 'side';
    const at = cur[zone].indexOf(id); const last = cur[zone].length - 1;
    const moves = { ArrowUp: [zone, at - 1], ArrowDown: [zone, at + 1], Home: [zone, 0], End: [zone, last], ArrowLeft: zone === 'side' ? ['main', cur.main.length] : null, ArrowRight: zone === 'main' ? ['side', cur.side.length] : null };
    if (!(event.key in moves)) return false;
    event.preventDefault();
    const to = moves[event.key];
    if (!to || (to[0] === zone && (to[1] < 0 || to[1] > last || to[1] === at))) return true;
    const next = HL.move(cur, id, to[0], to[1]);
    prefs.homeLayout = next; savePrefs();
    $('#stage').classList.remove('view-in');
    flipHome(() => { for (const z of HL.ZONES) { const node = zoneEl(z); const tail = node.querySelector(':scope > .t-zone-empty'); for (const cid of next[z]) { const el = $(`.today [data-card="${cid}"]`); if (el) node.insertBefore(el, tail); } } });
    const again = $(`.today .t-grip[data-id="${id}"]`);
    if (again) { again.focus({ preventScroll: true }); again.closest('[data-card]').scrollIntoView({ block: 'nearest' }); }
    announce(`${HOME_TITLES[id]} card moved to position ${next[to[0]].indexOf(id) + 1} in ${zoneName(to[0])} column.`);
    return true;
  }
  function bindHomeDrag() {
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0 || homeDrag || S.view !== 'home' || !HL) return;
      const head = event.target.closest ? event.target.closest('.today .t-card-head') : null;
      if (!head || event.target.closest(HOME_SKIP)) return;
      const el = head.closest('[data-card]'); if (!el) return;
      homeDrag = { el, id: el.dataset.card, pid: event.pointerId, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, lifted: false, dirty: false };
      document.addEventListener('pointermove', onHomeMove, true);
      document.addEventListener('pointerup', onHomeUp, true);
      document.addEventListener('pointercancel', onHomeCancel, true);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && homeDrag && homeDrag.lifted) { event.preventDefault(); event.stopImmediatePropagation(); cancelHomeDrag(); }
    }, true);
    window.addEventListener('blur', () => cancelHomeDrag());
  }

  // ───────────────────────── settings
  function renderSettings() {
    const view = VIEWS.settings;
    const u = S.user || {};
    const pills = (action, current, options) => `<div class="toggle-track" role="group">${options.map(([value, label]) => `<button class="toggle-pill${String(current) === String(value) ? ' active' : ''}" type="button" data-action="${action}" data-value="${value}" aria-pressed="${String(current) === String(value)}">${label}</button>`).join('')}</div>`;
    const row = (label, desc, control) => `<div class="setting"><div class="setting-text"><span class="setting-label">${label}</span><span class="setting-desc">${desc}</span></div>${control}</div>`;
    const themes = ['aurora', 'dusk', 'tide', 'ember'];
    return `${pageHead(view.title, view.subtitle)}
      <div class="settings-wrap">
        <section class="settings-section" aria-label="Appearance"><h2>Appearance</h2>
          ${row('Theme', 'Appearance for this workspace', '<span class="setting-value">Dark</span>')}
          ${row('Profile banner', u.coverImage ? 'Using your uploaded image' : 'Gradient shown on your Home profile', `<div class="toggle-track" role="group" aria-label="Banner style">${themes.map(t => `<button class="toggle-pill${!u.coverImage && u.coverTheme === t ? ' active' : ''}" type="button" data-action="cover-theme" data-value="${t}" aria-pressed="${!u.coverImage && u.coverTheme === t}"><span class="swatch" data-theme="${t}"></span>${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`)}
          ${row('Banner image', 'Upload a PNG, JPG or WebP up to 5 MB', `<button class="btn btn-sm btn-ghost" type="button" data-action="cover-image">Upload</button>`)}
          ${row('Reduce motion', 'Auto follows your system setting', pills('motion', prefs.motion, [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]))}
        </section>
        <section class="settings-section" aria-label="Calendar"><h2>Calendar</h2>
          ${row('Week starts on', 'First day shown on the calendar', pills('week-start', prefs.weekStart, [[0, 'Sunday'], [1, 'Monday']]))}
          ${row('Time format', 'How plan times are displayed', pills('time-format', prefs.timeFormat, [['12', '12-hour'], ['24', '24-hour']]))}
          ${row('Default view', 'Calendar layout when you open it', pills('cal-view', prefs.calView, [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']]))}
        </section>
        <section class="settings-section" aria-label="Account"><h2>Account</h2>
          ${row('Email', 'Used to sign in on this computer', `<span class="setting-value">${esc(u.email)}</span>`)}
          ${row('Profile photo', 'Shown on Home and in the rail', `<button class="btn btn-sm btn-ghost" type="button" data-action="change-photo">Change</button>`)}
          ${row('Sign out', 'Your data stays saved on this computer', `<button class="btn btn-sm btn-ghost" type="button" data-action="logout">${icon('logout')}Sign out</button>`)}
        </section>
        <section class="settings-section" aria-label="About"><h2>About</h2>
          ${row('Version', 'Perflw', `<span class="setting-value">${esc(S.version || '—')}</span>`)}
        </section>
      </div>`;
  }


  // ───────────────────────── chat categories (Work / Learning / Personal)
  const CHAT_CATS = [['work', 'Work'], ['learning', 'Learning'], ['personal', 'Personal']];
  const chatCat = () => (CHAT_CATS.some(([key]) => key === prefs.chatCat) ? prefs.chatCat : 'work');
  const catOf = chat => (chat && chat.category) || 'work';
  const catLabel = key => (CHAT_CATS.find(([k]) => k === key) || CHAT_CATS[0])[1];
  function followCat(id) {
    const chat = [...S.chats, ...S.archivedChats].find(c => c.id === id);
    if (chat && catOf(chat) !== prefs.chatCat) { prefs.chatCat = catOf(chat); savePrefs(); }
    if (chat) S.showArchived = S.archivedChats.some(c => c.id === id);
  }

  // ───────────────────────── chat
  function chatListHtml() {
    const list = S.showArchived ? S.archivedChats : S.chats;
    const items = list.length ? list.map(c => `<button class="chat-item${c.id === S.activeChat ? ' active' : ''}" type="button" data-action="open-chat" data-id="${c.id}" aria-current="${c.id === S.activeChat}"><span class="chat-item-title">${esc(c.title)}</span><span class="chat-item-meta">${esc(stamp(c.updated_at))}</span></button>`).join('')
      : `<p class="empty">${S.showArchived ? 'No archived conversations.' : 'No conversations yet.'}</p>`;
    return `<aside class="chat-list" aria-label="Conversations">
          <div class="chat-list-head"><div class="toggle-track" role="group" aria-label="Show"><button class="toggle-pill${S.showArchived ? '' : ' active'}" type="button" data-action="chat-filter" data-value="active" aria-pressed="${!S.showArchived}">Active</button><button class="toggle-pill${S.showArchived ? ' active' : ''}" type="button" data-action="chat-filter" data-value="archived" aria-pressed="${S.showArchived}">Archived</button></div></div>
          ${items}
        </aside>`;
  }
  /* After a turn: new order and titles in the sidebar and the conversation list, without re-rendering the open conversation. */
  async function repaintLists() {
    try { await refreshChats(); } catch { return; }
    renderSidebar(false);
    if (S.view !== 'chat') return;
    const aside = $('.chat-list'); if (aside) aside.outerHTML = chatListHtml();
    const active = [...S.chats, ...S.archivedChats].find(c => c.id === S.activeChat);
    const title = $('.chat-title'); if (title && active) title.textContent = active.title;
  }
  function renderChat() {
    const cat = chatCat(); const showOut = prefs.chatOutput !== false;
    const active = [...S.chats, ...S.archivedChats].find(c => c.id === S.activeChat) || null;
    const archived = active && S.archivedChats.some(c => c.id === active.id);
    const tabs = `<div class="toggle-track chat-cats" role="tablist" aria-label="Category">${CHAT_CATS.map(([key, label]) => `<button class="toggle-pill${key === cat ? ' active' : ''}" type="button" role="tab" aria-selected="${key === cat}" data-action="chat-cat" data-value="${key}">${label}</button>`).join('')}</div>`;
    const top = `<header class="chat-top"><h1 tabindex="-1">Chat</h1>${tabs}<span class="chat-top-space"></span>
        <button class="icon-btn${showOut ? ' active' : ''}" type="button" data-action="toggle-output" aria-pressed="${showOut}" aria-label="${showOut ? 'Hide' : 'Show'} output panel" title="${showOut ? 'Hide' : 'Show'} output panel">${icon('panel')}</button>
        <button class="btn btn-sm" type="button" data-action="new-chat">${icon('plus')}New session</button></header>`;
    let pane;
    if (!active) {
      const first = ((S.user && S.user.displayName) || '').trim().split(/\s+/)[0];
      const recent = S.chats.filter(c => catOf(c) === cat).slice(0, 6);
      pane = `<div class="chat-pane chat-start">
          <div class="chat-start-body">
            <h2 class="chat-hello">What are we working on${first ? `, ${esc(first)}` : ''}?</h2>
            <p class="chat-hello-sub">New sessions are filed under ${esc(catLabel(cat))}. Pick up a recent one or start typing below.</p>
            ${recent.length ? `<div class="chat-recent">${recent.map(c => `<button class="chat-recent-item" type="button" data-action="open-chat" data-id="${c.id}">${icon('chat')}<span><strong>${esc(c.title)}</strong><small>${esc(stamp(c.updated_at))}</small></span></button>`).join('')}</div>` : ''}
          </div>
          <div class="chat-foot">
            <form class="chat-composer chat-card" data-form="chat-start">
              <textarea class="field field-area chat-card-input" id="chat-input" name="content" rows="2" maxlength="8000" placeholder="Make impactful sessions with our chat" aria-label="Message" data-autofocus></textarea>
              <div class="chat-bar">
                <button class="chat-plus" type="button" data-action="start-pop" data-pop="add" aria-label="Add skills, commands or session settings" title="Skills, commands and session settings">${icon('plus')}</button>
                <span class="chat-bar-space"></span>
                <button class="chat-chip" type="button" data-action="start-pop" data-pop="workflow" title="Run every message through one of your workflows">${icon('flow')}<span class="chat-chip-text">Set Workflow</span></button>
                <button class="chat-chip" type="button" data-action="start-pop" data-pop="model" title="Choose the model for this session">${icon('model')}<span class="chat-chip-text">Model Switch</span></button>
                <button class="icon-btn solid chat-send" type="submit" aria-label="Send message" title="Send (Enter)">${icon('send')}</button>
              </div>
            </form>
          </div>
        </div>`;
    } else {
      const messages = S.messages[active.id] || [];
      const moveSel = `<select class="field chat-cat-select" data-chat-move aria-label="Category"${archived ? ' disabled' : ''}>${CHAT_CATS.map(([key, label]) => `<option value="${key}"${key === catOf(active) ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
      const head = S.renamingChat
        ? `<form class="chat-head" data-form="rename-chat"><input class="field" name="title" maxlength="180" value="${esc(active.title)}" aria-label="Conversation title" data-autofocus><button class="btn btn-sm" type="submit">Save</button><button class="btn btn-sm btn-ghost" type="button" data-action="cancel-rename">Cancel</button></form>`
        : `<div class="chat-head"><span class="chat-title">${esc(active.title)}</span>${archived ? '<span class="chat-badge">Archived</span>' : ''}
            ${moveSel}
            ${archived ? '' : `<button class="icon-btn" type="button" data-action="rename-chat" aria-label="Rename conversation" title="Rename">${icon('edit')}</button>`}
            <button class="icon-btn" type="button" data-action="archive-chat" aria-label="${archived ? 'Unarchive' : 'Archive'} conversation" title="${archived ? 'Unarchive' : 'Archive'}">${icon(archived ? 'unarchive' : 'archive')}</button>
            <button class="icon-btn" type="button" data-action="delete-chat" aria-label="Delete conversation" title="Delete">${icon('trash')}</button></div>`;
      const body = messages.length
        ? messages.map(m => `<div class="msg ${esc(m.role)}">${esc(m.content)}<span class="msg-time">${esc(stamp(m.createdAt))}</span></div>`).join('')
        : '<div class="chat-empty"><p>No messages yet. Write the first one below.</p></div>';
      pane = CH ? `<div class="chat-pane">${head}${CH.pane({ chat: active, archived })}</div>` : `<div class="chat-pane">${head}<div class="chat-messages" aria-live="polite">${body}</div>
        ${archived ? '<p class="chat-note">This conversation is archived. Unarchive it to keep writing.</p>' : `<form class="chat-composer chat-card" data-form="chat"><textarea class="field field-area chat-card-input" id="chat-input" name="content" rows="2" maxlength="8000" placeholder="Make impactful sessions with our chat" aria-label="Message"></textarea><div class="chat-bar"><span class="chat-bar-space"></span><button class="icon-btn solid chat-send" type="submit" aria-label="Send message">${icon('send')}</button></div></form>`}</div>`;
    }
    const output = showOut ? `<aside class="chat-output" aria-label="Output">
        <div class="out-head"><span>Output</span><button class="icon-btn sm" type="button" data-action="toggle-output" aria-label="Hide output panel" title="Hide">${icon('x')}</button></div>
        <div class="out-body" data-chat-output>${active && CH ? CH.outputHtml(active.id) : `<p class="out-empty">${active ? 'Run details are not available.' : 'Start or open a session to see its model, workflow, skills and the details of each run here.'}</p>`}</div>
      </aside>` : '';
    return `${top}<div class="chat-layout chat-v2${showOut ? '' : ' no-output'}">${pane}${output}</div>`;
  }
  async function startChat() {
    const id = await api(() => window.workspaceData.createChat('New conversation', chatCat()));
    await refreshChats();
    S.showArchived = false; S.messages[id] = [];
    await openChat(id);
    return id;
  }
  async function openChat(id) {
    S.activeChat = id; S.renamingChat = false; followCat(id);
    if (!S.messages[id]) {
      try { S.messages[id] = await api(() => window.workspaceData.chatMessages(id)); } catch { S.messages[id] = []; }
    }
    rerender({ focus: 'chat-input' });
    const msgs = $('.chat-messages'); if (msgs) msgs.scrollTop = msgs.scrollHeight;
    if (CH) CH.open(id);
  }
  async function refreshChats() {
    const [chats, archived] = await Promise.all([window.workspaceData.chats(false), window.workspaceData.chats(true)]);
    S.chats = chats; S.archivedChats = archived;
  }
  async function newChat() {
    const id = await api(() => window.workspaceData.createChat('New conversation', chatCat()));
    await refreshChats();
    S.showArchived = false; S.messages[id] = [];
    if (S.view !== 'chat') { S.activeChat = id; go('chat', { focus: 'chat-input' }); return; }
    await openChat(id);
  }

  // ───────────────────────── menus & search
  function closeLayers() {
    for (const id of ['account-menu', 'new-menu']) { const m = $(`#${id}`); if (m) m.hidden = true; }
    $$('.rail [aria-expanded]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    const overlay = $('#search-overlay'); if (overlay) overlay.hidden = true;
    if (AF) AF.closeMenu();
  }
  function openMenu(menuId, anchor, html) {
    const menu = $(`#${menuId}`);
    const wasOpen = !menu.hidden;
    closeLayers();
    if (wasOpen) return;
    menu.innerHTML = html;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.right + 12}px`;
    menu.style.top = `${Math.max(8, rect.top - 6)}px`;
    menu.hidden = false;
    applyDynamic(menu);
    anchor.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.menu-item'); if (first) first.focus();
  }
  function openAccountMenu() {
    const u = S.user || {};
    openMenu('account-menu', $('#rail-account'), `
      <div class="menu-head"><span class="avatar" data-img="${esc(u.image || '')}">${u.image ? '' : esc(initials(u.displayName))}</span><span><div class="menu-head-name">${esc(u.displayName)}</div><div class="menu-head-mail">${esc(u.email)}</div></span></div>
      <button class="menu-item" type="button" role="menuitem" data-go="home">${icon('user')}Profile</button>
      <button class="menu-item" type="button" role="menuitem" data-go="settings">${icon('settings')}Settings</button>
      <button class="menu-item danger" type="button" role="menuitem" data-action="logout">${icon('logout')}Sign out</button>`);
  }
  function openNewMenu() {
    openMenu('new-menu', $('#rail-new'), `
      <button class="menu-item" type="button" role="menuitem" data-action="new" data-value="plan">${icon('calendar')}Schedule for today</button>
      <button class="menu-item" type="button" role="menuitem" data-action="new" data-value="whim">${icon('folder')}Project</button>
      <button class="menu-item" type="button" role="menuitem" data-action="new" data-value="routine">${icon('routine')}Routine step</button>
      <button class="menu-item" type="button" role="menuitem" data-action="new" data-value="learning">${icon('learning')}Subject</button>
      <button class="menu-item" type="button" role="menuitem" data-action="new" data-value="chat">${icon('chat')}Conversation</button>`);
  }
  function startNew(kind) {
    closeLayers();
    if (kind === 'plan') { selectDate(todayISO()); S.planTime = ''; if (S.view === 'calendar') rerenderCalendar(); else go('calendar'); if (SB) setTimeout(() => SB.create(todayISO()), 60); return; }
    if (kind === 'chat') { newChat(); return; }
    if (kind === 'whim' && PJ) { PJ.create(); return; }
    if (kind === 'learning') { if (S.view !== 'learning') go('learning'); if (LN) setTimeout(() => LN.create(), 60); return; }
    const view = LIST[kind].view;
    if (S.view === view) focusLater('list-input'); else go(view, { focus: 'list-input' });
  }

  let searchResults = []; let searchIndex = 0;
  function openSearch() {
    closeLayers();
    const overlay = $('#search-overlay');
    overlay.hidden = false;
    const input = $('#search-input');
    input.value = '';
    runSearch('');
    input.focus();
  }
  function runSearch(query) {
    const q = query.trim().toLowerCase();
    const pages = [['calendar', 'Calendar', 'calendar'], ['whim', 'Projects', 'folder'], ['routine', 'Routine', 'routine'], ['learning', 'Learning', 'learning'], ['chat', 'Chat', 'chat'], ['automation', 'Workflows', 'flow'], ['agents', 'Agents', 'agent'], ['home', 'Home', 'home'], ['settings', 'Settings', 'settings']];
    const results = [];
    for (const [view, label, ic] of pages) if (!q || label.toLowerCase().includes(q)) results.push({ icon: ic, text: label, kind: 'Page', run: () => { if (view === 'learning' && LN) LN.home(); go(view); } });
    if (q) {
      for (const p of S.items.plan) if (p.text.toLowerCase().includes(q)) results.push({ icon: 'calendar', text: p.text, kind: `Plan · ${longDate(p.day)}${p.time ? ` · ${fmtTime(p.time)}` : ''}`, run: () => { selectDate(p.day); if (S.view === 'calendar') rerenderCalendar(); else go('calendar'); } });
      if (PJ) for (const p of PJ.list()) if (p.name.toLowerCase().includes(q)) results.push({ icon: 'folder', text: p.name, kind: 'Project', run: () => PJ.open(p.id) });
      if (LN) for (const s of LN.list()) if (s.name.toLowerCase().includes(q)) results.push({ icon: 'learning', text: s.name, kind: `Subject · ${LN.profile()}`, run: () => { LN.open(s.id); if (S.view === 'learning') rerender(); else go('learning'); } });
      for (const [kind, ic, label] of [['routine', 'routine', 'Routine'], ['activity', 'activities', 'Activity']])
        for (const item of S.items[kind]) if (item.text.toLowerCase().includes(q)) results.push({ icon: ic, text: item.text, kind: kind === 'activity' ? `${label} · ${stamp(item.createdAt)}` : label, run: () => go(LIST[kind].view) });
      for (const c of [...S.chats, ...S.archivedChats]) if (c.title.toLowerCase().includes(q)) results.push({ icon: 'chat', text: c.title, kind: S.archivedChats.includes(c) ? 'Conversation · archived' : 'Conversation', run: () => { S.showArchived = S.archivedChats.includes(c); S.activeChat = c.id; if (S.view === 'chat') openChat(c.id); else { go('chat'); openChat(c.id); } } });
    }
    if (q && AF) {
      const found = AF.search();
      for (const w of found.workflows) if (w.title.toLowerCase().includes(q)) results.push({ icon: 'flow', text: w.title, kind: 'Workflow', run: () => { AF.openWorkflow(w.id); go('automation'); } });
      for (const a of found.agents) if (a.name.toLowerCase().includes(q)) results.push({ icon: 'agent', text: a.name, kind: 'Agent', run: () => { AF.openAgent(a.id); if (S.view === 'agents') rerender(); else go('agents'); } });
      for (const k of found.skills || []) if (k.name.toLowerCase().includes(q)) results.push({ icon: 'skill', text: k.name, kind: 'Skill', run: () => { AF.openSkill(k.id); if (S.view === 'skills') rerender(); else go('skills'); } });
    }
    searchResults = results.slice(0, 40); searchIndex = 0;
    paintSearch(q);
  }
  function paintSearch(q) {
    const list = $('#search-results');
    list.innerHTML = searchResults.length ? searchResults.map((r, i) => `<li><button class="search-result${i === searchIndex ? ' active' : ''}" type="button" role="option" aria-selected="${i === searchIndex}" data-index="${i}">${icon(r.icon)}<span class="sr-text">${esc(r.text)}</span><span class="sr-kind">${esc(r.kind)}</span></button></li>`).join('')
      : `<li class="search-empty">No results for “${esc(q)}”.</li>`;
  }
  function chooseResult(index) {
    const result = searchResults[index];
    if (!result) return;
    closeLayers();
    result.run();
  }

  // ───────────────────────── actions
  async function onAction(button, event) {
    const action = button.dataset.action;
    const id = button.dataset.id;
    switch (action) {
      case 'date-card': if (S.view !== 'calendar') go('calendar'); break;
      case 'nav-group': setNavGroup(id, !navGroupOpen(id)); break;
      case 'home-grip': break; // the grip moves its card by drag or arrow keys; a plain click does nothing
      case 'home-reset': {
        const before = prefs.homeLayout;
        prefs.homeLayout = null; savePrefs(); rerender();
        const first = $('.today .t-grip'); if (first) first.focus({ preventScroll: true });
        announce('Today layout reset.');
        toast('Layout reset.', { action: { label: 'Undo', run: () => { prefs.homeLayout = before; savePrefs(); if (S.view === 'home') rerender(); announce('Today layout restored.'); } } });
        break;
      }
      case 'cal-prev': shiftPeriod(-1); break;
      case 'cal-next': shiftPeriod(1); break;
      case 'cal-today': selectDate(todayISO()); S.scrollToMorning = true; rerenderCalendar(); break;
      case 'cal-view':
        if (S.view === 'settings') { prefs.calView = button.dataset.value; savePrefs(); rerender(); }
        else switchCalView(button.dataset.value);
        break;
      case 'timer': if (SB) SB.toggleTimer(button); break;
      case 'pick-day':
        if (event.detail >= 2 && prefs.calView !== 'day') { selectDate(button.dataset.day); switchCalView('day'); renderSidebar(false); break; }
        selectDate(button.dataset.day); rerenderCalendar(); break;
      case 'slot':
        if (event.target.closest('.event-chip')) break;
        selectDate(button.dataset.day); rerenderCalendar();
        break;
      case 'tslot': break; // mouse and keyboard on timed hours are handled by schedule-blocks.js
      case 'chip': selectDate(button.dataset.day); S.editing = id; rerenderCalendar(); break;
      case 'edit': S.editing = id; rerender(); break;
      case 'cancel-edit': S.editing = null; rerender(); break;
      case 'remove': await removeItem(id, button.dataset.label || 'Item').catch(() => {}); break;
      case 'open-project': if (PJ) PJ.open(id); break;
      case 'home-day': selectDate(button.dataset.day); go('calendar'); break;
      case 'home-subject': if (LN) { LN.open(id); go('learning'); } break;
      case 'edit-profile': S.editingProfile = true; rerender(); break;
      case 'cancel-profile': S.editingProfile = false; rerender({ focus: 'profile-edit-btn' }); break;
      case 'cover-position': {
        const P = ['center 20%', 'center 52%', 'center 85%'];
        await saveProfile({ coverPosition: P[(P.indexOf(S.user.coverPosition || 'center 52%') + 1) % P.length] }, { focus: button.id || undefined });
        break;
      }
      case 'change-photo': await changePhoto(button.id || undefined); break;
      case 'cover-theme': await saveProfile({ coverTheme: button.dataset.value, coverImageName: null }); break;
      case 'cover-image': {
        try { const picked = await api(() => window.account.pickImage()); if (picked) await saveProfile({ coverImageName: picked.imageName }, { focus: button.id || undefined }); } catch { /* shown */ }
        break;
      }
      case 'motion': prefs.motion = button.dataset.value; savePrefs(); applyMotionPref(); rerender(); break;
      case 'week-start': prefs.weekStart = Number(button.dataset.value); savePrefs(); rerender(); break;
      case 'time-format': prefs.timeFormat = button.dataset.value; savePrefs(); rerender(); break;
      case 'logout': await logout(); break;
      case 'new': startNew(button.dataset.value); break;
      case 'chat-cat': {
        prefs.chatCat = button.dataset.value; savePrefs();
        const current = [...S.chats, ...S.archivedChats].find(c => c.id === S.activeChat);
        if (current && catOf(current) !== chatCat()) { S.activeChat = null; S.renamingChat = false; }
        rerender(); break;
      }
      case 'toggle-output': prefs.chatOutput = prefs.chatOutput === false; savePrefs(); rerender(); break;
      case 'side-archived': S.showArchived = !S.showArchived; renderSidebar(false); break;
      case 'start-pop': { try { const chatId = await startChat(); if (CH) { await CH.open(chatId); CH.openPop(button.dataset.pop); } } catch { /* shown */ } break; }
      case 'side-chat': followCat(id); S.activeChat = id; if (!S.messages[id]) { try { S.messages[id] = await api(() => window.workspaceData.chatMessages(id)); } catch { S.messages[id] = []; } } go('chat', { focus: 'chat-input', force: true }); break;
      case 'new-chat': await newChat().catch(() => {}); break;
      case 'open-chat': await openChat(id); break;
      case 'chat-filter': S.showArchived = button.dataset.value === 'archived'; rerender(); break;
      case 'rename-chat': S.renamingChat = true; rerender(); break;
      case 'cancel-rename': S.renamingChat = false; rerender(); break;
      case 'archive-chat': {
        const archived = S.archivedChats.some(c => c.id === S.activeChat);
        try { await api(() => window.workspaceData.archiveChat(S.activeChat, !archived)); await refreshChats(); S.showArchived = !archived; rerender(); toast(archived ? 'Conversation restored.' : 'Conversation archived. Find it under Archived in the sidebar.'); } catch { /* shown */ }
        break;
      }
      case 'delete-chat': {
        const chat = [...S.chats, ...S.archivedChats].find(c => c.id === S.activeChat); if (!chat) break;
        if (!await confirmDialog({ title: 'Delete this conversation?', text: `“${chat.title}” and its messages will be permanently deleted.` })) break;
        try { await api(() => window.workspaceData.deleteChat(chat.id)); delete S.messages[chat.id]; if (CH) CH.forget(chat.id); S.activeChat = null; await refreshChats(); rerender(); toast('Conversation deleted.'); } catch { /* shown */ }
        break;
      }
      default: break;
    }
  }
  // Only the profile form closes edit mode. A photo/banner save that lands while the
  // form is open (e.g. the image picker resolved after the pencil was clicked) keeps
  // the form and the text typed so far.
  async function saveProfile(changes, { closeEdit = false, focus } = {}) {
    const u = S.user;
    const next = { displayName: u.displayName, bio: u.bio || '', imageName: u.imageName || null, coverImageName: u.coverImageName || null, coverTheme: u.coverTheme || 'aurora', coverPosition: u.coverPosition || 'center 52%', ...changes };
    try {
      const state = await api(() => window.account.saveProfile(next.displayName, next.bio, next.imageName, next.coverImageName, next.coverTheme, next.coverPosition));
      const form = $('[data-form="profile"]');
      const draft = !closeEdit && S.editingProfile && form ? { displayName: form.displayName.value, bio: form.bio.value, active: form.contains(document.activeElement) ? document.activeElement.name : null } : null;
      S.user = state.user;
      if (closeEdit) S.editingProfile = false;
      renderRail(); rerender(draft ? {} : { focus });
      if (draft) {
        const again = $('[data-form="profile"]');
        if (again) {
          again.displayName.value = draft.displayName; again.bio.value = draft.bio;
          if (draft.active && again.elements[draft.active]) again.elements[draft.active].focus();
        }
      }
      return true;
    } catch { return false; }
  }
  async function changePhoto(focus) {
    try { const picked = await api(() => window.account.pickImage()); if (picked) await saveProfile({ imageName: picked.imageName }, { focus }); } catch { /* shown */ }
  }

  async function onSubmit(form) {
    const kind = form.dataset.form;
    const data = new FormData(form);
    const textValue = String(data.get('text') || '').trim();
    if (kind === 'list') {
      if (!textValue) { form.querySelector('[name=text]').focus(); return; }
      const listKind = form.dataset.kind;
      await createItem({ kind: listKind, text: textValue }, { focus: 'list-input' }).catch(() => {});
    } else if (kind === 'home-plan') {
      if (!textValue) { form.querySelector('[name=text]').focus(); return; }
      await createItem({ kind: 'plan', text: textValue, day: todayISO() }, { focus: 'home-plan-input' }).catch(() => {});
    } else if (kind === 'edit-plan') {
      if (!textValue) { form.querySelector('[name=text]').focus(); return; }
      S.editing = null;
      await updateItem(form.dataset.id, { text: textValue, time: String(data.get('time') || '') }).catch(() => { S.editing = form.dataset.id; });
    } else if (kind === 'edit-item') {
      if (!textValue) { form.querySelector('[name=text]').focus(); return; }
      S.editing = null;
      await updateItem(form.dataset.id, { text: textValue }).catch(() => {});
    } else if (kind === 'profile') {
      const name = String(data.get('displayName') || '').trim();
      if (!name) { form.displayName.focus(); return; }
      await saveProfile({ displayName: name, bio: String(data.get('bio') || '').trim() }, { closeEdit: true, focus: 'profile-edit-btn' });
    } else if (kind === 'rename-chat') {
      const title = String(data.get('title') || '').trim();
      if (!title) return;
      try { await api(() => window.workspaceData.renameChat(S.activeChat, title)); await refreshChats(); S.renamingChat = false; rerender(); } catch { /* shown */ }
    } else if (kind === 'chat-start') {
      const content = String(data.get('content') || '').trim();
      if (!content) return;
      form.querySelector('textarea').value = '';
      try { await startChat(); if (CH) CH.send(content); else { const message = await api(() => window.workspaceData.addChatMessage(S.activeChat, content)); (S.messages[S.activeChat] = S.messages[S.activeChat] || []).push(message); rerender({ focus: 'chat-input' }); } } catch { /* shown */ }
    } else if (kind === 'chat') {
      const content = String(data.get('content') || '').trim();
      if (!content || !S.activeChat) return;
      if (CH) { CH.submit(form); return; }
      try {
        const message = await api(() => window.workspaceData.addChatMessage(S.activeChat, content));
        (S.messages[S.activeChat] = S.messages[S.activeChat] || []).push(message);
        await refreshChats();
        rerender({ focus: 'chat-input' });
        const msgs = $('.chat-messages'); if (msgs) msgs.scrollTop = msgs.scrollHeight;
      } catch { /* shown */ }
    }
  }

  // ───────────────────────── global events
  function bindWorkspace() {
    document.addEventListener('click', event => {
      const target = event.target;
      if (!target.closest('.menu') && !target.closest('#rail-account') && !target.closest('#rail-new')) {
        for (const id of ['account-menu', 'new-menu']) if (!$(`#${id}`).hidden) { $(`#${id}`).hidden = true; }
        $$('.rail [aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      }
      if (!S.user || document.body.classList.contains('is-auth')) return;
      const goButton = target.closest('[data-go]');
      if (goButton) { if (goButton.dataset.go === 'learning' && LN) LN.home(); go(goButton.dataset.go); return; }
      const actionEl = target.closest('[data-action]');
      if (actionEl && actionEl.dataset.action.startsWith('toggle-')) return; // handled on change
      if (actionEl) onAction(actionEl, event);
    });
    document.addEventListener('change', async event => {
      const el = event.target;
      if (el.matches && el.matches('[data-chat-move]')) {
        const chatId = S.activeChat; if (!chatId) return;
        try { await api(() => window.workspaceData.setChatCategory(chatId, el.value)); await refreshChats(); prefs.chatCat = el.value; savePrefs(); rerender(); toast(`Moved to ${catLabel(el.value)}.`); } catch { /* shown */ }
        return;
      }
      if (el.dataset.action === 'toggle-plan') {
        const plan = S.items.plan.find(p => p.id === el.dataset.id); if (!plan) return;
        await updateItem(plan.id, { doneOn: el.checked ? plan.day : null }).catch(() => { el.checked = !el.checked; });
      } else if (el.dataset.action === 'toggle-routine') {
        await updateItem(el.dataset.id, { doneOn: el.checked ? todayISO() : null }).catch(() => { el.checked = !el.checked; });
      }
    });
    document.addEventListener('submit', event => {
      const form = event.target.closest('[data-form]');
      if (!form) return;
      event.preventDefault();
      onSubmit(form);
    });
    document.addEventListener('keydown', event => {
      const t = event.target;
      if (t.matches && t.matches('.event-chip') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); t.click(); return; }
      if (t.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); t.form.requestSubmit(); return; }
      if (S.view === 'home' && homeKey(event)) return;
      if (event.key === 'Escape') {
        if (!$('#search-overlay').hidden || !$('#account-menu').hidden || !$('#new-menu').hidden) { closeLayers(); return; }
        if (S.editingProfile && !S.editing && !S.renamingChat) { S.editingProfile = false; rerender({ focus: 'profile-edit-btn' }); return; }
        if (S.editing || S.renamingChat || S.editingProfile) { S.editing = null; S.renamingChat = false; S.editingProfile = false; rerender(); return; }
      }
      if (!S.user || document.body.classList.contains('is-auth')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
    });
    document.addEventListener('focusout', event => {
      const form = event.target.closest && event.target.closest('[data-form="edit-plan"]');
      if (!form) return;
      if (event.relatedTarget && form.contains(event.relatedTarget)) return;
      setTimeout(() => { if (form.isConnected && S.editing === form.dataset.id) form.requestSubmit(); }, 0);
    });
    bindHomeDrag();
    $('#sidebar-toggle').addEventListener('click', toggleSidebar);
    $('#rail-account').addEventListener('click', openAccountMenu);
    $('#rail-new').addEventListener('click', openNewMenu);
    $('#rail-search').addEventListener('click', openSearch);
    for (const menuId of ['account-menu', 'new-menu']) {
      $(`#${menuId}`).addEventListener('keydown', event => {
        const items = $$('.menu-item', event.currentTarget);
        const index = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
        if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
      });
    }
    const input = $('#search-input');
    input.addEventListener('input', () => runSearch(input.value));
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); searchIndex = Math.min(searchResults.length - 1, searchIndex + 1); paintSearch(input.value); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); searchIndex = Math.max(0, searchIndex - 1); paintSearch(input.value); }
      else if (event.key === 'Enter') { event.preventDefault(); chooseResult(searchIndex); }
    });
    $('#search-results').addEventListener('click', event => { const r = event.target.closest('.search-result'); if (r) chooseResult(Number(r.dataset.index)); });
    $('#search-overlay').addEventListener('click', event => { if (event.target.id === 'search-overlay') closeLayers(); });
    // Day rollover: refresh routine ticks, Today labels and analytics after midnight.
    setInterval(() => {
      const today = todayISO();
      if (today !== S.lastToday) { S.lastToday = today; if (S.user && !document.body.classList.contains('is-auth')) rerender(); }
    }, 60000);
  }

  // ───────────────────────── boot
  async function boot() {
    if (AF) AF.init({ esc, icon, toast, confirmDialog, go, stamp, closeLayers });
    if (CH) CH.init({ esc, icon, toast, confirmDialog, go, stamp, state: () => S, rerender, repaintLists });
    if (SB) SB.init({ api, toast, confirmDialog, fmtTime, calFocus: () => S.calFocus, projects: () => (PJ ? PJ.list() : []),
      planById: id => S.items.plan.find(p => p.id === id) || null,
      changed: async () => { if (PJ && S.user) await PJ.load(S.user.id); if (S.view === 'calendar') rerenderCalendar(); } });
    if (PJ) PJ.init({ icon, toast, confirmDialog, go, stamp, api, rerender, pageHead, fmtTime, openCalendar, view: () => S.view });
    if (LN) LN.init({ icon, toast, confirmDialog, reduceMotion, view: () => S.view, refreshNav: () => renderSidebar(false) });
    applyMotionPref();
    initWindowControls();
    bindAuth();
    bindWorkspace();
    if (!window.account) { showScene('login-page'); return; }
    try { await route(await window.account.state()); }
    catch (error) { showScene('login-page'); toast(error.message || 'Could not open your account.', { error: true }); }
  }
  boot();
})();
