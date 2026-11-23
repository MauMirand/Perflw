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
  let H = { toast: () => {}, announce: () => {} };
  const states = new Map(); // subjectId → state, so a re-render of the page keeps the quiz where it was

  function stateOf(subject) {
    if (!states.has(subject.id)) states.set(subject.id, { mode: 'home', subjectId: subject.id, name: subject.name, topics: [], questions: [], journey: null, assessments: [], form: { type: 'choice' }, errors: '', busy: false, exam: { count: 50, test: false, multiplier: 1 } });
    return states.get(subject.id);
  }
  const say = text => { try { H.announce(text); } catch { /* optional */ } };
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
    S.questions = questions; S.assessments = assessments;
    S.journey = journeys.filter(j => j.status !== 'archived').pop() || null;
  }

  // ───────── rendering
  const hostOf = S => document.querySelector(`[data-qz-host][data-subject="${CSS.escape(S.subjectId)}"]`);
  const VIEWS = { add: addView, quiz: quizView, grade: gradeView, results: resultsView, examSetup: examSetupView, report: reportView };
  function paint(S) {
    const host = hostOf(S); if (!host) return;
    const body = (VIEWS[S.mode] || homeView)(S);
    host.innerHTML = `<section class="ln-block qz" aria-labelledby="qz-title"><h3 class="ln-block-title" id="qz-title">Quizzes and exams</h3>${S.errors ? `<p class="qz-error" role="alert">${esc(S.errors)}</p>` : ''}${body}</section>`;
    const focus = host.querySelector('[data-qz-focus]'); if (focus) focus.focus();
  }
  const btn = (action, label, extra = '', cls = 'btn btn-sm') => `<button class="${cls}" type="button" data-qz="${action}" ${extra}>${label}</button>`;
  const ghost = (action, label, extra = '') => btn(action, label, extra, 'btn btn-sm btn-ghost');

  function homeView(S) {
    if (!S.topics.length) return '<p class="ln-soon">Add topics or import a file first, then write questions for them here.</p>';
    const perTopic = S.topics.map(t => `${esc(t.title)}: ${S.questions.filter(q => String(q.topicId) === String(t.id)).length}`).join(' · ');
    const has = S.questions.length > 0;
    const row = a => {
      const done = ['submitted', 'graded'].includes(a.status);
      const label = `${esc(a.title || KIND_LABEL[a.kind] || a.kind)}${a.attempt > 1 ? ` (attempt ${a.attempt})` : ''}`;
      const action = done ? ghost('results', 'Results', `data-id="${esc(a.id)}"`) : ['in_progress', 'draft'].includes(a.status) ? ghost('resume', a.status === 'draft' ? 'Start' : 'Resume', `data-id="${esc(a.id)}"`) : '';
      return `<li>${label} · ${esc(KIND_LABEL[a.kind] || a.kind)} · ${esc(a.status.replace('_', ' '))} ${action}</li>`;
    };
    const past = S.assessments.filter(a => a.status !== 'abandoned').map(row).join('');
    const hasDone = S.assessments.some(a => ['submitted', 'graded'].includes(a.status));
    return `<p class="ln-soon">${S.questions.length} question${S.questions.length === 1 ? '' : 's'} in your bank${perTopic ? ` (${perTopic})` : ''}.</p>
      <div class="qz-row">${ghost('add', 'Add question', 'data-qz-focus')}
        ${btn('start', 'Pre-test', has ? '' : 'disabled title="Add at least one question first"')}
        ${btn('practice', 'Practice', has ? 'title="Short set with feedback after each question"' : 'disabled title="Add at least one question first"')}
        ${btn('exam', 'Final exam', has ? 'title="Timed exam with a pass mark"' : 'disabled title="Add at least one question first"')}
        ${hasDone && S.journey ? ghost('report', 'Report', 'title="Pre-test vs final, by topic"') : ''}</div>
      ${past ? `<ul class="qz-list" aria-label="Your quizzes and exams">${past}</ul>` : ''}`;
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
      <label class="ln-field"><span>Type</span><select class="field" name="type" data-qz-type>${typeOptions}</select></label>
      <label class="ln-field"><span>Topic</span><select class="field" name="topicId">${topicOptions}</select></label>
      <label class="ln-field"><span>Question</span><textarea class="field field-area" name="prompt" rows="2" maxlength="2000" data-qz-focus>${esc(f.prompt || '')}</textarea></label>
      ${fields}
      <span class="qz-opt-row"><label class="ln-field"><span>Skill tested</span><select class="field" name="dimension">${dims}</select></label>
        <label class="ln-field"><span>Difficulty</span><select class="field" name="difficulty">${[1, 2, 3].map(d => `<option value="${d}"${Number(f.difficulty || 2) === d ? ' selected' : ''}>${['', 'Easy', 'Medium', 'Hard'][d]}</option>`).join('')}</select></label></span>
      <label class="ln-field"><span>Explanation (shown after you answer)</span><textarea class="field field-area" name="explanation" rows="2" maxlength="2000">${esc(f.explanation || '')}</textarea></label>
      <div class="qz-row"><button class="btn btn-sm" type="submit"${S.busy ? ' disabled' : ''}>Save question</button>${ghost('home', 'Done')}</div>
    </form>`;
  }

  // ───────── answering
  const hasAnswer = a => a && (a.dontKnow || (a.response && ((a.response.choice || []).length || (a.response.pairs || []).length || typeof a.response.value === 'boolean' || (a.response.text || '').trim())));
  function control(item, answer, locked) {
    const q = item.question; const p = q.payload || {}; const r = (answer && answer.response) || {}; const dis = locked ? ' disabled' : '';
    if (q.type === 'choice') {
      const picked = new Set(r.choice || []);
      return `<div role="${p.multiple ? 'group' : 'radiogroup'}" aria-label="Answers" class="qz-choices">${(p.options || []).map((o, i) => `<label class="qz-choice"><input type="${p.multiple ? 'checkbox' : 'radio'}" name="choice" value="${esc(o.id)}"${picked.has(o.id) ? ' checked' : ''}${dis}><span><kbd>${'ABCDEFGH'[i]}</kbd> ${esc(o.text)}</span></label>`).join('')}</div>`;
    }
    if (q.type === 'truefalse') return `<div role="radiogroup" aria-label="True or false" class="qz-choices"><p>${esc(p.statement)}</p>${['true', 'false'].map(v => `<label class="qz-choice"><input type="radio" name="tf" value="${v}"${typeof r.value === 'boolean' && r.value === (v === 'true') ? ' checked' : ''}${dis}><span><kbd>${v === 'true' ? 'T' : 'F'}</kbd> ${v === 'true' ? 'True' : 'False'}</span></label>`).join('')}</div>`;
    if (q.type === 'matching') {
      const given = new Map((r.pairs || []).map(([l, rt]) => [l, rt]));
      const right = (p.right || []).map(o => `<option value="${esc(o.id)}">${esc(o.text)}</option>`).join('');
      return `<div class="qz-choices" aria-label="Match each item">${(p.left || []).map(l => `<label class="qz-match"><span>${esc(l.text)}</span><select class="field" name="match:${esc(l.id)}"${dis}><option value="">Choose…</option>${right.replace(`value="${esc(given.get(l.id))}"`, `value="${esc(given.get(l.id))}" selected`)}</select></label>`).join('')}</div>`;
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
    return `<div class="qz-feedback" role="status"><p><strong>${esc(state)}</strong>${f.status === 'graded' ? ` · ${f.score}/${f.max}` : ''}</p>${key ? `<p>${f.status === 'pending' ? 'Model' : 'Correct'}: ${esc(key)}</p>` : ''}${f.explanation ? `<p class="ln-soon">${esc(f.explanation)}</p>` : ''}</div>`;
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
    const nextBtn = practice && !checked ? btn('check', 'Check') : last ? btn('submit', 'Submit') : btn('next', 'Next');
    return `<div class="qz-head"><strong>${esc(KIND_LABEL[kind] || kind)}${Q.assessment.config && Q.assessment.config.test ? ' (test)' : ''}</strong> · Question ${Q.index + 1} of ${items.length} · ${answered} answered ${timer}<span class="qz-save" aria-live="polite">${esc(Q.saveText || '')}</span></div>
      <div class="qz-bar" aria-hidden="true"><i style="width:${Math.round((answered / items.length) * 100)}%"></i></div>
      <form class="qz-card" data-qz-form="answer" novalidate tabindex="-1">
        <p class="qz-meta">${esc(TYPES[item.question.type] || '')}${topic ? ` · ${esc(topic)}` : ''}${Q.flags.has(item.id) ? ' · ⚑ flagged' : ''}</p>
        <p class="qz-prompt" tabindex="-1" data-qz-focus>${esc(item.question.prompt)}</p>
        ${control(item, answer, Boolean(checked))}
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
    return `<form class="qz-form" data-qz-form="grade" novalidate><p>Your written answers are graded by you. Be honest: this is how the app learns where you are.</p>${rows}<div class="qz-row"><button class="btn btn-sm" type="submit" data-qz-focus>Save my grades</button></div></form>`;
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
    return `<table class="qz-table"><caption>Every final attempt, side by side</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Score</th><th scope="col">Pass mark</th><th scope="col">Result</th><th scope="col">Time</th><th scope="col">By topic</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function resultsView(S) {
    const R = S.results; const items = R.assessment.items; const t = R.assessment.totals;
    const topics = (R.mastery.topics || []).map(x => `<tr><th scope="row">${esc(x.title || x.topicId)}</th><td><span class="qz-chip">${esc(LEVELS[x.level] || x.level)}</span></td><td>${x.items} item${x.items === 1 ? '' : 's'}</td></tr>`).join('');
    const review = items.map(i => {
      const a = i.answer || {}; const ok = a.score >= i.maxScore;
      const state = a.dontKnow ? "I don't know" : ok ? '✓ Correct' : a.score > 0 ? '◐ Partly correct' : '✗ Incorrect';
      return `<li class="qz-rev"><p class="qz-prompt">${esc(i.snapshot.prompt)}</p><p><strong>${state}</strong> · ${a.score == null ? 0 : a.score}/${i.maxScore}${a.mistakeCategory ? ` · ${esc(a.mistakeCategory.replace('_', ' '))}` : ''}</p><p>You answered: ${esc(answerText(i.snapshot, a.response))}</p><p>Correct: ${esc(correctText(i.snapshot))}</p>${i.snapshot.explanation ? `<p class="ln-soon">${esc(i.snapshot.explanation)}</p>` : ''}</li>`;
    }).join('');
    const failedFinal = R.assessment.kind === 'final' && R.assessment.exam && R.assessment.exam.passed === false;
    return `<p class="qz-score" tabindex="-1" data-qz-focus>${esc(KIND_LABEL[R.assessment.kind] || '')}: ${t.score} of ${t.max} points</p>
      ${examBanner(R)}
      ${topics ? `<table class="qz-table"><caption>Where you stand by topic</caption><thead><tr><th scope="col">Topic</th><th scope="col">Level</th><th scope="col">Evidence</th></tr></thead><tbody>${topics}</tbody></table>
      <p class="ln-soon">A level needs at least 3 graded items on a topic; below that it reads Not assessed.</p>` : ''}
      ${attemptsTable(R)}
      <ol class="qz-reviews">${review}</ol>
      <div class="qz-row">${failedFinal ? btn('retake', 'Retake the final', `data-id="${esc(R.assessment.id)}"`) : ''}${S.journey ? ghost('report', 'Report') : ''}${ghost('home', 'Back')}</div>`;
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
      <table class="qz-table"><caption>Pre-test vs now, by topic (items counted in brackets)</caption><thead><tr><th scope="col">Topic</th><th scope="col">Pre-test</th><th scope="col">Now</th><th scope="col">Change</th><th scope="col">By skill</th></tr></thead><tbody>${rows}</tbody></table>
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
    Q.timer = setTimeout(() => saveNow(S), 600);
    const count = form.querySelector('[data-qz-count]'); if (count && Q.dirty.text != null) count.textContent = `${words(Q.dirty.text)} words`;
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
    S.results = { assessment, mastery, attempts }; S.mode = 'results'; S.errors = ''; paint(S);
  }
  async function afterSubmit(S, submitted) {
    stopTimer(S);
    if (submitted.status === 'graded') { await showResults(S, submitted.id); return; }
    S.grade = { assessment: submitted, items: submitted.items.filter(i => i.answer && i.answer.gradeStatus === 'pending' && ['explain', 'essay'].includes(i.snapshot.type)) };
    S.mode = 'grade'; S.errors = ''; paint(S);
  }
  async function begin(S, kind, title, config, extra = {}) {
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
      E.preview = await D().examPreview({ subjectId: S.subjectId, journeyId: S.journey ? S.journey.id : undefined, retakeOf: E.retakeOf, config: { count: Number(E.count) || 1, test: E.test, timeMultiplier: Number(E.multiplier) } });
    } catch (error) { E.preview = { ok: false, problem: error.message, min: 50, max: 100 }; }
    if (S.mode === 'examSetup') paint(S);
  }
  const move = (S, delta) => { S.quiz.index = Math.min(S.quiz.assessment.items.length - 1, Math.max(0, S.quiz.index + delta)); S.quiz.confirm = false; paint(S); };

  async function onClick(S, event) {
    const target = event.target.closest('[data-qz]'); if (!target) return;
    const action = target.dataset.qz; S.errors = '';
    try {
      if (action === 'add') { S.mode = 'add'; paint(S); }
      else if (action === 'home') { stopTimer(S); await load(S); S.mode = 'home'; paint(S); }
      else if (action === 'start') { target.disabled = true; await begin(S, 'diagnostic', 'Pre-test', { count: Math.max(1, S.topics.length * 2) }); }
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
      else if (action === 'leave') { stopTimer(S); await saveNow(S); await load(S); S.mode = 'home'; paint(S); }
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
        const type = form.elements.type.value; const q = readAdd(form, type); q.subjectId = S.subjectId;
        S.form = captureAdd(form, type); S.busy = true; // keep everything typed, so a rejected question comes back as entered
        await D().questionsSave({ question: q });
        S.form = { type, topicId: form.elements.topicId.value }; await load(S); S.busy = false; S.errors = ''; S.mode = 'add'; paint(S); H.toast('Question saved.');
      } else if (kind === 'grade') {
        for (const item of S.grade.items) {
          const verdicts = {}; for (const c of item.snapshot.payload.rubric || []) verdicts[c.id] = form.elements[`${item.id}:${c.id}`].checked ? 'met' : 'missing';
          await D().assessmentGrade({ itemId: item.id, verdicts, grader: 'self' });
        }
        await showResults(S, S.grade.assessment.id);
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
        if (event.target.matches('[data-qz-type]')) { const form = event.target.form; S.form = { type: event.target.value, topicId: form.elements.topicId.value, prompt: form.elements.prompt.value }; paint(S); return; }
        if (S.mode === 'examSetup' && event.target.form && event.target.form.dataset.qzForm === 'exam') {
          const f = event.target.form.elements; Object.assign(S.exam, { count: f.count.value, test: f.test.checked, multiplier: Number(f.multiplier.value) }); refreshPreview(S); return;
        }
        const form = event.target.closest('[data-qz-form="answer"]'); if (form) onAnswerChange(S, form);
      });
      host.addEventListener('input', event => { const form = event.target.closest('[data-qz-form="answer"]'); if (form && event.target.matches('textarea')) onAnswerChange(S, form); });
    }
    if (S.mode === 'home') load(S).then(() => paint(S)).catch(error => fail(S, error));
    else { paint(S); if (S.mode === 'quiz') startTimer(S); }
  }

  window.PerflwQuiz = { mount, init: helpers => { H = { ...H, ...helpers }; } };
})();
