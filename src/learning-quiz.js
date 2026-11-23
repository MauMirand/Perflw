/* Practice quiz on the subject page (first working slice of LS-008 to LS-011): write questions, take a pre-test, see results.
   One self-contained module: it renders into [data-qz-host] and listens on that element only (no document-level keys).
   Data goes through window.learningData (journey*, questions*, assessment*, mastery*). Answer keys never reach this file while
   a quiz is open; the main process strips them (src/learning-ipc.js). */
(function () {
  'use strict';
  const D = () => window.learningData;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LEVELS = { not_assessed: 'Not assessed', emerging: 'Emerging', developing: 'Developing', proficient: 'Proficient', mastered: 'Mastered' };
  const TYPES = { choice: 'Multiple choice', truefalse: 'True / false', explain: 'Explain', matching: 'Matching', essay: 'Essay' };
  let H = { toast: () => {}, announce: () => {} };
  const states = new Map(); // subjectId → state, so a re-render of the page keeps the quiz where it was

  function stateOf(subject) {
    if (!states.has(subject.id)) states.set(subject.id, { mode: 'home', subjectId: subject.id, name: subject.name, topics: [], questions: [], journey: null, assessments: [], form: { type: 'choice' }, errors: '', busy: false });
    return states.get(subject.id);
  }
  const say = text => { try { H.announce(text); } catch { /* optional */ } };
  const fail = (S, error) => { S.errors = error && error.message ? error.message : String(error); S.busy = false; paint(S); };

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
  function paint(S) {
    const host = hostOf(S); if (!host) return;
    const body = S.mode === 'add' ? addView(S) : S.mode === 'quiz' ? quizView(S) : S.mode === 'grade' ? gradeView(S) : S.mode === 'results' ? resultsView(S) : homeView(S);
    host.innerHTML = `<section class="ln-block qz" aria-labelledby="qz-title"><h3 class="ln-block-title" id="qz-title">Practice quiz</h3>${S.errors ? `<p class="qz-error" role="alert">${esc(S.errors)}</p>` : ''}${body}</section>`;
    const focus = host.querySelector('[data-qz-focus]'); if (focus) focus.focus();
  }
  const btn = (action, label, extra = '', cls = 'btn btn-sm') => `<button class="${cls}" type="button" data-qz="${action}" ${extra}>${label}</button>`;

  function homeView(S) {
    const perTopic = S.topics.map(t => `${esc(t.title)}: ${S.questions.filter(q => String(q.topicId) === String(t.id)).length}`).join(' · ');
    const canStart = S.questions.length > 0 && S.topics.length > 0;
    const past = S.assessments.filter(a => a.kind === 'diagnostic').map(a => `<li>${esc(a.title || 'Pre-test')} · ${esc(a.status.replace('_', ' '))} ${['submitted', 'graded'].includes(a.status) ? btn('results', 'Results', `data-id="${esc(a.id)}"`, 'btn btn-sm btn-ghost') : a.status === 'in_progress' ? btn('resume', 'Resume', `data-id="${esc(a.id)}"`, 'btn btn-sm btn-ghost') : ''}</li>`).join('');
    if (!S.topics.length) return '<p class="ln-soon">Add topics or import a file first, then write questions for them here.</p>';
    return `<p class="ln-soon">${S.questions.length} question${S.questions.length === 1 ? '' : 's'} in your bank${perTopic ? ` (${perTopic})` : ''}.</p>
      <div class="qz-row">${btn('add', 'Add question', 'data-qz-focus', 'btn btn-sm btn-ghost')}${btn('start', 'Start pre-test', canStart ? '' : 'disabled title="Add at least one question first"')}</div>
      ${past ? `<ul class="qz-list" aria-label="Earlier pre-tests">${past}</ul>` : ''}`;
  }

  function addView(S) {
    const f = S.form; const type = f.type;
    const topicOptions = S.topics.map(t => `<option value="${esc(t.id)}"${String(f.topicId) === String(t.id) ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
    const typeOptions = ['choice', 'truefalse', 'explain'].map(k => `<option value="${k}"${type === k ? ' selected' : ''}>${TYPES[k]}</option>`).join('');
    let fields = '';
    if (type === 'choice') {
      fields = [0, 1, 2, 3].map(i => `<label class="ln-field qz-opt"><span>Option ${i + 1}</span><span class="qz-opt-row"><input class="field" name="opt${i}" maxlength="500" value="${esc((f.opts || [])[i] || '')}"><label class="qz-correct"><input type="radio" name="correct" value="${i}"${Number(f.correct || 0) === i ? ' checked' : ''}> Correct</label></span></label>`).join('');
    } else if (type === 'truefalse') {
      fields = `<label class="ln-field"><span>Statement</span><input class="field" name="statement" maxlength="2000" value="${esc(f.statement || '')}"></label>
        <fieldset class="qz-fs"><legend>The statement is</legend><label><input type="radio" name="tf" value="true"${f.tf !== 'false' ? ' checked' : ''}> True</label> <label><input type="radio" name="tf" value="false"${f.tf === 'false' ? ' checked' : ''}> False</label></fieldset>`;
    } else {
      fields = [0, 1].map(i => `<label class="ln-field"><span>What a good answer covers (${i + 1})</span><input class="field" name="crit${i}" maxlength="500" value="${esc((f.crit || [])[i] || '')}"></label>`).join('');
    }
    return `<form class="qz-form" data-qz-form="add" novalidate>
      <label class="ln-field"><span>Type</span><select class="field" name="type" data-qz-type>${typeOptions}</select></label>
      <label class="ln-field"><span>Topic</span><select class="field" name="topicId">${topicOptions}</select></label>
      <label class="ln-field"><span>Question</span><textarea class="field field-area" name="prompt" rows="2" maxlength="2000" data-qz-focus>${esc(f.prompt || '')}</textarea></label>
      ${fields}
      <label class="ln-field"><span>Explanation (shown after you answer)</span><textarea class="field field-area" name="explanation" rows="2" maxlength="2000">${esc(f.explanation || '')}</textarea></label>
      <div class="qz-row"><button class="btn btn-sm" type="submit"${S.busy ? ' disabled' : ''}>Save question</button>${btn('home', 'Done', '', 'btn btn-sm btn-ghost')}</div>
    </form>`;
  }

  function control(item, answer) {
    const q = item.question; const p = q.payload || {}; const r = (answer && answer.response) || {};
    if (q.type === 'choice') {
      const picked = new Set(r.choice || []);
      return `<div role="${p.multiple ? 'group' : 'radiogroup'}" aria-label="Answers" class="qz-choices">${(p.options || []).map(o => `<label class="qz-choice"><input type="${p.multiple ? 'checkbox' : 'radio'}" name="choice" value="${esc(o.id)}"${picked.has(o.id) ? ' checked' : ''}><span>${esc(o.text)}</span></label>`).join('')}</div>`;
    }
    if (q.type === 'truefalse') return `<div role="radiogroup" aria-label="True or false" class="qz-choices"><p>${esc(p.statement)}</p>${['true', 'false'].map(v => `<label class="qz-choice"><input type="radio" name="tf" value="${v}"${r.value === (v === 'true') && typeof r.value === 'boolean' ? ' checked' : ''}><span>${v === 'true' ? 'True' : 'False'}</span></label>`).join('')}</div>`;
    if (q.type === 'explain') return `<textarea class="field field-area" name="text" rows="5" maxlength="20000" aria-label="Your answer">${esc(r.text || '')}</textarea>`;
    return `<p class="ln-soon">This question type (${esc(TYPES[q.type] || q.type)}) is not supported in this version. Skip it.</p>`;
  }

  function quizView(S) {
    const Q = S.quiz; const items = Q.assessment.items; const item = items[Q.index]; const answer = Q.answers[item.id];
    const answered = items.filter(i => Q.answers[i.id] && hasAnswer(Q.answers[i.id])).length;
    const last = Q.index === items.length - 1;
    const topic = (S.topics.find(t => String(t.id) === String(item.topicId)) || {}).title || '';
    const confidence = [[1, 'Guessing'], [2, 'Fairly sure'], [3, 'Certain']].map(([v, label]) => `<label><input type="radio" name="confidence" value="${v}"${answer && answer.confidence === v ? ' checked' : ''}> ${label}</label>`).join(' ');
    const confirm = Q.confirm ? `<div class="qz-confirm" role="alert">${items.length - answered} unanswered. ${btn('submit-now', 'Submit anyway')} ${btn('back-quiz', 'Go back', '', 'btn btn-sm btn-ghost')}</div>` : '';
    return `<div class="qz-head"><strong>Pre-test</strong> · Question ${Q.index + 1} of ${items.length} · ${answered} answered <span class="qz-save" aria-live="polite">${esc(Q.saveText || '')}</span></div>
      <form class="qz-card" data-qz-form="answer" novalidate>
        <p class="qz-meta">${esc(TYPES[item.question.type] || '')}${topic ? ` · ${esc(topic)}` : ''}</p>
        <p class="qz-prompt" tabindex="-1" data-qz-focus>${esc(item.question.prompt)}</p>
        ${control(item, answer)}
        <div class="qz-conf"><span>How sure are you?</span> ${confidence}</div>
        <label class="qz-dk"><input type="checkbox" name="dontKnow"${answer && answer.dontKnow ? ' checked' : ''}> I don't know</label>
      </form>
      ${confirm}
      <div class="qz-row">${btn('prev', 'Previous', Q.index === 0 ? 'disabled' : '', 'btn btn-sm btn-ghost')}${last ? btn('submit', 'Submit') : btn('next', 'Next')}${btn('leave', 'Leave (answers are saved)', '', 'btn btn-sm btn-ghost')}</div>`;
  }
  const hasAnswer = a => a.dontKnow || (a.response && ((a.response.choice || []).length || typeof a.response.value === 'boolean' || (a.response.text || '').trim()));

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
    return (r.text || '').trim() || '—';
  }
  function correctText(q) {
    const p = q.payload || {};
    if (q.type === 'choice') return (p.correct || []).map(id => (p.options.find(o => o.id === id) || {}).text).join(', ');
    if (q.type === 'truefalse') return p.correct ? 'True' : 'False';
    return p.modelAnswer || (p.rubric || []).map(c => c.criterion).join('; ');
  }
  function resultsView(S) {
    const R = S.results; const items = R.assessment.items;
    const score = items.reduce((t, i) => t + ((i.answer && i.answer.score) || 0), 0); const max = items.reduce((t, i) => t + i.maxScore, 0);
    const topics = (R.mastery.topics || []).map(t => `<tr><th scope="row">${esc(t.title || t.topicId)}</th><td><span class="qz-chip">${esc(LEVELS[t.level] || t.level)}</span></td><td>${t.items} item${t.items === 1 ? '' : 's'}</td></tr>`).join('');
    const review = items.map(i => {
      const a = i.answer || {}; const ok = a.score >= i.maxScore;
      const state = a.dontKnow ? 'I don\'t know' : ok ? '✓ Correct' : a.score > 0 ? '◐ Partly correct' : '✗ Incorrect';
      return `<li class="qz-rev"><p class="qz-prompt">${esc(i.snapshot.prompt)}</p><p><strong>${state}</strong> · ${a.score == null ? 0 : a.score}/${i.maxScore}${a.mistakeCategory ? ` · ${esc(a.mistakeCategory.replace('_', ' '))}` : ''}</p><p>You answered: ${esc(answerText(i.snapshot, a.response))}</p><p>Correct: ${esc(correctText(i.snapshot))}</p>${i.snapshot.explanation ? `<p class="ln-soon">${esc(i.snapshot.explanation)}</p>` : ''}</li>`;
    }).join('');
    return `<p class="qz-score" tabindex="-1" data-qz-focus>${score} of ${max} points</p>
      ${topics ? `<table class="qz-table"><caption>Where you stand by topic</caption><thead><tr><th scope="col">Topic</th><th scope="col">Level</th><th scope="col">Evidence</th></tr></thead><tbody>${topics}</tbody></table>
      <p class="ln-soon">A level needs at least 3 graded items on a topic; below that it reads Not assessed.</p>` : ''}
      <ol class="qz-reviews">${review}</ol><div class="qz-row">${btn('home', 'Back', '', 'btn btn-sm btn-ghost')}</div>`;
  }

  // ───────── answers
  function readResponse(form, item) {
    const q = item.question; const out = {}; const get = n => form.elements[n];
    if (q.type === 'choice') out.choice = [...form.querySelectorAll('input[name="choice"]:checked')].map(i => i.value);
    else if (q.type === 'truefalse') { const c = form.querySelector('input[name="tf"]:checked'); if (c) out.value = c.value === 'true'; }
    else if (q.type === 'explain') out.text = get('text') ? get('text').value : '';
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
    } catch (error) { Q.dirty = response; Q.saveText = 'Not saved. Press Next to retry.'; setSave(S); S.errors = error.message; return false; }
  }
  const setSave = S => { const el = hostOf(S) && hostOf(S).querySelector('.qz-save'); if (el) el.textContent = S.quiz.saveText || ''; };
  function onAnswerChange(S, form) {
    const Q = S.quiz; const item = Q.assessment.items[Q.index];
    Q.dirty = readResponse(form, item); Q.saveText = ''; clearTimeout(Q.timer);
    Q.timer = setTimeout(() => saveNow(S), 600);
  }

  // ───────── actions
  async function openQuiz(S, assessment, index = 0) {
    const answers = {}; for (const i of assessment.items) if (i.answer) answers[i.id] = i.answer;
    const first = assessment.items.findIndex(i => !(i.answer && hasAnswer(i.answer)));
    S.quiz = { assessment, index: index || Math.max(0, first), answers, dirty: null, saveText: '', confirm: false };
    S.mode = 'quiz'; S.errors = ''; paint(S);
  }
  async function showResults(S, assessmentId) {
    const assessment = await D().assessmentResults({ assessmentId });
    const mastery = assessment.journeyId ? await D().masteryJourney({ journeyId: assessment.journeyId }) : { topics: [] };
    S.results = { assessment, mastery }; S.mode = 'results'; S.errors = ''; paint(S);
  }
  async function afterSubmit(S, submitted) {
    if (submitted.status === 'graded') { await showResults(S, submitted.id); return; }
    S.grade = { assessment: submitted, items: submitted.items.filter(i => i.answer && i.answer.gradeStatus === 'pending' && i.snapshot.type === 'explain') };
    S.mode = 'grade'; S.errors = ''; paint(S);
  }

  async function onClick(S, event) {
    const target = event.target.closest('[data-qz]'); if (!target) return;
    const action = target.dataset.qz; S.errors = '';
    try {
      if (action === 'add') { S.mode = 'add'; paint(S); }
      else if (action === 'home') { await load(S); S.mode = 'home'; paint(S); }
      else if (action === 'start') {
        target.disabled = true;
        const journey = S.journey || await D().journeyCreate({ subjectId: S.subjectId });
        const made = await D().assessmentCreate({ subjectId: S.subjectId, journeyId: journey.id, kind: 'diagnostic', title: 'Pre-test', config: { count: Math.max(1, S.topics.length * 2) } });
        const started = await D().assessmentStart({ assessmentId: made.assessment.id });
        await D().journeyUpdate({ journeyId: journey.id, stage: 'pretest' });
        S.journey = journey; if (made.available < made.requested) H.toast(`Only ${made.available} question${made.available === 1 ? '' : 's'} available, so the pre-test has ${made.available}.`);
        await openQuiz(S, started); say('Pre-test started.');
      } else if (action === 'resume') await openQuiz(S, await D().assessmentGet({ assessmentId: target.dataset.id }));
      else if (action === 'results') await showResults(S, target.dataset.id);
      else if (['prev', 'next'].includes(action)) { if (await saveNow(S)) { S.quiz.index += action === 'next' ? 1 : -1; S.quiz.confirm = false; paint(S); } else paint(S); }
      else if (action === 'leave') { await saveNow(S); await load(S); S.mode = 'home'; paint(S); }
      else if (action === 'back-quiz') { S.quiz.confirm = false; paint(S); }
      else if (action === 'submit') {
        if (!(await saveNow(S))) { paint(S); return; }
        const Q = S.quiz; const open = Q.assessment.items.filter(i => !(Q.answers[i.id] && hasAnswer(Q.answers[i.id]))).length;
        if (open && !Q.confirm) { Q.confirm = true; paint(S); } else await afterSubmit(S, await D().assessmentSubmit({ assessmentId: Q.assessment.id }));
      } else if (action === 'submit-now') await afterSubmit(S, await D().assessmentSubmit({ assessmentId: S.quiz.assessment.id }));
    } catch (error) { fail(S, error); }
  }

  async function onSubmit(S, event) {
    const form = event.target.closest('[data-qz-form]'); if (!form) return;
    event.preventDefault(); const kind = form.dataset.qzForm;
    try {
      if (kind === 'add') {
        const f = form.elements; const type = f.type.value; const q = { subjectId: S.subjectId, topicId: f.topicId.value, type, prompt: f.prompt.value, dimension: type === 'explain' ? 'recall' : 'recognition', difficulty: 2, explanation: f.explanation.value };
        if (type === 'choice') {
          const opts = [0, 1, 2, 3].map(i => ({ id: `o${i}`, text: f[`opt${i}`].value })).filter(o => o.text.trim());
          const chosen = `o${form.querySelector('input[name="correct"]:checked').value}`;
          q.payload = { options: opts, correct: [chosen], multiple: false };
        } else if (type === 'truefalse') q.payload = { statement: f.statement.value, correct: form.querySelector('input[name="tf"]:checked').value === 'true', requireJustification: false };
        else q.payload = { rubric: [0, 1].map(i => ({ id: `c${i}`, criterion: f[`crit${i}`].value, points: 1 })).filter(c => c.criterion.trim()) };
        // Keep everything typed, so a rejected question comes back as it was entered.
        const typed = { type, topicId: f.topicId.value, prompt: f.prompt.value, explanation: f.explanation.value };
        if (type === 'choice') Object.assign(typed, { opts: [0, 1, 2, 3].map(i => f[`opt${i}`].value), correct: Number(form.querySelector('input[name="correct"]:checked').value) });
        else if (type === 'truefalse') Object.assign(typed, { statement: f.statement.value, tf: form.querySelector('input[name="tf"]:checked').value });
        else Object.assign(typed, { crit: [0, 1].map(i => f[`crit${i}`].value) });
        S.form = typed; S.busy = true;
        await D().questionsSave({ question: q });
        S.form = { type, topicId: f.topicId.value }; await load(S); S.busy = false; S.errors = ''; S.mode = 'add'; paint(S); H.toast('Question saved.');
      } else if (kind === 'grade') {
        for (const item of S.grade.items) {
          const verdicts = {}; for (const c of item.snapshot.payload.rubric || []) verdicts[c.id] = form.elements[`${item.id}:${c.id}`].checked ? 'met' : 'missing';
          await D().assessmentGrade({ itemId: item.id, verdicts, grader: 'self' });
        }
        await showResults(S, S.grade.assessment.id);
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
      host.addEventListener('change', event => {
        if (event.target.matches('[data-qz-type]')) { const form = event.target.form; S.form = { type: event.target.value, topicId: form.elements.topicId.value, prompt: form.elements.prompt.value }; paint(S); return; }
        const form = event.target.closest('[data-qz-form="answer"]'); if (form) onAnswerChange(S, form);
      });
      host.addEventListener('input', event => { const form = event.target.closest('[data-qz-form="answer"]'); if (form && event.target.matches('textarea')) onAnswerChange(S, form); });
    }
    if (S.mode === 'home') load(S).then(() => paint(S)).catch(error => fail(S, error)); else paint(S);
  }

  window.PerflwQuiz = { mount, init: helpers => { H = { ...H, ...helpers }; } };
})();
