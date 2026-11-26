/* Quizzes and exams on the subject page: question bank, pre-test, practice with feedback, timed final exam, results, attempts and
   the pre-vs-final report (first working slice of LS-008 to LS-013, LS-023, LS-024, LS-034).
   One self-contained module: it renders into [data-qz-host] and listens on that element only (no document-level keys).
   Data goes through window.learningData (journey*, questions*, assessment*, exam*, mastery*). Answer keys never reach this file
   while an assessment is open; the main process strips them (src/learning-ipc.js) and enforces the exam deadline. */
(function () {
  'use strict';
  const D = () => window.learningData;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LEVELS = { not_assessed: 'Not assessed', emerging: 'Emerging', developing: 'Developing', proficient: 'Proficient', mastered: 'Mastered' };
  const LEVEL_ORDER = ['not_assessed', 'emerging', 'developing', 'proficient', 'mastered'];
  const TYPES = { choice: 'Multiple choice', truefalse: 'True / false', explain: 'Explain', matching: 'Matching', essay: 'Essay' };
  const KIND_LABEL = { diagnostic: 'Pre-test', practice: 'Practice', final: 'Final exam', retention: 'Retention check' };
  const DIMENSIONS = ['recognition', 'recall', 'understanding', 'application'];
  /* The journey's 13 stages (spec §2.2, stages 3–15). `built` = the app drives it today; the others read "later" and are skipped. */
  const STAGES = [
    ['material', 'Material', true, 'Add topics and write questions, then take the pre-test.'],
    ['pretest_setup', 'Pre-test setup', true, 'Choose how many questions and which types, then start the pre-test.'], ['pretest', 'Pre-test', true, 'Finish your pre-test.'],
    ['diagnostic', 'Diagnostic', true, 'See your results and mistakes, then generate targeted notes.'],
    ['targeted_notes', 'Targeted notes', true, 'Read your targeted notes, then start a study session.'],
    ['main_learning', 'Main learning', true, 'Study, then practice your mistakes.'],
    ['practice', 'Practice', true, 'Keep practising; mistakes that are due come first. Look at your final learning evaluation when ready.'],
    ['mistake_analysis', 'Mistake analysis', true, 'Review your mistakes, then do the final learning.'],
    ['supplementary', 'Supplementary', true, 'Extra study for the topics that are still weak, then practice again.'],
    ['final_learning', 'Final learning', true, 'Finish a Review study session, then take the final exam.'],
    ['final_exam', 'Final exam', true, 'Finish or review your final exam.'],
    ['report', 'Report', true, 'Open the report. Start the next cycle when you are ready.'], ['retention', 'Retention check', true, 'Your retention check result is in; start the next cycle when ready.'],
  ];
  let H = { toast: () => {}, announce: () => {} };
  const states = new Map(); // subjectId → state, so a re-render of the page keeps the quiz where it was

  function stateOf(subject) {
    if (!states.has(subject.id)) states.set(subject.id, { mode: 'home', subjectId: subject.id, name: subject.name, topics: [], questions: [], loading: true, hint: false, expanded: false, evalTab: 'diagnostic', evalCache: {}, allQuestions: [], setup: { count: 2, types: ['choice', 'truefalse', 'matching', 'explain', 'essay'] }, ai: { available: false, reason: 'Checking…' }, retention: null, schedule: [], due: 0, targeted: [], study: { active: null, notes: [], summary: null, base: 0, t0: 0 }, journey: null, assessments: [], form: { type: 'choice' }, errors: '', busy: false, exam: { count: 50, test: false, multiplier: 1 } });
    return states.get(subject.id);
  }
  /* Screen-reader announcements go through the app's polite live region (#sr-live), the same one the Home cards use. */
  const say = text => { const live = document.querySelector('#sr-live'); if (!live) return; live.textContent = ''; setTimeout(() => { live.textContent = text; }, 40); };
  const clock = seconds => { const s = Math.max(0, Math.round(seconds)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
  const minutes = seconds => (seconds == null ? 'untimed' : `${Math.round(seconds / 60)} min`);
  const fail = (S, error) => { S.errors = error && error.message ? error.message : String(error); S.busy = false; paint(S); };
  const words = text => (String(text || '').trim().match(/\S+/g) || []).length;

  async function load(S) {
    const [topics, questions, journeys, assessments] = await Promise.all([
      D().topics(S.subjectId), D().questionsList({ subjectId: S.subjectId, status: 'active' }),
      D().journeyList({ subjectId: S.subjectId }), D().assessmentList({ subjectId: S.subjectId }),
    ]);
    S.topics = (topics.rows || []).filter(r => r.kind === 'topic');
    S.periods = periodsOf(topics.rows || []); restoreScope(S); S.overview = null;
    S.questions = questions; S.assessments = assessments;
    S.allQuestions = await D().questionsList({ subjectId: S.subjectId });
    S.ai = typeof D().aiStatus === 'function' ? await D().aiStatus().catch(error => ({ available: false, reason: error.message })) : { available: false, reason: 'AI is not available in this build.' };
    S.schedule = S.journey && typeof D().scheduleList === 'function' ? await D().scheduleList({ subjectId: S.subjectId }) : [];
    S.retention = S.journey && typeof D().retentionStatus === 'function' ? await D().retentionStatus({ journeyId: S.journey.id }) : null;
    if (typeof D().reviewDue === 'function') S.due = (await D().reviewDue({ subjectId: S.subjectId })).count;
    S.targeted = S.journey && typeof D().notesList === 'function' ? await D().notesList({ journeyId: S.journey.id, kind: 'targeted_note' }) : [];
    if (typeof D().studyActive === 'function') {
      const act = await D().studyActive();
      S.study.active = act && act.session.subjectId === S.subjectId ? act : null;
      S.study.notes = S.study.active ? await D().studyNotes({ sessionId: S.study.active.session.id }) : [];
      if (S.study.active) { S.study.base = S.study.active.elapsedSeconds || 0; S.study.t0 = Date.now(); }
    }
    S.journey = journeys.filter(j => j.status !== 'archived').pop() || null;
    // Topics added after the cycle began (a new period, a new upload) join the running cycle, so a scope can include them.
    if (S.journey && S.journey.status === 'active') {
      const own = new Set((S.journey.topicIds || []).map(String)); const missing = S.topics.filter(t => !own.has(String(t.id)));
      if (missing.length) { try { S.journey = await D().journeyUpdate({ journeyId: S.journey.id, topicIds: [...own, ...missing.map(t => String(t.id))] }); } catch { /* the cycle keeps its topics */ } }
    }
  }
  /* Periods are the topic list's milestones (Prelim, Midterm, Prefi, Finals, or the student's own): each owns the topics below it. */
  function periodsOf(rows) {
    const out = []; let cur = null;
    for (const r of rows) {
      if (r.kind === 'milestone') { cur = { id: String(r.id), title: r.title, topicIds: [] }; out.push(cur); }
      else if (r.kind === 'topic' && cur) cur.topicIds.push(String(r.id));
    }
    return out.filter(x => x.topicIds.length);
  }
  // ───────── topic scope: which topics the next test draws from (empty = the entire subject). Remembered per subject in this profile.
  const scopeKey = S => `perflw-scope:${accountKey}:${S.subjectId}`;
  function restoreScope(S) {
    if (!S.scopeSel) { let saved = []; try { saved = JSON.parse(localStorage.getItem(scopeKey(S)) || '[]'); } catch { saved = []; } S.scopeSel = new Set(Array.isArray(saved) ? saved.map(String) : []); }
    const live = new Set(S.topics.map(t => String(t.id)));
    for (const id of [...S.scopeSel]) if (!live.has(id)) S.scopeSel.delete(id);
  }
  function saveScope(S) { try { localStorage.setItem(scopeKey(S), JSON.stringify([...S.scopeSel])); } catch { /* kept for this session only */ } }
  const scopeIds = S => (S.scopeSel && S.scopeSel.size ? [...S.scopeSel] : null);
  const inScope = (S, q) => !S.scopeSel || !S.scopeSel.size || S.scopeSel.has(String(q.topicId));
  function scopeLabel(S) {
    const sel = S.scopeSel; if (!sel || !sel.size) return 'Entire subject';
    const full = (S.periods || []).filter(p => p.topicIds.every(id => sel.has(id)));
    const covered = new Set(full.flatMap(p => p.topicIds));
    if (full.length && covered.size === sel.size) return full.map(p => p.title).join(' + ');
    if (sel.size === 1) { const t = S.topics.find(x => String(x.id) === [...sel][0]); return t ? t.title : '1 topic'; }
    return `${sel.size} topics`;
  }

  // ───────── rendering
  const hostOf = S => document.querySelector(`[data-qz-host][data-subject="${CSS.escape(S.subjectId)}"]`);
  const VIEWS = { setup: setupView, history: historyView, evaluation: evaluationView, templates: templatesView, notes: notesView, bank: bankView, add: addView, quiz: quizView, grade: gradeView, results: resultsView, examSetup: examSetupView, report: reportView, schedule: scheduleView };
  /* The expanded "Learning Cycle" (owner mock-up, 2026-11-26): it covers the main panel; tabs on top, the latest result on the left,
     the workspace (start, answer, results, bank, notes, history, schedule) on the right. Nothing is added below the subject page. */
  const FOCUS_MODES = ['setup', 'examSetup', 'quiz', 'grade', 'results'];
  const CYCLE_TABS = [['diagnostic', 'Pre-Test'], ['practice', 'Practice'], ['final', 'Final Exam']];
  function cycleFrame() {
    return `<div class="qz-cycle" role="region" aria-labelledby="qz-cycle-title">
      <header class="qz-cycle-head"><h2 id="qz-cycle-title" tabindex="-1">Learning Cycle <span class="qz-cycle-sub"></span></h2><button class="icon-btn qz-cycle-close" type="button" data-qz="collapse" aria-label="Close the learning cycle" title="Close (Esc)">⤡</button></header>
      <div class="qz-tabs qz-cycle-tabs" role="tablist" aria-label="Kind"></div>
      <div class="qz-cycle-body"><aside class="qz-cycle-side" data-qz-side aria-label="Status and performance"></aside>
        <div class="qz-cycle-main"><div class="qz-track-wrap" data-qz-track></div>
          <div class="qz-actions" data-qz-bar><div class="qz-tabs qz-sections" role="tablist" aria-label="Sections" data-qz-sections></div><div class="qz-actions-end"><div class="qz-scope" data-qz-scope></div><button class="btn btn-sm qz-take" type="button" data-qz-take>Take Test</button></div></div>
          <div class="qz-cycle-content" data-qz-content></div></div></div>
    </div>`;
  }
  const cycleTabs = S => CYCLE_TABS.map(([k, l]) => `<button class="qz-tab${k === S.evalTab ? ' on' : ''}" type="button" role="tab" aria-selected="${k === S.evalTab}" data-qz-cytab="${k}">${l}</button>`).join('');
  function placeOverlay(host) {
    const panel = document.getElementById('main-panel'); if (!panel || !host) return;
    const r = panel.getBoundingClientRect();
    Object.assign(host.style, { position: 'fixed', top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  /* The overlay follows the main panel: window resizes, and the sidebar collapsing or expanding (which moves and resizes the panel
     with an animation). After each change it re-measures for a few frames, so it tracks the animation and settles on the end. */
  const followPanel = () => { for (const S of states.values()) if (S.expanded) placeOverlay(hostOf(S)); };
  let settling = 0;
  function settle() {
    if (![...states.values()].some(S => S.expanded)) return;
    const start = !settling; settling = 30; // about half a second at 60 fps
    if (start) { const tick = () => { followPanel(); if (--settling > 0) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
  }
  let watchedPanel = null;
  function watchPanel() {
    const panel = document.getElementById('main-panel'); if (!panel || panel === watchedPanel) return;
    watchedPanel = panel;
    if (typeof ResizeObserver === 'function') new ResizeObserver(settle).observe(panel);
  }
  window.addEventListener('resize', settle);
  document.addEventListener('transitionrun', settle, true); // a move without a size change (the panel sliding) is caught here
  document.addEventListener('transitionend', settle, true);
  /* Right-hand sections (owner, 2026-11-26): Cycle status, Question bank, Schedule. Studying is parked for a later place. */
  const SECTIONS = [['home', 'Cycle status'], ['bank', 'Question bank'], ['schedule', 'Schedule']];
  const sectionOf = mode => (['bank', 'add', 'templates'].includes(mode) ? 'bank' : mode === 'schedule' ? 'schedule' : 'home');
  const sectionTabs = S => SECTIONS.map(([k, l]) => `<button class="qz-tab${sectionOf(S.mode) === k ? ' on' : ''}" type="button" role="tab" aria-selected="${sectionOf(S.mode) === k}" data-qz="${k}">${l}</button>`).join('');
  const ICON_LIST = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" opacity=".9"/><path d="M4.5 5h1M7 5h4.5M4.5 8h1M7 8h4.5M4.5 11h1M7 11h4.5" stroke="var(--ink)" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const ICON_CLOCK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" opacity=".9"/><circle cx="8" cy="8" r="4.2" fill="none" stroke="var(--ink)" stroke-width="1.3"/><path d="M8 5.8V8l1.5 1" fill="none" stroke="var(--ink)" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const ICON_CHART = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor"/><path d="M5 12V8M8 12V4.5M11 12V6.5" stroke="var(--ink)" stroke-width="1.8" stroke-linecap="round"/></svg>';
  /* What the next attempt of a kind would be: its item count and a time estimate (finals use the exam's own time limit). */
  async function plannedFor(S, kind) {
    const pool = S.questions.filter(q => inScope(S, q)); const approved = pool.filter(q => q.review === 'approved').length;
    const nTopics = scopeIds(S) ? scopeIds(S).length : S.topics.length;
    if (kind === 'diagnostic') { const n = Math.min(approved, Math.min(40, Math.max(1, nTopics * 2))); return { items: n, time: n ? `About ${n} min` : '—' }; }
    if (kind === 'practice') { const n = Math.min(pool.length, Math.min(10, Math.max(5, nTopics * 3))); return { items: n, time: n ? `About ${n} min` : '—' }; }
    let pv = null;
    try { pv = await D().examPreview({ subjectId: S.subjectId, journeyId: S.journey ? S.journey.id : undefined, config: { count: Number(S.exam.count) || 50, test: S.exam.test, timeMultiplier: Number(S.exam.multiplier) || 1, topicIds: scopeIds(S) || undefined } }); } catch { pv = null; }
    const limit = pv && pv.ok && pv.timeLimitSeconds ? `${Math.round(pv.timeLimitSeconds / 60)} min limit` : 'Timed';
    return { items: pv ? pv.count : Math.min(approved, 50), time: limit };
  }
  async function paintSide(S) {
    const host = hostOf(S); const side = host && host.querySelector('[data-qz-side]'); if (!side) return;
    const kind = S.evalTab;
    let d = null; try { d = await evalData(S, kind); } catch { d = null; }
    let plan = null; if (!d) { try { plan = await plannedFor(S, kind); } catch { plan = { items: 0, time: '—' }; } }
    if (S.evalTab !== kind) return; // the tab changed while this was loading
    const time = d ? (d.minutes == null ? 'Untimed' : `${d.minutes} min${d.limit ? ` of ${Math.round(d.limit / 60)}` : ''}`) : plan.time;
    const list = items => (items && items.length ? `<ul class="qz-ev-list">${items.slice(0, 6).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="qz-ev-none">—</p>');
    const pct = d && d.total ? `${Math.round((d.correct / d.total) * 100)}%` : '—';
    const stat = (value, label) => `<div class="qz-perf-stat"><span class="qz-perf-num">${value}</span><span class="qz-perf-lbl">${label}</span></div>`;
    side.innerHTML = `<section class="qz-card-panel" aria-label="Status">
        <div class="qz-status-gauge">${gauge(d ? d.correct : 0, d ? d.total : 0)}</div>
        ${d && d.exam && d.exam.passed !== null ? `<p class="${d.exam.passed ? 'qz-pass' : 'qz-fail'} qz-ev-verdict">${d.exam.passed ? '✓ Passed' : '✗ Not passed'} · pass mark ${d.exam.passMarkPercent}%</p>` : ''}
        <dl class="qz-status-rows"><div><dt>${ICON_LIST}<span>${d ? 'Items taken' : 'Current Items'}</span></dt><dd>${d ? d.total : plan.items}</dd></div>
          <div><dt>${ICON_CLOCK}<span>${d ? 'Time used' : 'Estimated Time'}</span></dt><dd>${esc(time)}</dd></div></dl>
        ${d && d.attempts > 1 ? `<p class="qz-ev-meta">Attempt ${d.attempts}</p>` : ''}</section>
      <section class="qz-card-panel" aria-labelledby="qz-perf-h"><h3 class="qz-panel-h" id="qz-perf-h">${ICON_CHART}<span>Your Performance</span></h3>
        <div class="qz-perf">${stat(pct, 'Accuracy')}${stat(d ? d.correct : '—', 'Correct')}${stat(d ? d.total - d.correct : '—', 'Incorrect')}</div>
        <p class="qz-ev-h">Strengths</p>${list(d && d.strengths)}
        <p class="qz-ev-h">Focus Areas</p>${list(d && d.focus)}</section>`;
  }
  /* Take Test: the right panel's button starts the kind of the selected tab (pre-test sheet, practice set, or the exam setup). */
  async function take(S, kind) {
    const nTopics = scopeIds(S) ? scopeIds(S).length : S.topics.length;
    if (kind === 'diagnostic') { S.setup = { ...S.setup, count: Math.min(40, Math.max(1, nTopics * 2)) }; S.mode = 'setup'; paint(S); }
    else if (kind === 'practice') await begin(S, 'practice', 'Practice', { count: Math.min(10, Math.max(5, nTopics * 3)) });
    else { S.exam = { ...S.exam, retakeOf: undefined, preview: null }; S.mode = 'examSetup'; paint(S); await refreshPreview(S); }
  }
  function paint(S) {
    const host = hostOf(S); if (!host) return;
    const body = (VIEWS[S.mode] || homeView)(S);
    host.hidden = !S.expanded;
    if (S.expanded) placeOverlay(host);
    if (!host.querySelector('.qz-cycle')) host.innerHTML = cycleFrame();
    host.querySelector('.qz-cycle-sub').textContent = S.name || '';
    host.querySelector('.qz-cycle').classList.toggle('qz-focus', FOCUS_MODES.includes(S.mode)); // setup, answering, grading, results: full width
    host.querySelector('.qz-cycle-tabs').innerHTML = cycleTabs(S);
    host.querySelector('[data-qz-track]').innerHTML = trackView(S);
    paintBar(S);
    const main = host.querySelector('[data-qz-content]');
    main.innerHTML = `<section class="qz" aria-label="Quizzes and exams">${S.errors ? `<p class="qz-error" role="alert">${esc(S.errors)}</p>` : ''}${body}</section>`;
    if (S.shown !== S.mode) { S.shown = S.mode; main.scrollTop = 0; }
    paintSide(S).catch(() => {});
    const focus = host.querySelector('[data-qz-focus]'); if (focus) focus.focus({ preventScroll: true });
    syncStudyTimer(S);
    if (S.mode === 'home' || S.mode === 'results') paintEval(S).catch(() => {});
  }
  const btn = (action, label, extra = '', cls = 'btn btn-sm') => `<button class="${cls}" type="button" data-qz="${action}" ${extra}>${label}</button>`;
  const ghost = (action, label, extra = '') => btn(action, label, extra, 'btn btn-sm btn-ghost');

  const svg = d => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const DOC = '<path d="M4 2.5h6l2.5 2.5v8.5H4z"/>';
  const STAGE_ICON = {
    material: svg('<path d="M2.5 5.5 8 3l5.5 2.5L8 8z"/><path d="M2.5 8.5 8 11l5.5-2.5"/><path d="M2.5 11.5 8 14l5.5-2.5"/>'),
    pretest_setup: svg('<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.3" fill="currentColor"/><circle cx="10" cy="8" r="1.3" fill="currentColor"/><circle cx="5" cy="12" r="1.3" fill="currentColor"/>'),
    pretest: svg('<rect x="3.5" y="3" width="9" height="11" rx="1.5"/><path d="M6 2.5h4M6 9l1.5 1.5L10.5 7"/>'),
    diagnostic: svg('<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>'),
    targeted_notes: svg(`${DOC}<path d="M6 8h4M6 10.5h3"/>`),
    main_learning: svg('<path d="M8 4.5C6.5 3.3 4.5 3 2.5 3.2v9c2-.2 4 .1 5.5 1.3 1.5-1.2 3.5-1.5 5.5-1.3v-9c-2-.2-4 .1-5.5 1.3z"/><path d="M8 4.5v9"/>'),
    practice: svg('<circle cx="8" cy="8" r="5.5"/><path d="M7 5.8v4.4L10.3 8z" fill="currentColor"/>'),
    mistake_analysis: svg('<path d="M4 13V9M8 13V4M12 13V7"/>'),
    supplementary: svg(`${DOC}<path d="M8 7v4M6 9h4"/>`),
    final_learning: svg('<path d="M4 2.5h8v11H5.5A1.5 1.5 0 0 1 4 12z"/><path d="M4 12a1.5 1.5 0 0 1 1.5-1.5H12"/>'),
    final_exam: svg('<rect x="3" y="2.5" width="10" height="11" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>'),
    report: svg(`${DOC}<path d="M6.5 11V9.5M8.5 11V7.5M10.5 11V9"/>`),
    retention: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M6 10l1.5 1.5L10.5 8.5"/>'),
  };
  const TRACK_WORD = { done: 'Completed', now: 'In progress', todo: 'Not complete' };
  function stageStates(S) {
    const j = S.journey;
    const at = j ? Math.max(0, STAGES.findIndex(x => x[0] === j.stage)) : 0;
    const finished = j && ['completed', 'done'].includes(j.status);
    return STAGES.map((x, i) => (finished || i < at ? 'done' : i === at ? 'now' : 'todo'));
  }
  /* Cycle track (owner mock-ups 2026-11-26): one stop per stage; gray = not complete, blue = in progress, green = completed.
     Each stop is focusable and shows a small tooltip (name and status) on hover or keyboard focus. */
  function trackView(S) {
    const states = stageStates(S); const last = STAGES.length - 1;
    const stops = STAGES.map(([key, label], i) => {
      const st = states[i]; const word = TRACK_WORD[st];
      const link = i ? `<span class="qz-link ${states[i - 1] === 'done' && st !== 'todo' ? (st === 'now' ? 'into' : 'done') : ''}" aria-hidden="true"></span>` : '';
      const edge = i === 0 ? ' first' : i === last ? ' last' : '';
      return `${link}<span class="qz-stop ${st}${edge}" role="listitem" tabindex="0" data-stage="${key}" aria-label="${esc(label)}: ${word}"${st === 'now' ? ' aria-current="step"' : ''}>${STAGE_ICON[key] || ''}<span class="qz-tip" aria-hidden="true"><strong>${esc(label)}</strong><span class="qz-tip-st ${st}"><i></i>${word}</span></span></span>`;
    }).join('');
    const done = states.filter(x => x === 'done').length; const at = states.indexOf('now');
    const now = STAGES[at];
    return `<div class="qz-track-card">
      <div class="qz-track-head"><h3 class="qz-panel-h">Cycle</h3><span class="qz-track-count">${at >= 0 ? `Stage ${at + 1} of ${STAGES.length}` : 'Complete'} · ${done} completed</span></div>
      <div class="qz-track" role="list" aria-label="Cycle stages">${stops}</div>
      <div class="qz-track-foot"><p class="qz-track-now">${now ? `<span class="qz-now-dot" aria-hidden="true"></span><strong>${esc(now[1])}</strong><span>${esc(now[3])}</span>` : 'This cycle is complete.'}</p>
        <span class="qz-track-key" aria-hidden="true"><i class="todo"></i>Not complete<i class="now"></i>In progress<i class="done"></i>Completed</span></div></div>`;
  }
  /* Topic picker (owner, 2026-11-26): Entire subject, whole periods (Prelim, Midterm, Prefi, Finals), or single topics. */
  function scopeView(S) {
    const sel = S.scopeSel || new Set(); const count = id => S.questions.filter(q => String(q.topicId) === String(id)).length;
    const n = S.questions.filter(q => inScope(S, q)).length;
    const button = `<button class="btn btn-sm btn-ghost qz-scope-btn" type="button" data-qz="scope" aria-haspopup="dialog" aria-expanded="${!!S.scopeOpen}" title="Choose the topics your tests use"><span class="qz-scope-k">Topics</span><span class="qz-scope-v">${esc(scopeLabel(S))}</span><span aria-hidden="true">▾</span></button>`;
    if (!S.scopeOpen) return button;
    const periods = (S.periods || []).map(p => { const on = p.topicIds.every(id => sel.has(id)); const qn = p.topicIds.reduce((a, id) => a + count(id), 0);
      return `<button class="qz-chip-btn${on ? ' on' : ''}" type="button" data-qz="scope-period" data-id="${esc(p.id)}" aria-pressed="${on}">${esc(p.title)}<span>${qn}</span></button>`; }).join('');
    const grouped = new Set((S.periods || []).flatMap(p => p.topicIds));
    const row = t => `<label class="qz-scope-topic"><input type="checkbox" data-qz-scope-topic="${esc(t.id)}"${sel.has(String(t.id)) ? ' checked' : ''}><span>${esc(t.title)}</span><span class="qz-scope-n">${count(t.id)}</span></label>`;
    const byId = new Map(S.topics.map(t => [String(t.id), t]));
    const groups = (S.periods || []).map(p => `<p class="qz-scope-h">${esc(p.title)}</p>${p.topicIds.map(id => byId.get(id)).filter(Boolean).map(row).join('')}`).join('');
    const loose = S.topics.filter(t => !grouped.has(String(t.id)));
    return `${button}<div class="qz-scope-pop" role="dialog" aria-label="Choose topics">
      <button class="qz-chip-btn wide${sel.size ? '' : ' on'}" type="button" data-qz="scope-all" aria-pressed="${!sel.size}">Entire subject<span>${S.questions.length}</span></button>
      ${periods ? `<p class="qz-scope-h">Periods</p><div class="qz-scope-chips">${periods}</div>` : ''}
      <div class="qz-scope-list">${groups}${loose.length ? `${groups ? '<p class="qz-scope-h">Other topics</p>' : '<p class="qz-scope-h">Topics</p>'}${loose.map(row).join('')}` : ''}</div>
      <div class="qz-scope-foot"><span>${n} question${n === 1 ? '' : 's'} in scope</span>${btn('scope-done', 'Done')}</div></div>`;
  }
  function scopeChanged(S, focusSel) {
    saveScope(S); paintBar(S); paintSide(S).catch(() => {});
    if (S.mode === 'setup') paint(S);
    const host = hostOf(S); const el = focusSel && host && host.querySelector(focusSel); if (el) el.focus();
  }
  function paintBar(S) {
    const host = hostOf(S); if (!host) return;
    const bar = host.querySelector('[data-qz-bar]'); if (!bar) return;
    bar.hidden = ['quiz', 'grade'].includes(S.mode);
    bar.querySelector('[data-qz-sections]').innerHTML = sectionTabs(S);
    const label = (CYCLE_TABS.find(t => t[0] === S.evalTab) || [])[1] || 'test';
    const pool = S.questions.filter(q => inScope(S, q)).length;
    const b = bar.querySelector('[data-qz-take]'); const can = pool > 0;
    b.disabled = !can; b.title = can ? `Take the ${label} · ${scopeLabel(S)}` : S.questions.length ? 'No questions in the chosen topics' : 'Add questions in the Question bank first'; b.setAttribute('aria-label', `Take the ${label}`);
    bar.querySelector('[data-qz-scope]').innerHTML = scopeView(S);
  }


  /* First-use hint on the journey hub (LS-029): dismissible, remembered per account in this browser profile. */
  let accountKey = 'anonymous';
  try { if (window.account && window.account.state) window.account.state().then(st => { const u = st && (st.user || st); accountKey = String((u && (u.id || u.email)) || 'anonymous'); }).catch(() => {}); } catch { /* keep the shared key */ }
  const hintKey = () => `perflw-learning-hint:${accountKey}`;
  const hintDismissed = () => { try { return localStorage.getItem(hintKey()) === '1'; } catch { return false; } };
  const hintView = S => (S.loading || hintDismissed() || S.assessments.length || S.questions.length > 12 ? '' : `<div class="qz-hint" role="note"><p><strong>How this works.</strong> Write a few questions for your topics, take a pre-test to see where you stand, study the weak topics, practice, then take a final exam. Your levels come from your own answers, never from a typed percentage.</p>${btn('hint-dismiss', 'Got it')}</div>`);

  function homeView(S) {
    if (S.loading) return '<p class="ln-soon" role="status">Loading your quizzes…</p>';
    if (!S.topics.length) return '<p class="ln-soon">Add topics or import a file first, then write questions for them in the Question bank.</p>';
    if (!S.overview && !S.overviewLoading) loadOverview(S);
    const O = S.overview; const hasDone = S.assessments.some(a => ['submitted', 'graded'].includes(a.status));
    const next = S.schedule.find(x => Date.parse(x.endsAt || x.startsAt) >= Date.now());
    const open = S.assessments.filter(a => ['in_progress', 'draft'].includes(a.status));
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const date = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
    const card = (title, sub, body, extra = '') => `<section class="qz-ov-card" aria-label="${esc(title)}"><div class="qz-ov-head"><h4>${esc(title)}${sub ? ` <span class="qz-ov-sub">${esc(sub)}</span>` : ''}</h4>${extra}</div>${body}</section>`;
    const waiting = '<p class="ln-soon" role="status">Loading…</p>';

    // Latest result: the last submitted test, with each topic's score
    let latest;
    const L = O && O.latest;
    if (!hasDone) latest = card('Latest result', '', '<p class="ln-soon">Nothing taken yet. Pick Pre-Test, Practice or Final Exam, then press Take Test.</p>');
    else if (!L) latest = card('Latest result', '', waiting);
    else {
      const verdict = L.exam && L.exam.passed !== null && L.exam.passed !== undefined ? `<span class="${L.exam.passed ? 'qz-pass' : 'qz-fail'}">${L.exam.passed ? '✓ Passed' : '✗ Not passed'}</span> · ` : '';
      const rows = L.topics.map(t => `<li><span>${esc(t.title)}</span><span class="qz-ov-bar" aria-hidden="true"><i style="width:${pct(t.score, t.max)}%"></i></span><span class="qz-ov-num">${fmt(t.score)}/${fmt(t.max)} · ${pct(t.score, t.max)}%</span></li>`).join('');
      latest = card('Latest result', KIND_LABEL[L.kind] || L.kind, `<p class="qz-ov-line"><strong>${esc(L.title)}</strong> · ${esc(date(L.submittedAt))} · ${verdict}${fmt(L.score)} of ${fmt(L.max)} points (${pct(L.score, L.max)}%)</p>
        <p class="qz-ov-h">Topics</p><ul class="qz-ov-topics">${rows || '<li>—</li>'}</ul>`,
        `<span class="qz-row">${S.targeted.length ? ghost('notes', `Targeted notes (${S.targeted.length})`) : ''}${ghost('results', 'Open results', `data-id="${esc(L.id)}"`)}</span>`);
    }
    const continueRow = open.length ? `<div class="qz-ov-continue"><p class="qz-ov-h">Not finished</p><ul class="qz-list">${open.map(a => `<li>${esc(a.title || KIND_LABEL[a.kind])} · ${esc(a.status === 'draft' ? 'not started' : 'in progress')} ${ghost('resume', a.status === 'draft' ? 'Start' : 'Resume', `data-id="${esc(a.id)}"`)}</li>`).join('')}</ul></div>` : '';

    // Final Learning: where each topic stands now, and what unlocks the final
    let final;
    const E = O && O.evaluation;
    if (!S.journey || !hasDone) final = card('Final Learning', S.journey ? `Cycle ${S.journey.cycle}` : '', '<p class="ln-soon">Your levels by topic appear after your first test.</p>');
    else if (!E) final = card('Final Learning', `Cycle ${S.journey.cycle}`, waiting);
    else {
      const rows = E.topics.map(t => `<tr><th scope="row">${esc(t.title || t.topicId)}</th><td><span class="qz-chip lv-${esc(t.level)}">${esc(LEVELS[t.level] || t.level)}</span></td><td>${t.items} item${t.items === 1 ? '' : 's'}</td></tr>`).join('');
      const actions = [
        S.retention && S.retention.eligible ? btn('retention', 'Retention check', 'title="A short recall check of what you should still know"') : '',
        ghost('report', 'Report', 'title="Pre-test vs now, by topic"'),
        S.journey && ['report', 'final_exam'].includes(S.journey.stage) && S.assessments.some(a => a.kind === 'final' && ['submitted', 'graded'].includes(a.status)) ? ghost('newcycle', 'Start the next cycle', 'title="A new journey; its statistics start at zero and the old ones stay"') : ''].join('');
      final = card('Final Learning', `Cycle ${E.cycle}`, `<table class="qz-table qz-ov-table"><thead><tr><th scope="col">Topics</th><th scope="col">Level</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="qz-ov-line">${E.studySessions} study session${E.studySessions === 1 ? '' : 's'} · ${E.studyMinutes} minute${E.studyMinutes === 1 ? '' : 's'} · ${E.notes} note${E.notes === 1 ? '' : 's'}</p>
        <p class="${E.ready ? 'qz-pass' : 'ln-soon'}" role="status">${E.ready ? 'Final learning done: the final exam is open.' : 'To open the final exam: finish a Review study session (it records the sections and notes you open). A test final skips this step.'}</p>
        ${S.retention && !S.retention.eligible && S.retention.eligibleOn ? `<p class="ln-soon">${esc(S.retention.reason)}</p>` : ''}`,
        `<span class="qz-row">${actions}</span>`);
    }

    // History: every assessment, newest first, with the levels right after it
    let history;
    const Hs = O && O.history;
    if (!S.assessments.length) history = card('History', '', '<p class="ln-soon">Your tests will be listed here.</p>');
    else if (!Hs) history = card('History', '', waiting);
    else {
      const rows = Hs.flatMap(j => j.assessments.map(x => ({ ...x, cycle: j.cycle }))).sort((a, b) => String(b.submittedAt || b.startedAt || '').localeCompare(String(a.submittedAt || a.startedAt || '')))
        .map(x => `<tr${x.excluded ? ' class="qz-excluded"' : ''}><th scope="row">${esc(date(x.submittedAt || x.startedAt))}</th><td>${esc(KIND_LABEL[x.kind] || x.kind)}${x.attempt > 1 ? ` (attempt ${x.attempt})` : ''}${Hs.length > 1 ? ` · cycle ${x.cycle}` : ''}</td><td>${x.excluded ? `${esc(x.status.replace('_', ' '))} · not counted` : `${fmt(x.score)} of ${fmt(x.max)} (${x.percent}%)`}</td><td>${x.levels ? x.levels.map(l => `${esc(l.title || l.topicId)}: ${esc(LEVELS[l.level])}`).join(' · ') : '—'}</td></tr>`).join('');
      history = card('History', '', rows ? `<table class="qz-table qz-ov-table"><thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Score</th><th scope="col">Levels after it</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="ln-soon">Nothing submitted yet.</p>');
    }
    return `${hintView(S)}${studyView(S)}
      <p class="ln-soon qz-ov-meta">${S.questions.length} question${S.questions.length === 1 ? '' : 's'} in your bank.${S.due ? ` ${S.due} practice item${S.due === 1 ? ' is' : 's are'} due.` : ''}${next ? ` Next scheduled: ${esc(SCHED_KIND[next.kind] || next.kind)} · ${esc(when(next.startsAt))}.` : ''}</p>
      ${continueRow}<div class="qz-ov">${latest}${final}${history}</div>`;
  }
  const fmt = n => (Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString());
  /* The data behind the Cycle status cards; read once per load, repainted when it arrives. The evaluation is read with `peek`
     right after a pre-test, so seeing the card does not count as the final-learning step until you have studied. */
  async function loadOverview(S) {
    S.overviewLoading = true;
    try {
      const done = S.assessments.filter(a => ['submitted', 'graded'].includes(a.status)).sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
      const last = done[done.length - 1];
      const [results, evaluation, history] = await Promise.all([
        last ? D().assessmentResults({ assessmentId: last.id }) : null,
        S.journey && done.length ? D().journeyEvaluation({ journeyId: S.journey.id, peek: S.journey.stage !== 'main_learning' }) : null,
        S.assessments.length ? D().learningHistory({ subjectId: S.subjectId }) : null,
      ]);
      let latest = null;
      if (results) {
        const byTopic = new Map();
        for (const i of results.items) { const k = String(i.topicId); const t = byTopic.get(k) || { score: 0, max: 0 }; t.score += (i.answer && i.answer.score) || 0; t.max += i.maxScore; byTopic.set(k, t); }
        const title = id => (S.topics.find(t => String(t.id) === id) || {}).title || 'Topic';
        const tot = [...byTopic.values()].reduce((a, t) => ({ score: a.score + t.score, max: a.max + t.max }), { score: 0, max: 0 });
        latest = { id: last.id, kind: last.kind, title: last.title || KIND_LABEL[last.kind], submittedAt: results.submittedAt || last.submittedAt, exam: results.exam || null, score: tot.score, max: tot.max,
          topics: [...byTopic].map(([id, t]) => ({ title: title(id), ...t })) };
      }
      if (evaluation && S.journey && S.journey.stage === 'main_learning') S.journey.stage = 'final_learning'; // the full look moved it on
      S.overview = { latest, evaluation, history };
    } catch (error) { S.overview = { latest: null, evaluation: null, history: null, error: error.message }; }
    S.overviewLoading = false;
    if (S.mode === 'home') paint(S);
  }

  const SCHED_KIND = { session: 'Study session', practice: 'Practice', retention: 'Retention check', final: 'Final exam' };
  const pad2 = n => String(n).padStart(2, '0');
  const localInput = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const minutesOf = x => (x.endsAt ? Math.max(1, Math.round((Date.parse(x.endsAt) - Date.parse(x.startsAt)) / 60000)) : null);
  function scheduleView(S) {
    const edit = S.schedEdit ? S.schedule.find(x => x.id === S.schedEdit) : null;
    const kind = edit ? edit.kind : (S.schedForm && S.schedForm.kind) || 'session';
    const nowMs = Date.now();
    const rowOf = x => {
      const due = Date.parse(x.startsAt) <= nowMs + 15 * 60000 && Date.parse(x.endsAt || x.startsAt) >= nowMs;
      const mins = minutesOf(x);
      return `<li class="qz-sched-row${x.id === S.schedEdit ? ' editing' : ''}"><div><p class="qz-q-prompt">${esc(SCHED_KIND[x.kind] || x.kind)}</p><p class="ln-soon">${esc(when(x.startsAt))}${mins ? ` · ${mins} min` : ''}</p></div>
        <span class="qz-row">${due && x.kind !== 'session' ? btn('sched-start', 'Start', `data-kind="${esc(x.kind)}"`) : ''}${ghost('sched-edit', 'Edit', `data-id="${esc(x.id)}"`)}${ghost('sched-cancel', 'Remove', `data-id="${esc(x.id)}"`)}</span>
        ${S.confirmSched === x.id ? `<span class="qz-confirm" role="alert">Remove this from your calendar? ${btn('sched-remove-yes', 'Remove', `data-id="${esc(x.id)}"`)} ${ghost('sched-remove-no', 'Keep')}</span>` : ''}</li>`;
    };
    const upcoming = S.schedule.filter(x => Date.parse(x.endsAt || x.startsAt) >= nowMs);
    const past = S.schedule.filter(x => Date.parse(x.endsAt || x.startsAt) < nowMs);
    return `<p class="ln-soon">Plan study sessions, practice, retention checks and the final. Each one is also added to your calendar.</p>
      <form class="qz-form qz-sched-form" data-qz-form="schedule" novalidate><p class="qz-journey-title"><strong>${edit ? 'Edit scheduled item' : 'Add to the schedule'}</strong></p><span class="qz-opt-row">
        <label class="ln-field"><span>What</span><select class="field" name="kind">${Object.entries(SCHED_KIND).map(([k, v]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="ln-field"><span>Starts</span><input class="field" name="startsAt" type="datetime-local" required value="${edit ? esc(localInput(edit.startsAt)) : ''}" data-qz-focus></label>
        <label class="ln-field"><span>Duration (minutes)</span><input class="field" name="minutes" type="number" min="5" max="600" step="5" value="${edit ? esc(minutesOf(edit) || 45) : 45}"></label></span>
        <div class="qz-row"><button class="btn btn-sm" type="submit">${edit ? 'Save changes' : 'Add to calendar'}</button>${edit ? ghost('sched-new', 'Cancel') : ''}</div></form>
      <p class="qz-journey-title"><strong>Upcoming</strong></p>${upcoming.length ? `<ul class="qz-list qz-sched-list" aria-label="Upcoming">${upcoming.map(rowOf).join('')}</ul>` : '<p class="ln-soon">Nothing scheduled.</p>'}
      ${past.length ? `<p class="qz-journey-title"><strong>Past</strong></p><ul class="qz-list qz-sched-list" aria-label="Past">${past.map(rowOf).join('')}</ul>` : ''}`;
  }

  function studyView(S) {
    const st = S.study; const a = st.active;
    if (a) {
      const notes = st.notes.map(n => `<li class="qz-note"><p>${esc(n.text || '(empty)')}</p><p class="qz-row">${ghost('check-note', 'Check my note', S.ai.available ? `data-id="${esc(n.id)}" title="The AI reads your note and your file and suggests gaps; it never changes your note"` : `disabled title="${esc(S.ai.reason)}"`)}</p>${(n.aiHelp || []).map(h => `<div class="qz-feedback"><p><span class="qz-chip">AI · suggestion</span>${h.provenance ? ` ${esc(h.provenance.model)}` : ''}</p><pre class="qz-md">${esc(h.text)}</pre></div>`).join('')}</li>`).join('');
      return `<div class="qz-study" role="group" aria-label="Study session"><p><strong>Studying${a.topicTitle ? `: ${esc(a.topicTitle)}` : ''}</strong> · <span class="qz-timer" data-qz-study-time>${a.elapsedSeconds == null ? 'timer stopped' : clock(st.base + (Date.now() - st.t0) / 1000)}</span></p>
        <p class="ln-soon">Open topics in the viewer while you study; what you open is recorded for the retake check. Your notes below are yours alone.</p>
        <form class="qz-form" data-qz-form="note" novalidate><label class="ln-field"><span>Side note</span><textarea class="field field-area" name="text" rows="3" maxlength="20000"></textarea></label>
          <div class="qz-row"><button class="btn btn-sm" type="submit">Add note</button>${btn('study-end', 'End session')}</div></form>
        ${notes ? `<ul class="qz-notes" aria-label="Notes from this session">${notes}</ul>` : ''}</div>`;
    }
    const sum = st.summary;
    const done = sum ? `<div class="qz-feedback" role="status"><p><strong>Session saved</strong> · ${sum.durationSeconds == null ? 'no time entry' : clock(sum.durationSeconds)}${sum.topics.length ? ` · ${esc(sum.topics.join(', '))}` : ''} · ${sum.notes} note${sum.notes === 1 ? '' : 's'}</p>${sum.message ? `<p class="ln-soon">${esc(sum.message)}</p>` : ''}<p class="qz-row">${btn('practice', 'Practice now')}</p></div>` : '';
    return done; // starting a session from here is parked (owner, 2026-11-26); the header's Start your session still works
  }

  /* D13: notes opened during a study session count as visited (the retake gate reads them). */
  async function visitNotes(S) {
    if (!S.study.active || !S.notesShown || !S.notesShown.length) return;
    try { await D().studyVisit({ sessionId: S.study.active.session.id, materials: S.notesShown.map(n => n.id) }); } catch { /* the notes stay readable */ }
  }
  function setupView(S) {
    const types = ['choice', 'truefalse', 'matching', 'explain', 'essay'];
    const chosen = S.setup.types; const usable = S.questions.filter(q => chosen.includes(q.type) && q.review === 'approved' && inScope(S, q));
    const want = Math.max(1, Math.min(40, Number(S.setup.count) || 1));
    const short = usable.length < want;
    return `<form class="qz-form" data-qz-form="setup" novalidate><p>Pre-test: a short check of where you stand before you study. About 2 questions per topic is a good start. You answer everything first; you see what was right and wrong after you submit.</p>
      <label class="ln-field"><span>How many questions (1–40)</span><input class="field" name="count" type="number" min="1" max="40" value="${esc(want)}" data-qz-focus></label>
      <fieldset class="qz-fs"><legend>Question types</legend>${types.map(t => `<label><input type="checkbox" name="type" value="${t}"${chosen.includes(t) ? ' checked' : ''}> ${esc(TYPES[t])}</label>`).join(' ')}</fieldset>
      <p class="${usable.length ? 'ln-soon' : 'qz-error'}" role="status">${usable.length} approved question${usable.length === 1 ? '' : 's'} match${short && usable.length ? `. Only ${usable.length} are available, so the pre-test will have ${usable.length}. Start with those, or add more in the question bank.` : usable.length ? ' your choice.' : ' nothing yet. Pick other types or add questions in the question bank.'}</p>
      <div class="qz-row"><button class="btn btn-sm" type="submit"${usable.length ? '' : ' disabled'}>Start pre-test</button>${ghost('home', 'Cancel')}</div></form>`;
  }
  function evaluationView(S) {
    const E = S.evaluation;
    const rows = E.topics.map(t => `<tr><th scope="row">${esc(t.title || t.topicId)}</th><td><span class="qz-chip">${esc(LEVELS[t.level] || t.level)}</span></td><td>${t.items} item${t.items === 1 ? '' : 's'}</td></tr>`).join('');
    const weak = E.weak.map(w => `<li>${esc(w.title || w.topicId)} · ${esc(LEVELS[w.level] || w.level)}</li>`).join('');
    return `<p class="qz-score" tabindex="-1" data-qz-focus>Final learning · cycle ${E.cycle}</p>
      <p>${E.studySessions} study session${E.studySessions === 1 ? '' : 's'} · ${E.studyMinutes} minute${E.studyMinutes === 1 ? '' : 's'} · ${E.notes} note${E.notes === 1 ? '' : 's'} · evidence: ${Object.entries(E.evidenceByKind).map(([k, n]) => `${n} ${esc(KIND_LABEL[k] || k)}`).join(', ') || 'none yet'}</p>
      <table class="qz-table" tabindex="0"><caption>Where you stand now, by topic</caption><thead><tr><th scope="col">Topic</th><th scope="col">Level</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table>
      ${weak ? `<p class="qz-journey-title"><strong>Weakest first</strong></p><ol class="qz-cats">${weak}</ol>` : ''}
      <p class="${E.ready ? 'qz-pass' : 'ln-soon'}" role="status">${E.ready ? 'Final learning done: the final exam is open.' : 'To open the final exam: look through this evaluation, then run and end a Review study session (it records the sections and notes you open). A test final skips this step.'}</p>
      <div class="qz-row">${E.ready ? btn('exam', 'Set up the final') : ''}${ghost('home', 'Back')}</div>`;
  }
  function historyView(S) {
    const blocks = S.history.map(j => {
      const rows = j.assessments.map(x => `<tr${x.excluded ? ' class="qz-excluded"' : ''}><th scope="row">${esc((x.submittedAt || x.startedAt || '').slice(0, 10) || '—')}</th><td>${esc(KIND_LABEL[x.kind] || x.kind)}${x.attempt > 1 ? ` (attempt ${x.attempt})` : ''}</td><td>${x.excluded ? `${esc(x.status.replace('_', ' '))} · not counted` : `${x.score} of ${x.max} (${x.percent}%)`}</td><td>${x.levels ? x.levels.map(l => `${esc(l.title || l.topicId)}: ${esc(LEVELS[l.level])}`).join(' · ') : '—'}</td></tr>`).join('');
      return `<section aria-label="Cycle ${j.cycle}"><p class="qz-journey-title"><strong>Cycle ${j.cycle}</strong> · ${esc(j.title)} · ${esc(j.status)}</p>${rows ? `<table class="qz-table" tabindex="0"><caption>Every assessment, with your levels right after it</caption><thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Score</th><th scope="col">Levels after it</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="ln-soon">Nothing taken in this cycle yet.</p>'}</section>`;
    }).join('');
    return `<p class="qz-score" tabindex="-1" data-qz-focus>History</p>${blocks || '<p class="ln-soon">No journey yet.</p>'}<p class="ln-soon">Earlier cycles stay as they were; each cycle's statistics start at zero.</p><div class="qz-row">${ghost('home', 'Back')}</div>`;
  }
  function notesView(S) {
    const notes = S.notesShown || [];
    const items = notes.map(n => `<li class="qz-q"><p class="qz-q-prompt">${esc(n.title)}</p><pre class="qz-md">${esc(n.text || '(empty)')}</pre></li>`).join('');
    return `<p class="ln-soon" role="status">Built from your own mistakes, with no AI. Each note says what you answered, the right answer and why.</p><ul class="qz-qlist">${items || '<li>No notes yet.</li>'}</ul><div class="qz-row">${ghost('home', 'Back', 'data-qz-focus')}</div>`;
  }

  function bankView(S) {
    const f = S.bankFilter || {};
    const list = S.allQuestions.filter(x => (!f.topicId || String(x.topicId) === String(f.topicId)) && (!f.type || x.type === f.type) && (f.retired ? true : x.status === 'active'));
    const topicTitle = id => (S.topics.find(t => String(t.id) === String(id)) || {}).title || 'No topic';
    const rows = list.map(x => `<li class="qz-q"><p class="qz-q-prompt">${esc(x.prompt)}</p><p class="ln-soon">${esc(TYPES[x.type] || x.type)} · ${esc(topicTitle(x.topicId))} · ${esc(x.dimension)} · ${['', 'easy', 'medium', 'hard'][x.difficulty] || ''}${x.used ? ' · used in an assessment' : ''}${x.status === 'retired' ? ' · retired' : ''}${x.review !== 'approved' ? ` · ${esc(x.review)}` : ''}</p>
      <span class="qz-row">${x.review === 'unreviewed' ? `<span class="qz-chip">AI · not reviewed</span>${btn('q-approve', 'Approve', `data-id="${esc(x.id)}"`)}${ghost('q-reject', 'Reject', `data-id="${esc(x.id)}"`)}` : ''}${ghost('edit', 'Edit', `data-id="${esc(x.id)}"`)}${x.status === 'active' ? ghost('retire', 'Retire', `data-id="${esc(x.id)}"`) : ghost('restore', 'Restore', `data-id="${esc(x.id)}"`)}${x.used ? '' : ghost('delete', 'Delete', `data-id="${esc(x.id)}"`)}</span>${S.confirmDelete === x.id ? `<span class="qz-confirm" role="alert">Delete this question for good? ${btn('delete-yes', 'Delete', `data-id="${esc(x.id)}"`)} ${ghost('delete-no', 'Keep')}</span>` : ''}</li>`).join('');
    const topics = S.topics.map(t => `<option value="${esc(t.id)}"${String(f.topicId) === String(t.id) ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
    const types = Object.keys(TYPES).map(k => `<option value="${k}"${f.type === k ? ' selected' : ''}>${TYPES[k]}</option>`).join('');
    const topicOpts = S.topics.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
    const ai = `<div class="qz-ai" role="group" aria-label="Write questions with AI"><span class="qz-opt-row"><label class="ln-field"><span>AI question writer</span><select class="field" data-qz-ai-topic>${topicOpts}</select></label><label class="ln-field"><span>How many</span><input class="field" data-qz-ai-count type="number" min="1" max="10" value="5"></label>${btn('ai-generate', 'Generate with AI', S.ai.available ? 'title="Drafts from your file, each quoting it; they wait for your review"' : `disabled title="${esc(S.ai.reason)}"`)}</span>${S.ai.available ? '' : `<p class="ln-soon">${esc(S.ai.reason)} You can still write your own questions and use the template drafts.</p>`}</div>`;
    return `<div class="qz-row">${btn('add', 'Add question', 'data-qz-focus')}${ghost('templates', 'Template drafts', 'title="Draft questions built from your analysed files, no AI"')}</div>${ai}<form class="qz-form qz-filter" data-qz-form="bank-filter" novalidate><span class="qz-opt-row"><label class="ln-field"><span>Topic</span><select class="field" name="topicId"><option value="">All topics</option>${topics}</select></label><label class="ln-field"><span>Type</span><select class="field" name="type"><option value="">All types</option>${types}</select></label></span>
      <label class="qz-dk"><input type="checkbox" name="retired"${f.retired ? ' checked' : ''}> Show retired questions</label></form>
      <p class="ln-soon" role="status">${list.length} question${list.length === 1 ? '' : 's'}.</p>
      ${rows ? `<ul class="qz-qlist">${rows}</ul>` : '<p class="ln-soon">No questions match. Write your first one with Add question.</p>'}`;
  }

  function templatesView(S) {
    const T = S.templates || { drafts: [], analysed: 0, files: 0 };
    const rows = T.drafts.map(d => `<li class="qz-q"><p class="qz-q-prompt">${esc(d.prompt)}</p><p class="ln-soon">${esc(TYPES[d.type] || d.type)} · from "${esc((d.source[0] || {}).section || '')}" · “${esc((d.source[0] || {}).quote || '')}”</p>
      <span class="qz-row">${btn('tpl-accept', 'Accept', `data-id="${esc(d.id)}"`)}${ghost('tpl-skip', 'Skip', `data-id="${esc(d.id)}"`)}</span></li>`).join('');
    const empty = !T.files ? 'These topics have no file yet. Upload a file as a topic and its analysis will give drafts here.' : !T.analysed ? 'Your files are still being analysed. Try again in a moment.' : 'No more drafts: everything useful is already in your bank.';
    return `<p class="ln-soon" role="status">Drafts are built from your files' sections and key points, with no AI. Nothing is saved until you accept it.</p>
      ${rows ? `<ul class="qz-qlist">${rows}</ul><div class="qz-row">${btn('tpl-all', `Accept all ${T.drafts.length}`)}${ghost('bank', 'Back')}</div>` : `<p class="ln-soon">${empty}</p><div class="qz-row">${ghost('bank', 'Back', 'data-qz-focus')}</div>`}`;
  }

  function addView(S) {
    const f = S.form; const type = f.type;
    const topicOptions = S.topics.map(t => `<option value="${esc(t.id)}"${String(f.topicId) === String(t.id) ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
    const typeOptions = ['choice', 'truefalse', 'matching', 'explain', 'essay'].map(k => `<option value="${k}"${type === k ? ' selected' : ''}>${TYPES[k]}</option>`).join('');
    const text = (name, label, value, max = 500) => `<label class="ln-field"><span>${label}</span><input class="field" name="${name}" maxlength="${max}" value="${esc(value || '')}"></label>`;
    let fields = '';
    if (type === 'choice') {
      fields = [0, 1, 2, 3].map(i => `<label class="ln-field qz-opt"><span>Option ${i + 1}</span><span class="qz-opt-row"><input class="field" name="opt${i}" maxlength="500" value="${esc((f.opts || [])[i] || '')}"><label class="qz-correct"><input type="radio" name="correct" value="${i}"${Number(f.correct || 0) === i ? ' checked' : ''}> Correct</label></span></label>`).join('');
    } else if (type === 'truefalse') {
      fields = `${text('statement', 'Statement', f.statement, 2000)}<fieldset class="qz-fs"><legend>The statement is</legend><label><input type="radio" name="tf" value="true"${f.tf !== 'false' ? ' checked' : ''}> True</label> <label><input type="radio" name="tf" value="false"${f.tf === 'false' ? ' checked' : ''}> False</label></fieldset>`;
    } else if (type === 'matching') {
      fields = `<p class="ln-soon">Write 2 to 4 pairs. The right side is shuffled when you take the quiz. An extra right item that matches nothing is allowed.</p>`
        + [0, 1, 2, 3].map(i => `<span class="qz-opt-row"><input class="field" name="left${i}" maxlength="500" placeholder="Left ${i + 1}" aria-label="Left item ${i + 1}" value="${esc((f.left || [])[i] || '')}"><input class="field" name="right${i}" maxlength="500" placeholder="Matches ${i + 1}" aria-label="Right item ${i + 1}" value="${esc((f.right || [])[i] || '')}"></span>`).join('')
        + text('extra', 'Extra right item (optional)', f.extra);
    } else {
      fields = [0, 1].map(i => text(`crit${i}`, `What a good answer covers (${i + 1})`, (f.crit || [])[i])).join('')
        + (type === 'essay' ? `<span class="qz-opt-row"><label class="ln-field"><span>Minimum words</span><input class="field" name="minWords" type="number" min="0" max="5000" value="${esc(f.minWords == null ? 0 : f.minWords)}"></label><label class="ln-field"><span>Maximum words</span><input class="field" name="maxWords" type="number" min="1" max="5000" value="${esc(f.maxWords == null ? 500 : f.maxWords)}"></label></span>` : '');
    }
    const dims = DIMENSIONS.map(d => `<option value="${d}"${(f.dimension || (type === 'explain' ? 'recall' : type === 'essay' ? 'understanding' : 'recognition')) === d ? ' selected' : ''}>${d[0].toUpperCase()}${d.slice(1)}</option>`).join('');
    return `<form class="qz-form" data-qz-form="add" novalidate>
      ${S.editId ? '<p class="ln-soon">Editing a question. Past assessments keep the version they used.</p>' : ''}
      <label class="ln-field"><span>Type</span><select class="field" name="type" data-qz-type>${typeOptions}</select></label>
      <label class="ln-field"><span>Topic</span><select class="field" name="topicId">${topicOptions}</select></label>
      <label class="ln-field"><span>Question</span><textarea class="field field-area" name="prompt" rows="2" maxlength="2000" data-qz-focus>${esc(f.prompt || '')}</textarea></label>
      ${fields}
      <span class="qz-opt-row"><label class="ln-field"><span>Skill tested</span><select class="field" name="dimension">${dims}</select></label>
        <label class="ln-field"><span>Difficulty</span><select class="field" name="difficulty">${[1, 2, 3].map(d => `<option value="${d}"${Number(f.difficulty || 2) === d ? ' selected' : ''}>${['', 'Easy', 'Medium', 'Hard'][d]}</option>`).join('')}</select></label></span>
      <label class="ln-field"><span>Explanation (shown after you answer)</span><textarea class="field field-area" name="explanation" rows="2" maxlength="2000">${esc(f.explanation || '')}</textarea></label>
      <div class="qz-row"><button class="btn btn-sm" type="submit"${S.busy ? ' disabled' : ''}>${S.editId ? 'Save changes' : 'Save question'}</button>${ghost('bank', S.editId ? 'Cancel' : 'Done')}</div>
    </form>`;
  }

  // ───────── answering
  const hasAnswer = a => a && (a.dontKnow || (a.response && ((a.response.choice || []).length || (a.response.pairs || []).length || typeof a.response.value === 'boolean' || (a.response.text || '').trim())));
  function control(item, answer, locked, fb) {
    const q = item.question; const p = q.payload || {}; const r = (answer && answer.response) || {}; const dis = locked ? ' disabled' : '';
    const mark = (right, picked) => (fb && fb.status === 'graded' ? (right ? ' right' : picked ? ' wrong' : '') : '');
    const word = (right, picked) => (fb && fb.status === 'graded' ? (right && picked ? '<em class="qz-mark">✓ Correct</em>' : right ? '<em class="qz-mark">✓ The answer</em>' : picked ? '<em class="qz-mark">✗ Your answer</em>' : '') : '');
    if (q.type === 'choice') {
      const picked = new Set(r.choice || []);
      const correct = new Set((fb && fb.key && fb.key.correct) || []);
      return `<div role="${p.multiple ? 'group' : 'radiogroup'}" aria-label="Answers" class="qz-choices">${(p.options || []).map((o, i) => `<label class="qz-choice${mark(correct.has(o.id), picked.has(o.id))}"><input type="${p.multiple ? 'checkbox' : 'radio'}" name="choice" value="${esc(o.id)}"${picked.has(o.id) ? ' checked' : ''}${dis}><span><kbd>${'ABCDEFGH'[i]}</kbd> ${esc(o.text)} ${word(correct.has(o.id), picked.has(o.id))}</span></label>`).join('')}</div>`;
    }
    if (q.type === 'truefalse') return `<div role="radiogroup" aria-label="True or false" class="qz-choices"><p>${esc(p.statement)}</p>${['true', 'false'].map(v => { const picked = typeof r.value === 'boolean' && r.value === (v === 'true'); const right = fb && fb.key && fb.key.correct === (v === 'true'); return `<label class="qz-choice${mark(right, picked)}"><input type="radio" name="tf" value="${v}"${picked ? ' checked' : ''}${dis}><span><kbd>${v === 'true' ? 'T' : 'F'}</kbd> ${v === 'true' ? 'True' : 'False'} ${word(right, picked)}</span></label>`; }).join('')}</div>`;
    if (q.type === 'matching') {
      const given = new Map((r.pairs || []).map(([l, rt]) => [l, rt]));
      const right = (p.right || []).map(o => `<option value="${esc(o.id)}">${esc(o.text)}</option>`).join('');
      const truth = new Map(((fb && fb.key && fb.key.pairs) || []).map(([l, rt]) => [l, rt]));
      return `<div class="qz-choices" aria-label="Match each item">${(p.left || []).map(l => `<label class="qz-match${fb && fb.status === 'graded' ? (given.get(l.id) === truth.get(l.id) ? ' right' : ' wrong') : ''}"><span>${esc(l.text)}${fb && fb.status === 'graded' ? (given.get(l.id) === truth.get(l.id) ? ' <em class="qz-mark">✓ Correct</em>' : ` <em class="qz-mark">✗ Should be ${esc(((p.right || []).find(x => x.id === truth.get(l.id)) || {}).text || '')}</em>`) : ''}</span><select class="field" name="match:${esc(l.id)}"${dis}><option value="">Choose…</option>${right.replace(`value="${esc(given.get(l.id))}"`, `value="${esc(given.get(l.id))}" selected`)}</select></label>`).join('')}</div>`;
    }
    if (q.type === 'essay' || q.type === 'explain') {
      const max = q.type === 'essay' ? p.maxWords : p.maxWords; const min = q.type === 'essay' ? p.minWords : 0;
      return `<textarea class="field field-area" name="text" rows="${q.type === 'essay' ? 10 : 5}" maxlength="20000" aria-label="Your answer"${dis}>${esc(r.text || '')}</textarea><p class="qz-count ln-soon" data-qz-count>${words(r.text)} words${max ? ` · aim for ${min ? `${min}–` : 'up to '}${max}` : ''}</p>`;
    }
    return `<p class="ln-soon">This question type (${esc(TYPES[q.type] || q.type)}) is not supported here. Skip it.</p>`;
  }

  function feedbackView(S, item, f) {
    const q = item.question; const p = q.payload || {};
    const state = f.status === 'pending' ? 'Written answer: compare with the model below' : f.score >= f.max ? '✓ Correct' : f.score > 0 ? '◐ Partly correct' : f.category === 'not_known' ? "You didn't know this one" : '✗ Incorrect';
    let key = '';
    if (q.type === 'choice') key = (f.key.correct || []).map(id => (p.options.find(o => o.id === id) || {}).text).join(', ');
    else if (q.type === 'truefalse') key = f.key.correct ? 'True' : 'False';
    else if (q.type === 'matching') key = (f.key.pairs || []).map(([l, r]) => `${(p.left.find(x => x.id === l) || {}).text} → ${(p.right.find(x => x.id === r) || {}).text}`).join('; ');
    else key = [f.key.modelAnswer, (f.key.rubric || []).length ? `A good answer covers: ${f.key.rubric.map(c => c.criterion).join('; ')}` : ''].filter(Boolean).join(' ');
    return `<div class="qz-feedback" role="status"><p><strong>${esc(state)}</strong>${f.status === 'graded' ? ` · ${f.score}/${f.max}${f.attempt === 2 ? ' (second try, counts half)' : ''}` : ''}</p>${f.retryable ? `<p class="qz-row">${btn('retry', 'Try again (counts half)', `data-item="${esc(item.id)}"`)}</p>` : ''}${key ? `<p>${f.status === 'pending' ? 'Model' : 'Correct'}: ${esc(key)}</p>` : ''}${f.explanation ? `<p class="ln-soon">${esc(f.explanation)}</p>` : ''}</div>`;
  }

  /* Quizzes (practice) reveal the result the moment the answer is complete: one pick for single-answer choice and true/false, every
     pair chosen for matching, or "I don't know". Written and multiple-answer questions keep a Check button. Tests and exams
     (pre-test, final) do not reveal anything until everything is answered and submitted. */
  const instantType = item => { const q = item.question; return (q.type === 'choice' && !(q.payload && q.payload.multiple)) || q.type === 'truefalse' || q.type === 'matching'; };
  const completeNow = (item, response) => {
    if (response.dontKnow) return true;
    const q = item.question;
    if (q.type === 'choice') return !(q.payload && q.payload.multiple) && (response.choice || []).length === 1;
    if (q.type === 'truefalse') return typeof response.value === 'boolean';
    if (q.type === 'matching') return (response.pairs || []).length === ((q.payload && q.payload.left) || []).length;
    return false;
  };
  async function autoCheck(S) {
    const Q = S.quiz; if (!Q || Q.checking) return; Q.checking = true;
    try {
      if (!(await saveNow(S))) { paint(S); return; }
      const item = Q.assessment.items[Q.index];
      Q.checked[item.id] = await D().assessmentCheck({ assessmentId: Q.assessment.id, itemId: item.id }); paint(S);
      say(Q.checked[item.id].status === 'graded' ? (Q.checked[item.id].score >= Q.checked[item.id].max ? 'Correct.' : 'Not quite.') : 'Compare with the model answer.');
    } catch (error) { fail(S, error); } finally { Q.checking = false; }
  }
  function quizView(S) {
    const Q = S.quiz; const items = Q.assessment.items; const item = items[Q.index]; const answer = Q.answers[item.id];
    const answered = items.filter(i => hasAnswer(Q.answers[i.id])).length;
    const last = Q.index === items.length - 1; const kind = Q.assessment.kind;
    const practice = kind === 'practice'; const checked = Q.checked[item.id];
    const topic = (S.topics.find(t => String(t.id) === String(item.topicId)) || {}).title || '';
    const confidence = [[1, 'Guessing'], [2, 'Fairly sure'], [3, 'Certain']].map(([v, label]) => `<label><input type="radio" name="confidence" value="${v}"${answer && answer.confidence === v ? ' checked' : ''}${checked ? ' disabled' : ''}> ${label}</label>`).join(' ');
    const confirm = Q.confirm ? `<div class="qz-confirm" role="alert">${items.length - answered} unanswered. ${btn('submit-now', 'Submit anyway')} ${ghost('back-quiz', 'Go back')}</div>` : '';
    const dots = items.map((it, i) => `<button class="qz-dot${i === Q.index ? ' current' : ''}${hasAnswer(Q.answers[it.id]) ? ' done' : ''}${Q.flags.has(it.id) ? ' flagged' : ''}" type="button" data-qz="jump" data-i="${i}" aria-label="Question ${i + 1}${hasAnswer(Q.answers[it.id]) ? ', answered' : ''}${Q.flags.has(it.id) ? ', flagged' : ''}"${i === Q.index ? ' aria-current="step"' : ''}></button>`).join('');
    const timer = Q.left != null ? `<span class="qz-timer" data-qz-timer role="timer" aria-label="Time left">${clock(Q.left)}</span>` : '';
    const nextBtn = practice && !checked ? (instantType(item) ? '' : btn('check', 'Check')) : last ? btn('submit', 'Submit') : btn('next', 'Next');
    return `<div class="qz-head"><strong>${esc(KIND_LABEL[kind] || kind)}${Q.assessment.config && Q.assessment.config.test ? ' (test)' : ''}</strong>${(/ · (.+)$/.exec(Q.assessment.title || '') || [])[1] ? ` · ${esc(/ · (.+)$/.exec(Q.assessment.title)[1])}` : ''} · Question ${Q.index + 1} of ${items.length} · ${answered} answered ${timer}<span class="qz-save" aria-live="polite">${esc(Q.saveText || '')}</span></div>
      <div class="qz-bar" aria-hidden="true"><i style="width:${Math.round((answered / items.length) * 100)}%"></i></div>
      <form class="qz-card" data-qz-form="answer" novalidate tabindex="-1">
        <p class="qz-meta">${esc(TYPES[item.question.type] || '')}${topic ? ` · ${esc(topic)}` : ''}${Q.flags.has(item.id) ? ' · ⚑ flagged' : ''}</p>
        <p class="qz-prompt" tabindex="-1" data-qz-focus>${esc(item.question.prompt)}</p>
        ${control(item, answer, Boolean(checked), checked)}
        <div class="qz-conf"><span>How sure are you?</span> ${confidence}</div>
        <label class="qz-dk"><input type="checkbox" name="dontKnow"${answer && answer.dontKnow ? ' checked' : ''}${checked ? ' disabled' : ''}> I don't know</label>
      </form>
      ${checked ? feedbackView(S, item, checked) : ''}${confirm}
      <div class="qz-row">${ghost('prev', 'Previous', Q.index === 0 ? 'disabled' : '')}${nextBtn}${practice && checked && !last ? '' : ''}${ghost('flag', Q.flags.has(item.id) ? 'Unflag' : 'Flag')}${ghost('leave', kind === 'final' ? 'Leave (the clock keeps running)' : 'Leave (answers are saved)')}${practice && checked && last ? btn('submit', 'Finish') : ''}</div>
      <div class="qz-dots" role="group" aria-label="Questions">${dots}</div>
      <p class="qz-keys ln-soon">Keys: 1–9 or A–D choose · T / F true or false · ← → move · F flag · Ctrl+Enter ${practice ? 'check or next' : 'next or submit'}</p>`;
  }

  function gradeView(S) {
    const rows = S.grade.items.map(item => {
      const q = item.snapshot;
      const checks = (q.payload.rubric || []).map(c => `<label class="qz-choice"><input type="checkbox" name="${esc(item.id)}:${esc(c.id)}"><span>${esc(c.criterion)}</span></label>`).join('');
      return `<fieldset class="qz-fs"><legend>${esc(q.prompt)}</legend><p class="qz-yours">Your answer: ${esc((item.answer && item.answer.response && item.answer.response.text) || '—')}</p>${q.payload.modelAnswer ? `<p class="ln-soon">Model answer: ${esc(q.payload.modelAnswer)}</p>` : ''}<p>Tick what your answer covered:</p>${checks}</fieldset>`;
    }).join('');
    return `<form class="qz-form" data-qz-form="grade" novalidate><p>Your written answers are graded by you. Be honest: this is how the app learns where you are.</p>${rows}<div class="qz-row"><button class="btn btn-sm" type="submit" data-qz-focus>Save my grades</button>${ghost('ai-grade', 'Grade with AI', S.ai.available ? 'title="The AI rates each point; you can accept or adjust it"' : `disabled title="${esc(S.ai.reason)}"`)}</div></form>`;
  }

  function answerText(q, response) {
    const r = response || {}; const p = q.payload || {};
    if (q.type === 'choice') return (r.choice || []).map(id => (p.options.find(o => o.id === id) || {}).text).filter(Boolean).join(', ') || '—';
    if (q.type === 'truefalse') return typeof r.value === 'boolean' ? (r.value ? 'True' : 'False') : '—';
    if (q.type === 'matching') return (r.pairs || []).map(([l, rt]) => `${(p.left.find(x => x.id === l) || {}).text} → ${(p.right.find(x => x.id === rt) || {}).text}`).join('; ') || '—';
    return (r.text || '').trim() || '—';
  }
  function correctText(q) {
    const p = q.payload || {};
    if (q.type === 'choice') return (p.correct || []).map(id => (p.options.find(o => o.id === id) || {}).text).join(', ');
    if (q.type === 'truefalse') return p.correct ? 'True' : 'False';
    if (q.type === 'matching') return (p.pairs || []).map(([l, rt]) => `${(p.left.find(x => x.id === l) || {}).text} → ${(p.right.find(x => x.id === rt) || {}).text}`).join('; ');
    return p.modelAnswer || (p.rubric || []).map(c => c.criterion).join('; ');
  }
  function examBanner(R) {
    const e = R.assessment.exam; if (!e) return '';
    const verdict = e.passed === null ? '' : e.passed ? `<p class="qz-pass" role="status">✓ Passed${e.test ? ' (test final)' : ''}</p>` : `<p class="qz-fail" role="status">✗ Not passed${e.test ? ' (test final)' : ''}</p>`;
    return `${verdict}<p>${e.percent}%${e.passMarkPercent != null ? ` · pass mark ${e.passMarkPercent}%` : ''}${e.timeUsedSeconds != null ? ` · time used ${clock(e.timeUsedSeconds)}${e.timeLimitSeconds ? ` of ${clock(e.timeLimitSeconds)}` : ' (untimed)'}` : ''}${e.provisional ? ' · provisional: some written answers are not graded yet' : ''}</p>`;
  }
  function attemptsTable(R) {
    if (!R.attempts || !R.attempts.length) return '';
    const rows = R.attempts.map(a => `<tr><th scope="row">${a.attempt}${a.result.test ? ' (test)' : ''}</th><td>${a.result.percent}%</td><td>${a.result.passMarkPercent == null ? '—' : `${a.result.passMarkPercent}%`}</td><td>${a.result.passed === null ? '—' : a.result.passed ? 'Passed' : 'Not passed'}</td><td>${a.result.timeUsedSeconds == null ? '—' : clock(a.result.timeUsedSeconds)}</td><td>${a.topics.map(t => `${esc(t.title || t.topicId)} ${t.percent == null ? '—' : `${t.percent}%`}`).join(' · ')}</td></tr>`).join('');
    return `<table class="qz-table" tabindex="0"><caption>Every final attempt, side by side</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Score</th><th scope="col">Pass mark</th><th scope="col">Result</th><th scope="col">Time</th><th scope="col">By topic</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function analysisBlock(R) {
    const A = R.analysis; if (!A) return '';
    const cats = Object.entries(A.byCategory).map(([k, n]) => `<li>${esc(A.labels[k] || k)}: ${n}</li>`).join('');
    const weak = A.weak.map(w => `<li>${esc(w.title || w.topicId)} · ${esc(LEVELS[w.level] || w.level)} · score ${w.score}</li>`).join('');
    const mistakes = A.items.filter(i => i.category && i.category !== 'guess' && i.questionId).length;
    if (!cats && !weak) return '';
    return `<div class="qz-analysis"><p class="qz-journey-title"><strong>Your mistakes</strong></p>${cats ? `<ul class="qz-cats" aria-label="Mistake categories">${cats}</ul>` : '<p class="ln-soon">No mistakes to analyse.</p>'}
      ${weak ? `<p class="qz-journey-title"><strong>Weak topics, worst first</strong></p><ol class="qz-cats">${weak}</ol>` : ''}
      <div class="qz-row">${A.weak.length && R.assessment.journeyId ? btn('notes-make', 'Generate targeted notes', 'title="One note per weak topic, written from your own mistakes (no AI)"') : ''}${mistakes ? ghost('practice-these', `Practice these ${mistakes}`, 'title="A practice set of exactly the questions you missed"') : ''}</div></div>`;
  }
  function retakeBlock(R) {
    const g = R.retake; if (!g || !g.failed) return '';
    const rows = g.topics.map(x => `<li><strong>${esc(x.title || x.topicId)}</strong> (${x.percent}%): ${x.missingSections.length ? `open ${x.missingSections.length} section${x.missingSections.length === 1 ? '' : 's'} (${esc(x.missingSections.join(', '))})` : 'all sections opened'}${x.missingNotes.length ? `; open ${x.missingNotes.length} targeted note${x.missingNotes.length === 1 ? '' : 's'}` : ''}</li>`).join('');
    return `<div class="qz-analysis" role="status"><p class="qz-journey-title"><strong>${g.ready ? 'Ready to retake' : 'Before you retake'}</strong></p><p class="ln-soon">${g.ready ? 'You reviewed everything below the pass mark.' : `Start a study session of type Review, open each section in the viewer and read each targeted note. The pass mark was ${g.passMarkPercent}%.`}</p><ul class="qz-cats">${rows}</ul></div>`;
  }
  function aiGradeBlock(i, a) {
    const f = a.feedback || {}; const reasons = f.reasons || {};
    const crit = (a.criteria || []).map(c => `<li>${esc((i.snapshot.payload.rubric || []).find(r => r.id === c.id)?.criterion || c.id)}: <strong>${esc(c.verdict)}</strong>${reasons[c.id] ? ` · ${esc(reasons[c.id])}` : ''}</li>`).join('');
    return `<div class="qz-feedback"><p><span class="qz-chip">AI grade · provisional</span> confidence ${esc(f.confidence || 'low')}${f.provenance ? ` · ${esc(f.provenance.model)}` : ''}</p><ul class="qz-cats">${crit}</ul>
      <p class="qz-row">${btn('accept-grade', 'Accept', `data-item="${esc(i.id)}"`)}${ghost('adjust-grade', 'Adjust', `data-item="${esc(i.id)}"`)}</p></div>`;
  }
  function resultsView(S) {
    const R = S.results; const items = R.assessment.items; const t = R.assessment.totals;
    const topics = (R.mastery.topics || []).map(x => `<tr><th scope="row">${esc(x.title || x.topicId)}</th><td><span class="qz-chip">${esc(LEVELS[x.level] || x.level)}</span></td><td>${x.items} item${x.items === 1 ? '' : 's'}</td></tr>`).join('');
    const review = items.map(i => {
      const a = i.answer || {}; const ok = a.score >= i.maxScore;
      const state = a.dontKnow ? "I don't know" : ok ? '✓ Correct' : a.score > 0 ? '◐ Partly correct' : '✗ Incorrect';
      return `<li class="qz-rev"><p class="qz-prompt">${esc(i.snapshot.prompt)}</p><p><strong>${state}</strong> · ${a.score == null ? 0 : a.score}/${i.maxScore}${a.mistakeCategory ? ` · ${esc(a.mistakeCategory.replace('_', ' '))}` : ''}${a.grader === 'self' ? ' · <span class="qz-chip">Self-graded</span>' : ''}</p>${a.gradeStatus === 'provisional' ? aiGradeBlock(i, a) : ''}<p>You answered: ${esc(answerText(i.snapshot, a.response))}</p><p>Correct: ${esc(correctText(i.snapshot))}</p>${i.snapshot.explanation ? `<p class="ln-soon">${esc(i.snapshot.explanation)}</p>` : ''}</li>`;
    }).join('');
    const failedFinal = R.assessment.kind === 'final' && R.assessment.exam && R.assessment.exam.passed === false;
    return `<p class="qz-score" tabindex="-1" data-qz-focus>${esc(KIND_LABEL[R.assessment.kind] || '')}: ${t.score} of ${t.max} points</p>
      ${examBanner(R)}
      ${topics ? `<table class="qz-table" tabindex="0"><caption>Where you stand by topic</caption><thead><tr><th scope="col">Topic</th><th scope="col">Level</th><th scope="col">Evidence</th></tr></thead><tbody>${topics}</tbody></table>
      <p class="ln-soon">A level needs at least 3 graded items on a topic; below that it reads Not assessed.</p>` : ''}
      ${analysisBlock(R)}
      ${attemptsTable(R)}
      <ol class="qz-reviews">${review}</ol>
      ${retakeBlock(R)}
      <div class="qz-row">${failedFinal ? btn('retake', 'Retake the final', `data-id="${esc(R.assessment.id)}"${R.retake && !R.retake.ready ? ' disabled title="Review the topics below first"' : ''}`) : ''}${S.journey ? ghost('report', 'Report') : ''}${ghost('home', 'Back')}</div>`;
  }

  function examSetupView(S) {
    const E = S.exam; const P = E.preview;
    const preview = !P ? '<p class="ln-soon">Checking the questions…</p>'
      : P.ok ? `<p role="status">${P.count} question${P.count === 1 ? '' : 's'} (${P.available} available) · time limit ${P.timeLimitSeconds == null ? 'none' : minutes(P.timeLimitSeconds)} · pass mark ${Math.round(P.passMark * 1000) / 10}% · average difficulty ${P.meanDifficulty}</p>`
        : `<p class="qz-error" role="status">${esc(P.problem)}</p>`;
    const opt = (v, label) => `<option value="${v}"${Number(E.multiplier) === v ? ' selected' : ''}>${label}</option>`;
    return `<form class="qz-form" data-qz-form="exam" novalidate>
      <p>${E.retakeOf ? 'Retake of a final you did not pass. Questions from earlier finals are avoided when enough others exist.' : 'A final exam uses questions you have not seen in your pre-test.'} The clock starts when you press Start and cannot be paused.</p>
      <label class="ln-field"><span>Questions (${P ? P.min : 50}–${P ? P.max : 100}${E.test ? ', test finals may be smaller' : ''})</span><input class="field" name="count" type="number" min="1" max="100" value="${esc(E.count)}"></label>
      <label class="qz-dk"><input type="checkbox" name="test"${E.test ? ' checked' : ''}> Test final (a short practice run with any number of questions)</label>
      <label class="ln-field"><span>Time</span><select class="field" name="multiplier">${opt(1, 'Normal')}${opt(1.5, 'Extra time ×1.5')}${opt(2, 'Extra time ×2')}${opt(0, 'No time limit')}</select></label>
      ${preview}
      <div class="qz-row"><button class="btn btn-sm" type="submit" data-qz-focus${P && P.ok ? '' : ' disabled'}>Start</button>${ghost('home', 'Cancel')}</div>
    </form>`;
  }

  function reportView(S) {
    const R = S.report;
    const arrow = (a, b) => { const x = LEVEL_ORDER.indexOf(a); const y = LEVEL_ORDER.indexOf(b); return a === 'not_assessed' || b === 'not_assessed' ? 'Not comparable' : y > x ? 'Improved' : y < x ? 'Lower' : 'Same'; };
    const rows = R.topics.map(t => {
      const dims = DIMENSIONS.filter(d => t.improvement[d] && t.improvement[d].delta !== null).map(d => `${d} ${t.improvement[d].delta >= 0 ? '+' : ''}${Math.round(t.improvement[d].delta * 100)} points`).join(', ');
      return `<tr><th scope="row">${esc(t.title || t.topicId)}</th><td>${esc(LEVELS[t.pre.level])} (${t.pre.items})</td><td>${esc(LEVELS[t.post.level])} (${t.post.items})</td><td>${arrow(t.pre.level, t.post.level)}</td><td>${dims ? esc(dims) : 'Not enough items on both sides'}</td></tr>`;
    }).join('');
    return `<p class="qz-score" tabindex="-1" data-qz-focus>Report, cycle ${R.cycle}</p>${R.provisional ? '<p class="ln-soon">Provisional: some counted grades are not final yet.</p>' : ''}
      <table class="qz-table" tabindex="0"><caption>Pre-test vs now, by topic (items counted in brackets)</caption><thead><tr><th scope="col">Topic</th><th scope="col">Pre-test</th><th scope="col">Now</th><th scope="col">Change</th><th scope="col">By skill</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="ln-soon">A change needs a level on both sides; a skill change needs at least 2 items in that skill on both sides. There is no single score for the whole subject.</p>
      <div class="qz-row">${ghost('home', 'Back')}</div>`;
  }

  // ───────── answers
  function readResponse(form, item) {
    const q = item.question; const out = {}; const get = n => form.elements[n];
    if (q.type === 'choice') out.choice = [...form.querySelectorAll('input[name="choice"]:checked')].map(i => i.value);
    else if (q.type === 'truefalse') { const c = form.querySelector('input[name="tf"]:checked'); if (c) out.value = c.value === 'true'; }
    else if (q.type === 'matching') out.pairs = [...form.querySelectorAll('select[name^="match:"]')].filter(s => s.value).map(s => [s.name.slice(6), s.value]);
    else out.text = get('text') ? get('text').value : '';
    const conf = form.querySelector('input[name="confidence"]:checked'); if (conf) out.confidence = Number(conf.value);
    if (get('dontKnow') && get('dontKnow').checked) out.dontKnow = true;
    return out;
  }
  async function saveNow(S) {
    const Q = S.quiz; if (!Q || !Q.dirty) return true;
    const item = Q.assessment.items[Q.index]; const response = Q.dirty; Q.dirty = null; clearTimeout(Q.timer);
    Q.saveText = 'Saving…'; setSave(S);
    try {
      await D().assessmentSaveAnswer({ itemId: item.id, response });
      Q.answers[item.id] = { response, confidence: response.confidence, dontKnow: Boolean(response.dontKnow) };
      Q.saveText = 'Saved'; setSave(S); return true;
    } catch (error) {
      if (/Time is up/.test(error.message)) { await finishExam(S); return false; }
      Q.dirty = response; Q.saveText = 'Not saved. Press Next to retry.'; setSave(S); S.errors = error.message; return false;
    }
  }
  const setSave = S => { const el = hostOf(S) && hostOf(S).querySelector('.qz-save'); if (el && S.quiz) el.textContent = S.quiz.saveText || ''; };
  function onAnswerChange(S, form) {
    const Q = S.quiz; if (!Q) return; const item = Q.assessment.items[Q.index];
    Q.dirty = readResponse(form, item); Q.saveText = ''; clearTimeout(Q.timer);
    if (Q.assessment.kind === 'practice' && !Q.checked[item.id] && completeNow(item, Q.dirty)) { autoCheck(S); return; } // quiz: reveal at once
    Q.timer = setTimeout(() => saveNow(S), 600);
    const count = form.querySelector('[data-qz-count]'); if (count && Q.dirty.text != null) count.textContent = `${words(Q.dirty.text)} words`;
  }

  // ───────── study session clock: shown once a second, heartbeat every minute (the last activity closes a forgotten session)
  function syncStudyTimer(S) {
    const st = S.study; const want = st.active && S.mode === 'home';
    if (!want) { if (st.tick) { clearInterval(st.tick); st.tick = null; } return; }
    if (st.tick) return;
    let beats = 0;
    st.tick = setInterval(() => {
      if (S.mode !== 'home' || !st.active) { clearInterval(st.tick); st.tick = null; return; }
      const el = hostOf(S) && hostOf(S).querySelector('[data-qz-study-time]');
      if (el && st.active.elapsedSeconds != null) el.textContent = clock(st.base + (Date.now() - st.t0) / 1000);
      if (++beats % 60 === 0) D().studyTouch({ sessionId: st.active.session.id }).catch(() => {});
    }, 1000);
  }
  /* D13: the viewer reports each topic or section the student opens; during a study session it is stored once. */
  const visitQueue = new Map();
  function noteVisit({ subjectId, fileId, section }) {
    const S = states.get(subjectId); if (!S || !S.study.active || !D() || typeof D().studyVisit !== 'function') return;
    const key = `${fileId}\u0000${section}`; const queue = visitQueue.get(S.study.active.session.id) || { sent: new Set(), pending: [] };
    visitQueue.set(S.study.active.session.id, queue);
    if (queue.sent.has(key)) return;
    queue.sent.add(key); queue.pending.push({ fileId, section: String(section || '').slice(0, 200) });
    clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      const sections = queue.pending.splice(0);
      if (S.study.active && sections.length) D().studyVisit({ sessionId: S.study.active.session.id, sections }).catch(() => { sections.forEach(x => queue.sent.delete(`${x.fileId}\u0000${x.section}`)); });
    }, 1500);
  }

  // ───────── timer (timed finals; the main process enforces the deadline, this only shows and auto-submits)
  function stopTimer(S) { if (S.quiz && S.quiz.tick) { clearInterval(S.quiz.tick); S.quiz.tick = null; } }
  function startTimer(S) {
    const Q = S.quiz; stopTimer(S);
    if (Q.left == null) return;
    Q.deadline = Date.now() + Q.left * 1000; Q.warned = { 300: Q.left <= 300, 60: Q.left <= 60 };
    Q.tick = setInterval(() => {
      if (S.mode !== 'quiz' || !S.quiz) { stopTimer(S); return; }
      const left = Math.max(0, Math.ceil((Q.deadline - Date.now()) / 1000)); Q.left = left;
      const el = hostOf(S) && hostOf(S).querySelector('[data-qz-timer]'); if (el) el.textContent = clock(left);
      for (const mark of [300, 60]) if (left <= mark && !Q.warned[mark]) { Q.warned[mark] = true; say(mark === 300 ? '5 minutes left.' : '1 minute left.'); H.toast(mark === 300 ? '5 minutes left.' : '1 minute left.'); }
      if (left === 0) { stopTimer(S); finishExam(S); }
    }, 1000);
  }
  async function finishExam(S) {
    stopTimer(S);
    try { await saveNow(S); } catch { /* the deadline passed: what was saved is submitted */ }
    try { const submitted = await D().assessmentSubmit({ assessmentId: S.quiz.assessment.id }); H.toast("Time is up. Your saved answers were submitted."); await afterSubmit(S, submitted); }
    catch (error) { try { await showResults(S, S.quiz.assessment.id); } catch { fail(S, error); } }
  }

  // ───────── actions
  async function openQuiz(S, assessment, index = 0) {
    stopTimer(S);
    const answers = {}; for (const i of assessment.items) if (i.answer) answers[i.id] = i.answer;
    const first = assessment.items.findIndex(i => !hasAnswer(i.answer));
    S.quiz = { assessment, index: index || Math.max(0, first), answers, dirty: null, saveText: '', confirm: false, flags: new Set(), checked: {}, left: assessment.secondsLeft == null ? null : assessment.secondsLeft };
    S.mode = 'quiz'; S.errors = ''; paint(S); startTimer(S);
  }
  async function showResults(S, assessmentId) {
    stopTimer(S);
    const assessment = await D().assessmentResults({ assessmentId });
    const mastery = assessment.journeyId ? await D().masteryJourney({ journeyId: assessment.journeyId }) : { topics: [] };
    const attempts = assessment.kind === 'final' ? await D().examAttempts({ subjectId: S.subjectId, journeyId: assessment.journeyId || undefined }) : [];
    let retake = null; if (assessment.kind === 'final' && assessment.exam && assessment.exam.passed === false) { try { retake = await D().assessmentRetakeStatus({ assessmentId }); } catch { /* shown without the list */ } }
    let analysis = null; try { analysis = await D().assessmentAnalysis({ assessmentId }); } catch { /* the analysis is a bonus */ }
    try { await load(S); } catch { /* the Status card keeps its last data */ } // the Status card and the subject card show this attempt
    S.results = { assessment, mastery, attempts, analysis, retake }; S.mode = 'results'; S.errors = ''; paint(S);
  }
  async function advance(S, submitted) {
    // The journey moves on when a pre-test or a final is submitted (spec §2.2).
    try {
      if (!submitted.journeyId) return;
      const stage = submitted.kind === 'diagnostic' ? 'diagnostic' : submitted.kind === 'final' ? 'report' : null;
      if (stage) { await D().journeyUpdate({ journeyId: submitted.journeyId, stage }); if (S.journey) S.journey.stage = stage; }
    } catch { /* the stage is informational; a failure here must not block the results */ }
  }
  async function afterSubmit(S, submitted) {
    stopTimer(S);
    await advance(S, submitted);
    if (submitted.status === 'graded') { await showResults(S, submitted.id); return; }
    S.grade = { assessment: submitted, items: submitted.items.filter(i => i.answer && i.answer.gradeStatus === 'pending' && ['explain', 'essay'].includes(i.snapshot.type)) };
    S.mode = 'grade'; S.errors = ''; paint(S);
  }
  async function begin(S, kind, title, config, extra = {}) {
    if (['diagnostic', 'practice', 'final'].includes(kind) && !config.only && !config.topicIds && scopeIds(S)) {
      config = { ...config, topicIds: scopeIds(S) }; title = `${title} · ${scopeLabel(S)}`.slice(0, 120);
    }
    const journey = S.journey || await D().journeyCreate({ subjectId: S.subjectId });
    const made = await D().assessmentCreate({ subjectId: S.subjectId, journeyId: journey.id, kind, title, config, ...extra });
    const started = await D().assessmentStart({ assessmentId: made.assessment.id });
    if (kind === 'diagnostic') await D().journeyUpdate({ journeyId: journey.id, stage: 'pretest' });
    if (kind === 'final') await D().journeyUpdate({ journeyId: journey.id, stage: 'final_exam' });
    S.journey = journey;
    if (made.available < made.requested) H.toast(`Only ${made.available} question${made.available === 1 ? '' : 's'} available, so this has ${made.available}.`);
    await openQuiz(S, started); say(`${KIND_LABEL[kind]} started.`);
  }
  async function refreshPreview(S) {
    const E = S.exam; E.preview = null; paint(S);
    try {
      E.preview = await D().examPreview({ subjectId: S.subjectId, journeyId: S.journey ? S.journey.id : undefined, retakeOf: E.retakeOf, config: { count: Number(E.count) || 1, test: E.test, timeMultiplier: Number(E.multiplier), topicIds: scopeIds(S) || undefined } });
    } catch (error) { E.preview = { ok: false, problem: error.message, min: 50, max: 100 }; }
    if (S.mode === 'examSetup') paint(S);
  }
  const move = (S, delta) => { S.quiz.index = Math.min(S.quiz.assessment.items.length - 1, Math.max(0, S.quiz.index + delta)); S.quiz.confirm = false; paint(S); };

  async function onClick(S, event) {
    const cytab = event.target.closest('[data-qz-cytab]');
    if (cytab) { S.evalTab = cytab.dataset.qzCytab; const host = hostOf(S); host.querySelector('.qz-cycle-tabs').innerHTML = cycleTabs(S); paintBar(S); paintSide(S); paintEval(S); const b = host.querySelector(`[data-qz-cytab="${S.evalTab}"]`); if (b) b.focus(); return; }
    if (S.scopeOpen && !event.target.closest('.qz-scope')) { S.scopeOpen = false; paintBar(S); }
    if (event.target.closest('[data-qz-take]')) { S.errors = ''; try { await take(S, S.evalTab); } catch (error) { fail(S, error); } return; }
    const target = event.target.closest('[data-qz]'); if (!target) return;
    const action = target.dataset.qz; S.errors = '';
    try {
      if (action === 'collapse') { stopTimer(S); S.expanded = false; const host = hostOf(S); if (host) host.hidden = true; paintEval(S).then(() => { const b = document.querySelector('[data-qz-evexpand]'); if (b) b.focus(); }); return; }
      if (action === 'scope') { S.scopeOpen = !S.scopeOpen; paintBar(S); if (S.scopeOpen) { const f = hostOf(S).querySelector('.qz-scope-pop button'); if (f) f.focus(); } return; }
      if (action === 'scope-done') { S.scopeOpen = false; paintBar(S); const b = hostOf(S).querySelector('[data-qz="scope"]'); if (b) b.focus(); return; }
      if (action === 'scope-all') { S.scopeSel.clear(); scopeChanged(S, '[data-qz="scope-all"]'); return; }
      if (action === 'scope-period') {
        const p = (S.periods || []).find(x => x.id === target.dataset.id); if (!p) return;
        const on = p.topicIds.every(id => S.scopeSel.has(id)); for (const id of p.topicIds) { if (on) S.scopeSel.delete(id); else S.scopeSel.add(id); }
        scopeChanged(S, `[data-qz="scope-period"][data-id="${CSS.escape(p.id)}"]`); return;
      }
      if (action === 'add') { S.editId = null; S.form = { type: (S.form && S.form.type) || 'choice', topicId: S.form && S.form.topicId }; S.mode = 'add'; paint(S); }
      else if (action === 'schedule') { const from = S.mode; await load(S); if (S.mode !== from) return; S.schedEdit = null; S.confirmSched = null; S.mode = 'schedule'; paint(S); }
      else if (action === 'sched-edit') { S.schedEdit = target.dataset.id; S.confirmSched = null; paint(S); }
      else if (action === 'sched-new') { S.schedEdit = null; paint(S); }
      else if (action === 'sched-cancel') { S.confirmSched = target.dataset.id; paint(S); }
      else if (action === 'sched-remove-no') { S.confirmSched = null; paint(S); }
      else if (action === 'sched-remove-yes') { await D().scheduleCancel({ scheduleId: target.dataset.id }); if (S.schedEdit === target.dataset.id) S.schedEdit = null; S.confirmSched = null; await load(S); paint(S); H.toast('Removed from your calendar.'); }
      else if (action === 'sched-start') {
        const kind = target.dataset.kind;
        if (kind === 'practice') { target.disabled = true; await begin(S, 'practice', 'Practice', { count: 8 }); }
        else if (kind === 'final') { S.exam = { ...S.exam, retakeOf: undefined, preview: null }; S.mode = 'examSetup'; paint(S); await refreshPreview(S); }
        else if (kind === 'retention') { target.disabled = true; await begin(S, 'retention', 'Retention check', { count: 8 }); }
      }
      else if (action === 'evaluation') { S.evaluation = await D().journeyEvaluation({ journeyId: S.journey.id }); S.mode = 'evaluation'; paint(S); }
      else if (action === 'history') { S.history = await D().learningHistory({ subjectId: S.subjectId }); S.mode = 'history'; paint(S); }
      else if (action === 'retention') { target.disabled = true; await begin(S, 'retention', 'Retention check', { count: 8 }); }
      else if (action === 'notes') { S.notesShown = S.targeted; S.mode = 'notes'; paint(S); await visitNotes(S); }
      else if (action === 'notes-make') {
        target.disabled = true;
        S.notesShown = await D().notesTargeted({ journeyId: S.results.assessment.journeyId, assessmentId: S.results.assessment.id, useAi: S.ai.available });
        await load(S); S.mode = 'notes'; paint(S); say('Targeted notes written.'); await visitNotes(S);
      }
      else if (action === 'practice-these') {
        const ids = S.results.analysis.items.filter(i => i.category && i.category !== 'guess' && i.questionId).map(i => i.questionId);
        target.disabled = true; await begin(S, 'practice', 'Practice: your mistakes', { only: ids, count: ids.length });
      }
      else if (action === 'check-note') {
        target.disabled = true; H.toast('The AI is reading your note…');
        await D().studyCheckNote({ materialId: target.dataset.id });
        S.study.notes = await D().studyNotes({ sessionId: S.study.active.session.id }); paint(S);
      }
      else if (action === 'study-end') {
        const sum = await D().studyEnd({ sessionId: S.study.active.session.id });
        S.study.summary = sum; S.study.active = null; S.study.notes = []; await load(S); paint(S); say('Study session saved.');
      }
      else if (action === 'bank') { const from = S.mode; await load(S); if (S.mode !== from) return; S.editId = null; S.bankFilter = S.bankFilter || {}; S.confirmDelete = null; S.mode = 'bank'; paint(S); } // a click made during the reload wins
      else if (action === 'hint-dismiss') { try { localStorage.setItem(hintKey(), '1'); } catch { /* the hint may return next time */ } paint(S); }
      else if (action === 'ai-generate') {
        const host = hostOf(S); target.disabled = true; H.toast('Writing questions… this can take a minute.');
        const out = await D().questionsGenerate({ subjectId: S.subjectId, topicId: host.querySelector('[data-qz-ai-topic]').value, count: Number(host.querySelector('[data-qz-ai-count]').value) || 5 });
        await load(S); S.mode = 'bank'; S.bankFilter = S.bankFilter || {}; paint(S);
        H.toast(`${out.saved.length} draft${out.saved.length === 1 ? '' : 's'} saved for your review${out.rejected.length ? `; ${out.rejected.length} rejected (${out.rejected[0].reason})` : ''}.`);
      }
      else if (action === 'q-approve' || action === 'q-reject') { await D().questionsReview({ questionId: target.dataset.id, review: action === 'q-approve' ? 'approved' : 'rejected' }); await load(S); paint(S); }
      else if (action === 'ai-grade') {
        target.disabled = true; H.toast('The AI is grading your answers…');
        for (const item of S.grade.items) await D().assessmentAiGrade({ itemId: item.id });
        await showResults(S, S.grade.assessment.id);
      }
      else if (action === 'accept-grade') { await D().assessmentAcceptGrade({ itemId: target.dataset.item }); await showResults(S, S.results.assessment.id); }
      else if (action === 'adjust-grade') {
        const item = S.results.assessment.items.find(i => i.id === target.dataset.item);
        S.grade = { assessment: S.results.assessment, items: [item] }; S.mode = 'grade'; paint(S);
      }
      else if (action === 'templates') { S.templates = await D().questionsTemplates({ subjectId: S.subjectId }); S.mode = 'templates'; paint(S); }
      else if (action === 'tpl-skip') { S.templates.drafts = S.templates.drafts.filter(d => d.id !== target.dataset.id); paint(S); }
      else if (action === 'tpl-accept' || action === 'tpl-all') {
        const picked = action === 'tpl-all' ? S.templates.drafts : S.templates.drafts.filter(d => d.id === target.dataset.id);
        for (const draft of picked) await D().questionsSave({ question: draft });
        S.templates.drafts = S.templates.drafts.filter(d => !picked.includes(d)); await load(S); paint(S); H.toast(`${picked.length} question${picked.length === 1 ? '' : 's'} added to your bank.`);
      }
      else if (action === 'edit') { const x = S.allQuestions.find(y => y.id === target.dataset.id); S.editId = x.id; S.form = questionToForm(x); S.mode = 'add'; paint(S); }
      else if (action === 'retire' || action === 'restore') {
        const x = S.allQuestions.find(y => y.id === target.dataset.id);
        if (action === 'retire') await D().questionsRetire({ questionId: x.id });
        else await D().questionsSave({ question: { ...x, status: 'active' } });
        await load(S); paint(S);
      }
      else if (action === 'delete') { S.confirmDelete = target.dataset.id; paint(S); }
      else if (action === 'delete-no') { S.confirmDelete = null; paint(S); }
      else if (action === 'delete-yes') { await D().questionsDelete({ questionId: target.dataset.id }); S.confirmDelete = null; await load(S); paint(S); H.toast('Question deleted.'); }
      else if (action === 'newcycle') {
        const parent = S.journey; const next = await D().journeyCreate({ subjectId: S.subjectId, parentId: parent.id });
        S.journey = next; await load(S); S.journey = next; paint(S); H.toast(`Cycle ${next.cycle} started. Its statistics start at zero; cycle ${parent.cycle} stays as it was.`);
      }
      else if (action === 'home') { stopTimer(S); S.mode = 'home'; paint(S); await load(S); if (S.mode === 'home') paint(S); } // switch first: a slow reload must not undo a later click
      else if (action === 'start') {
        S.setup = { ...S.setup, count: Math.min(40, Math.max(1, S.topics.length * 2)) }; S.mode = 'setup'; paint(S);
        if (S.journey && S.journey.stage === 'material') { try { await D().journeyUpdate({ journeyId: S.journey.id, stage: 'pretest_setup' }); S.journey.stage = 'pretest_setup'; } catch { /* informational */ } }
      }
      else if (action === 'practice') { target.disabled = true; await begin(S, 'practice', 'Practice', { count: Math.min(10, Math.max(5, S.topics.length * 3)) }); }
      else if (action === 'exam') { S.exam = { ...S.exam, retakeOf: undefined, count: Math.min(100, Math.max(50, S.exam.count || 50)), preview: null }; S.mode = 'examSetup'; paint(S); await refreshPreview(S); }
      else if (action === 'retake') { S.exam = { ...S.exam, retakeOf: target.dataset.id, preview: null }; S.mode = 'examSetup'; paint(S); await refreshPreview(S); }
      else if (action === 'report') { S.report = await D().masteryReport({ journeyId: S.journey.id }); S.mode = 'report'; paint(S); }
      else if (action === 'resume') {
        const got = await D().assessmentGet({ assessmentId: target.dataset.id });
        await openQuiz(S, got.status === 'draft' ? await D().assessmentStart({ assessmentId: got.id }) : got);
      } else if (action === 'results') await showResults(S, target.dataset.id);
      else if (action === 'prev' || action === 'next') { if (await saveNow(S)) move(S, action === 'next' ? 1 : -1); else paint(S); }
      else if (action === 'jump') { if (await saveNow(S)) { S.quiz.index = Number(target.dataset.i); S.quiz.confirm = false; paint(S); } }
      else if (action === 'flag') { const id = S.quiz.assessment.items[S.quiz.index].id; if (S.quiz.flags.has(id)) S.quiz.flags.delete(id); else S.quiz.flags.add(id); paint(S); }
      else if (action === 'check') {
        if (!(await saveNow(S))) { paint(S); return; }
        const item = S.quiz.assessment.items[S.quiz.index];
        S.quiz.checked[item.id] = await D().assessmentCheck({ assessmentId: S.quiz.assessment.id, itemId: item.id }); paint(S);
      }
      else if (action === 'retry') {
        const item = S.quiz.assessment.items[S.quiz.index];
        await D().assessmentRetry({ assessmentId: S.quiz.assessment.id, itemId: item.id });
        delete S.quiz.checked[item.id]; paint(S); say('Second try: it counts half.');
      }
      else if (action === 'leave') { stopTimer(S); await saveNow(S); S.mode = 'home'; paint(S); await load(S); if (S.mode === 'home') paint(S); }
      else if (action === 'back-quiz') { S.quiz.confirm = false; paint(S); }
      else if (action === 'submit') {
        if (!(await saveNow(S))) { paint(S); return; }
        const Q = S.quiz; const open = Q.assessment.items.filter(i => !hasAnswer(Q.answers[i.id])).length;
        if (open && !Q.confirm) { Q.confirm = true; paint(S); } else await afterSubmit(S, await D().assessmentSubmit({ assessmentId: Q.assessment.id }));
      } else if (action === 'submit-now') await afterSubmit(S, await D().assessmentSubmit({ assessmentId: S.quiz.assessment.id }));
    } catch (error) { fail(S, error); }
  }

  /* Keyboard (spec §3.3). Attached to the host element only; letter keys are ignored while a text field has focus. */
  async function onKey(S, event) {
    if (event.key === 'Escape' && S.scopeOpen) { event.preventDefault(); event.stopPropagation(); S.scopeOpen = false; paintBar(S); const b = hostOf(S).querySelector('[data-qz="scope"]'); if (b) b.focus(); return; }
    if (event.key === 'Escape' && S.expanded && S.mode !== 'quiz') { event.preventDefault(); const c = hostOf(S).querySelector('[data-qz="collapse"]'); if (c) c.click(); return; }
    if (S.mode !== 'quiz' || !S.quiz) return;
    const typing = /^(TEXTAREA|SELECT)$/.test(event.target.tagName) || (event.target.tagName === 'INPUT' && event.target.type === 'text');
    const host = hostOf(S); const key = event.key;
    if (event.ctrlKey && key === 'Enter') { event.preventDefault(); const b = host.querySelector('[data-qz="check"], [data-qz="next"], [data-qz="submit"]'); if (b) b.click(); return; }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    const item = S.quiz.assessment.items[S.quiz.index]; const locked = S.quiz.checked[item.id];
    if (key === 'ArrowRight') { event.preventDefault(); const b = host.querySelector('[data-qz="next"]'); if (b) b.click(); }
    else if (key === 'ArrowLeft') { event.preventDefault(); const b = host.querySelector('[data-qz="prev"]'); if (b && !b.disabled) b.click(); }
    else if (/^[fF]$/.test(key) && item.question.type !== 'truefalse') { event.preventDefault(); const b = host.querySelector('[data-qz="flag"]'); if (b) b.click(); }
    else if (!locked) {
      let input = null;
      if (item.question.type === 'truefalse' && /^[tTfF]$/.test(key)) input = host.querySelector(`input[name="tf"][value="${/[tT]/.test(key) ? 'true' : 'false'}"]`);
      else if (item.question.type === 'choice') {
        const inputs = [...host.querySelectorAll('input[name="choice"]')]; const index = /^[1-9]$/.test(key) ? Number(key) - 1 : /^[a-hA-H]$/.test(key) ? key.toLowerCase().charCodeAt(0) - 97 : -1;
        input = inputs[index] || null;
      }
      if (input) { event.preventDefault(); input.checked = input.type === 'checkbox' ? !input.checked : true; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }

  function readAdd(form, type) {
    const f = form.elements; const q = { subjectId: undefined, topicId: f.topicId.value, type, prompt: f.prompt.value, dimension: f.dimension.value, difficulty: Number(f.difficulty.value), explanation: f.explanation.value };
    if (type === 'choice') {
      const opts = [0, 1, 2, 3].map(i => ({ id: `o${i}`, text: f[`opt${i}`].value })).filter(o => o.text.trim());
      q.payload = { options: opts, correct: [`o${form.querySelector('input[name="correct"]:checked').value}`], multiple: false };
    } else if (type === 'truefalse') q.payload = { statement: f.statement.value, correct: form.querySelector('input[name="tf"]:checked').value === 'true', requireJustification: false };
    else if (type === 'matching') {
      const rows = [0, 1, 2, 3].map(i => ({ i, left: f[`left${i}`].value, right: f[`right${i}`].value })).filter(r => r.left.trim() || r.right.trim());
      const extra = f.extra.value.trim();
      q.payload = { left: rows.map(r => ({ id: `l${r.i}`, text: r.left })), right: [...rows.map(r => ({ id: `r${r.i}`, text: r.right })), ...(extra ? [{ id: 'rx', text: extra }] : [])], pairs: rows.map(r => [`l${r.i}`, `r${r.i}`]) };
    } else {
      q.payload = { rubric: [0, 1].map(i => ({ id: `c${i}`, criterion: f[`crit${i}`].value, points: 1 })).filter(c => c.criterion.trim()) };
      if (type === 'essay') Object.assign(q.payload, { minWords: Number(f.minWords.value), maxWords: Number(f.maxWords.value) });
    }
    return q;
  }
  function questionToForm(x) {
    const p = x.payload || {}; const f = { type: x.type, topicId: x.topicId, prompt: x.prompt, explanation: x.explanation, dimension: x.dimension, difficulty: x.difficulty };
    if (x.type === 'choice') Object.assign(f, { opts: (p.options || []).map(o => o.text), correct: Math.max(0, (p.options || []).findIndex(o => (p.correct || []).includes(o.id))) });
    else if (x.type === 'truefalse') Object.assign(f, { statement: p.statement, tf: String(p.correct) });
    else if (x.type === 'matching') {
      const pairs = new Map((p.pairs || []).map(([l, r]) => [l, r])); const used = new Set(pairs.values());
      Object.assign(f, { left: (p.left || []).map(l => l.text), right: (p.left || []).map(l => ((p.right || []).find(r => r.id === pairs.get(l.id)) || {}).text || ''), extra: ((p.right || []).find(r => !used.has(r.id)) || {}).text || '' });
    } else Object.assign(f, { crit: (p.rubric || []).map(c => c.criterion), minWords: p.minWords, maxWords: p.maxWords });
    return f;
  }
  function captureAdd(form, type) {
    const f = form.elements; const typed = { type, topicId: f.topicId.value, prompt: f.prompt.value, explanation: f.explanation.value, dimension: f.dimension.value, difficulty: Number(f.difficulty.value) };
    const radio = name => { const c = form.querySelector(`input[name="${name}"]:checked`); return c ? c.value : undefined; };
    if (type === 'choice') Object.assign(typed, { opts: [0, 1, 2, 3].map(i => f[`opt${i}`].value), correct: Number(radio('correct') || 0) });
    else if (type === 'truefalse') Object.assign(typed, { statement: f.statement.value, tf: radio('tf') });
    else if (type === 'matching') Object.assign(typed, { left: [0, 1, 2, 3].map(i => f[`left${i}`].value), right: [0, 1, 2, 3].map(i => f[`right${i}`].value), extra: f.extra.value });
    else Object.assign(typed, { crit: [0, 1].map(i => f[`crit${i}`].value), ...(type === 'essay' ? { minWords: f.minWords.value, maxWords: f.maxWords.value } : {}) });
    return typed;
  }

  async function onSubmit(S, event) {
    const form = event.target.closest('[data-qz-form]'); if (!form) return;
    event.preventDefault(); const kind = form.dataset.qzForm;
    try {
      if (kind === 'add') {
        const type = form.elements.type.value; const q = readAdd(form, type); q.subjectId = S.subjectId; if (S.editId) q.id = S.editId;
        S.form = captureAdd(form, type); S.busy = true; // keep everything typed, so a rejected question comes back as entered
        await D().questionsSave({ question: q });
        const wasEdit = Boolean(S.editId); S.editId = null; S.form = { type, topicId: form.elements.topicId.value }; await load(S); S.busy = false; S.errors = ''; S.mode = wasEdit ? 'bank' : 'add'; paint(S); H.toast(wasEdit ? 'Question updated.' : 'Question saved.');
      } else if (kind === 'grade') {
        for (const item of S.grade.items) {
          const verdicts = {}; for (const c of item.snapshot.payload.rubric || []) verdicts[c.id] = form.elements[`${item.id}:${c.id}`].checked ? 'met' : 'missing';
          await D().assessmentGrade({ itemId: item.id, verdicts, grader: 'self' });
        }
        await showResults(S, S.grade.assessment.id);
      } else if (kind === 'setup') {
        const f = form.elements; const types = [...form.querySelectorAll('input[name="type"]:checked')].map(i => i.value);
        S.setup = { count: Number(f.count.value) || 1, types };
        if (!types.length) throw new Error('Choose at least one question type.');
        await begin(S, 'diagnostic', 'Pre-test', { count: Math.min(40, S.setup.count), types });
      } else if (kind === 'schedule') {
        const f = form.elements; if (!f.startsAt.value) throw new Error('Choose when it starts.');
        const minutes = Number(f.minutes.value || 45);
        if (!Number.isFinite(minutes) || minutes < 5 || minutes > 600) throw new Error('Duration must be 5 to 600 minutes.');
        const startsAt = new Date(f.startsAt.value); const endsAt = new Date(startsAt.getTime() + minutes * 60000);
        const times = { kind: f.kind.value, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
        if (S.schedEdit) { await D().scheduleUpdate({ scheduleId: S.schedEdit, ...times }); S.schedEdit = null; await load(S); paint(S); H.toast('Schedule updated.'); }
        else {
          if (!S.journey) S.journey = await D().journeyCreate({ subjectId: S.subjectId });
          S.schedForm = { kind: f.kind.value };
          await D().scheduleCreate({ journeyId: S.journey.id, ...times }); await load(S); paint(S); H.toast('Added to your calendar.');
        }
      } else if (kind === 'note') {
        const text = form.elements.text.value;
        await D().studySideNote({ sessionId: S.study.active.session.id, text });
        S.study.notes = await D().studyNotes({ sessionId: S.study.active.session.id }); paint(S); H.toast('Note added.');
      } else if (kind === 'exam') {
        const E = S.exam; if (!E.preview || !E.preview.ok) return;
        await begin(S, 'final', E.retakeOf ? 'Final exam (retake)' : 'Final exam', { count: Number(E.count), test: E.test, timeMultiplier: Number(E.multiplier) }, E.retakeOf ? { retakeOf: E.retakeOf } : {});
      }
    } catch (error) { fail(S, error); }
  }

  function mount(host, subject) {
    if (!host || !D() || typeof D().journeyList !== 'function') return;
    const S = stateOf(subject);
    host.dataset.subject = subject.id;
    if (!host.dataset.qzBound) {
      host.dataset.qzBound = '1';
      host.addEventListener('click', event => onClick(S, event));
      host.addEventListener('submit', event => onSubmit(S, event));
      host.addEventListener('keydown', event => onKey(S, event));
      host.addEventListener('change', event => {
        if (S.mode === 'setup' && event.target.form && event.target.form.dataset.qzForm === 'setup') {
          const f = event.target.form.elements; S.setup = { count: Number(f.count.value) || 1, types: [...event.target.form.querySelectorAll('input[name="type"]:checked')].map(i => i.value) }; paint(S); return;
        }
        if (S.mode === 'bank' && event.target.form && event.target.form.dataset.qzForm === 'bank-filter') {
          const f = event.target.form.elements; S.bankFilter = { topicId: f.topicId.value, type: f.type.value, retired: f.retired.checked }; paint(S); return;
        }
        if (event.target.matches('[data-qz-scope-topic]')) { const id = event.target.dataset.qzScopeTopic; if (event.target.checked) S.scopeSel.add(id); else S.scopeSel.delete(id); scopeChanged(S, `[data-qz-scope-topic="${CSS.escape(id)}"]`); return; }
        if (event.target.matches('[data-qz-type]')) { const form = event.target.form; S.form = { type: event.target.value, topicId: form.elements.topicId.value, prompt: form.elements.prompt.value }; paint(S); return; }
        if (S.mode === 'examSetup' && event.target.form && event.target.form.dataset.qzForm === 'exam') {
          const f = event.target.form.elements; Object.assign(S.exam, { count: f.count.value, test: f.test.checked, multiplier: Number(f.multiplier.value) }); refreshPreview(S); return;
        }
        const form = event.target.closest('[data-qz-form="answer"]'); if (form) onAnswerChange(S, form);
      });
      host.addEventListener('input', event => { const form = event.target.closest('[data-qz-form="answer"]'); if (form && event.target.matches('textarea')) onAnswerChange(S, form); });
    }
    if (S.mode === 'home') { if (!S.questions.length && !S.assessments.length) S.loading = true; paint(S); load(S).then(() => { S.loading = false; paint(S); }).catch(error => { S.loading = false; fail(S, error); }); }
    else { paint(S); if (S.mode === 'quiz') startTimer(S); }
  }

  // ───────── Evaluation Cycle card (subject page): one tab per kind, the latest attempt, a gauge, strengths and focus areas
  const EVAL_TABS = [['diagnostic', 'Pre-Test'], ['practice', 'Practice'], ['final', 'Final Exam']];
  const evalHostOf = S => document.querySelector(`[data-qz-eval][data-subject="${CSS.escape(S.subjectId)}"]`);
  function gauge(correct, total) {
    const share = total ? correct / total : 0; const r = 52; const len = Math.PI * r;
    return `<svg class="qz-gauge" viewBox="0 0 140 84" role="img" aria-label="${total ? `${correct} of ${total} correct` : 'Not taken yet'}">
      <defs><linearGradient id="qz-g" x1="0" x2="1"><stop offset="0" stop-color="#7FA7F5"/><stop offset="1" stop-color="#F08AA6"/></linearGradient></defs>
      <path d="M18 72 A52 52 0 0 1 122 72" fill="none" stroke="var(--raised)" stroke-width="10" stroke-linecap="round"/>
      ${share > 0 ? `<path d="M18 72 A52 52 0 0 1 122 72" fill="none" stroke="url(#qz-g)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(len * share).toFixed(1)} ${len.toFixed(1)}"/>` : ''}
      <text x="70" y="62" text-anchor="middle" class="qz-gauge-num">${total ? `${correct}/${total}` : '–'}</text><text x="70" y="78" text-anchor="middle" class="qz-gauge-lbl">${total ? 'Correct' : 'Not taken'}</text></svg>`;
  }
  async function evalData(S, kind) {
    const done = S.assessments.filter(a => a.kind === kind && ['submitted', 'graded'].includes(a.status));
    const last = done[done.length - 1]; if (!last) return null;
    if (S.evalCache[last.id] && S.evalCache[last.id].status === last.status) return S.evalCache[last.id];
    const r = await D().assessmentResults({ assessmentId: last.id });
    const correct = r.items.filter(i => i.answer && i.answer.score != null && i.answer.score >= i.maxScore).length;
    const byTopic = new Map();
    for (const i of r.items) { const t = byTopic.get(String(i.topicId)) || { score: 0, max: 0 }; t.score += (i.answer && i.answer.score) || 0; t.max += i.maxScore; byTopic.set(String(i.topicId), t); }
    const title = id => (S.topics.find(t => String(t.id) === id) || {}).title || 'Topic';
    const share = [...byTopic].map(([id, t]) => ({ id, title: title(id), share: t.max ? t.score / t.max : 0 }));
    const used = r.startedAt && r.submittedAt ? Math.max(0, Math.round((Date.parse(r.submittedAt) - Date.parse(r.startedAt)) / 60000)) : null;
    let level = 'Not assessed';
    try { if (r.journeyId) { const m = await D().masteryJourney({ journeyId: r.journeyId }); const counts = {}; for (const t of m.topics) counts[t.level] = (counts[t.level] || 0) + 1; const best = ['mastered', 'proficient', 'developing', 'emerging', 'not_assessed'].find(l => counts[l]); level = best ? `${LEVELS[best]}${m.topics.length > 1 ? ` · ${counts[best]} of ${m.topics.length} topics` : ''}` : level; } } catch { /* shown without a level */ }
    const data = { id: last.id, status: last.status, correct, total: r.items.length, level, minutes: used, limit: r.config && r.config.timeLimitSeconds, exam: r.exam || null, attempts: done.length,
      strengths: share.filter(x => x.share >= 0.75).map(x => x.title), focus: share.filter(x => x.share < 0.75).sort((a, b) => a.share - b.share).map(x => x.title) };
    S.evalCache[last.id] = data; return data;
  }
  async function paintEval(S) {
    const el = evalHostOf(S); if (!el) return;
    const tab = S.evalTab; const label = (EVAL_TABS.find(t => t[0] === tab) || [])[1];
    let d = null; try { d = await evalData(S, tab); } catch { d = null; }
    const tabs = EVAL_TABS.map(([k, l]) => `<button class="qz-tab${k === tab ? ' on' : ''}" type="button" role="tab" aria-selected="${k === tab}" data-qz-evtab="${k}">${l}</button>`).join('');
    const list = items => (items.length ? `<ul class="qz-ev-list">${items.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="qz-ev-none">—</p>');
    const time = d ? (d.minutes == null ? '' : `${d.minutes} min${d.limit ? ` of ${Math.round(d.limit / 60)}` : ''}`) : '';
    const verdict = d && d.exam && d.exam.passed !== null ? `<p class="${d.exam.passed ? 'qz-pass' : 'qz-fail'} qz-ev-verdict">${d.exam.passed ? '✓ Passed' : '✗ Not passed'} · pass mark ${d.exam.passMarkPercent}%</p>` : '';
    el.dataset.subject = S.subjectId;
    el.innerHTML = `<div class="qz-ev-head"><h3 class="ln-block-title" id="ln-eval-title">Evaluation Cycle</h3><button class="icon-btn qz-ev-expand" type="button" data-qz-evexpand aria-label="Open all quizzes and exams" title="Open all quizzes and exams">⤢</button></div>
      <div class="qz-ev-bar"><div class="qz-tabs" role="tablist" aria-label="Kind">${tabs}</div><button class="btn btn-sm btn-ghost qz-ev-take" type="button" data-qz-evtake ${S.questions.length ? '' : 'disabled title="Add questions first (open the full view)"'}>Take</button></div>
      <div class="qz-ev-body"><div class="qz-ev-text"><p class="qz-ev-title">${esc(label)}</p><p class="qz-ev-sub">${d ? esc(d.level) : 'Not taken yet'}</p>
        <p class="qz-ev-meta">${d ? `${d.total} item${d.total === 1 ? '' : 's'}${d.attempts > 1 ? ` · attempt ${d.attempts}` : ''}` : `${S.questions.length} question${S.questions.length === 1 ? '' : 's'} in your bank`}</p><p class="qz-ev-meta">${d ? esc(time || 'Untimed') : ''}</p>${verdict}</div>
        <div class="qz-ev-gauge">${gauge(d ? d.correct : 0, d ? d.total : 0)}</div></div>
      <div class="qz-ev-cols"><div><p class="qz-ev-h">Strengths</p>${d ? list(d.strengths) : '<p class="qz-ev-none">—</p>'}</div><div><p class="qz-ev-h">Focus Area</p>${d ? list(d.focus) : '<p class="qz-ev-none">—</p>'}</div></div>`;
  }
  function expand(S, then) {
    S.expanded = true; watchPanel(); const host = hostOf(S); if (host) { host.hidden = false; placeOverlay(host); }
    setTimeout(() => { const t = hostOf(S) && hostOf(S).querySelector('#qz-cycle-title'); if (t) t.focus({ preventScroll: true }); }, 0);
    Promise.resolve(then ? then() : null).catch(error => fail(S, error));
  }
  function mountEval(el, subject) {
    if (!el || !D() || typeof D().journeyList !== 'function') return;
    const S = stateOf(subject); el.dataset.subject = subject.id;
    if (!el.dataset.qzBound) {
      el.dataset.qzBound = '1';
      el.addEventListener('click', event => {
        const tab = event.target.closest('[data-qz-evtab]');
        if (tab) { S.evalTab = tab.dataset.qzEvtab; paintEval(S); return; }
        if (event.target.closest('[data-qz-evexpand]')) { expand(S, async () => { S.mode = 'home'; await load(S); S.loading = false; paint(S); }); return; }
        if (event.target.closest('[data-qz-evtake]')) {
          const kind = S.evalTab;
          expand(S, () => take(S, kind));
        }
      });
      el.addEventListener('keydown', event => { // arrow keys move between the tabs
        const tab = event.target.closest('[data-qz-evtab]'); if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const i = EVAL_TABS.findIndex(t => t[0] === S.evalTab); const next = EVAL_TABS[(i + (event.key === 'ArrowRight' ? 1 : EVAL_TABS.length - 1)) % EVAL_TABS.length][0];
        S.evalTab = next; paintEval(S).then(() => { const b = el.querySelector(`[data-qz-evtab="${next}"]`); if (b) b.focus(); });
      });
    }
    load(S).then(() => { S.loading = false; }).then(() => paintEval(S)).catch(() => paintEval(S));
  }
  /* "Start your session" in the page header: open the workspace with the study panel and start a whole-subject session. */
  function startSession(subjectId, { topicId, kind = 'main' } = {}) {
    const S = states.get(subjectId); if (!S) return;
    expand(S, async () => {
      await load(S); S.loading = false; S.mode = 'home'; paint(S);
      if (S.study.active) { H.toast('A study session is already running.'); return; }
      await D().studyStart({ subjectId, journeyId: S.journey ? S.journey.id : undefined, topicId: topicId || undefined, kind });
      S.study.summary = null; await load(S); if (S.journey && S.journey.stage === 'diagnostic') S.journey.stage = 'main_learning'; paint(S); say('Study session started.');
    });
  }

  window.PerflwQuiz = { mount, mountEval, startSession, noteVisit, init: helpers => { H = { ...H, ...helpers }; } };
})();
