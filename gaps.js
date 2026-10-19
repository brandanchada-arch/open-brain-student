// Study screen: Gaps + Quiz, one card at a time (design C, Oct 19, 2026).
// Gaps: asks the gap-questions function for 3 things my brain is missing.
//       Each answer saves as a normal thought (question + answer together).
//       Works offline too: answers wait on the phone and send when I'm back online.
// Quiz: asks the daily-quiz function for 3 questions from my recent class notes;
//       answer out loud, reveal, mark Got it / Missed it. Nothing from the quiz is saved.
// Both functions check my login on the server. The last set is remembered on this phone,
// so reopening the screen doesn't cost another AI call.

const GQ_CACHE = { gaps: 'ob.gaps.last', quiz: 'ob.quiz.last' };

function gqRead(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function gqWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: fine */ }
}
function gqEsc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function gqWhen(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} day(s) ago`;
}
function gqSteps(qs, idx, isDone) {
  return `<div class="gq-steps" aria-hidden="true">${qs.map((x, i) =>
    `<span class="gq-step ${i === idx ? 'now' : isDone(x) ? 'done' : ''}"></span>`).join('')}
    <span class="gq-count">${Math.min(idx + 1, qs.length)} of ${qs.length}</span></div>`;
}
const GQ_MIC = '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';

async function gqFetch(fn) {
  if (!navigator.onLine) throw new Error('New questions need a connection. Your last set is still here.');
  const { data, error } = await sb.functions.invoke(fn, { body: {} });
  if (error) {
    // supabase-js hides the function's own error message; read it from the response.
    let reason = '';
    try { reason = (await error.context.json()).error || ''; } catch { /* not JSON */ }
    throw new Error(reason || error.message);
  }
  if (!data || data.ok === false) throw new Error(data?.error || 'Something went wrong.');
  return data;
}

// ---------- Gaps ----------
// state: { at, idx, questions: [{ q, why, draft?, status?: 'saved' | 'skipped' }] }
const gapDone = (x) => x.status === 'saved' || x.status === 'skipped' || x.saved;
function gapsNext(state) {
  const i = state.questions.findIndex(x => !gapDone(x));
  state.idx = i === -1 ? state.questions.length : i;
}

function renderGaps(state) {
  const list = document.getElementById('gapsList');
  const meta = document.getElementById('gapsMeta');
  const btn = document.getElementById('gapsBtn');
  if (!state || !state.questions || !state.questions.length) {
    meta.textContent = '';
    btn.className = ''; btn.textContent = 'Find gaps';
    list.innerHTML = `<div class="gq-card gq-done"><div class="big">What's missing?</div>
      <div class="gq-why">Your brain reads your last 30 days and asks about things you started but never finished writing down.</div></div>`;
    return;
  }
  if (state.idx === undefined) gapsNext(state);
  meta.textContent = `From your last 30 days of thoughts · ${gqWhen(state.at)}`;
  const qs = state.questions;
  if (state.idx >= qs.length) {
    const saved = qs.filter(x => x.status === 'saved' || x.saved).length;
    btn.className = ''; btn.textContent = 'Find new gaps';
    list.innerHTML = `<div class="gq-card gq-done"><div class="big">All caught up</div>
      <div class="gq-why">${saved} ${saved === 1 ? 'answer' : 'answers'} saved to your brain.</div></div>`;
    return;
  }
  btn.className = 'secondary'; btn.textContent = 'Find new gaps';
  const x = qs[state.idx];
  list.innerHTML = `${gqSteps(qs, state.idx, gapDone)}
    <div class="gq-card" id="gapCard" data-i="${state.idx}">
      <div class="gq-kicker">A gap in your brain</div>
      <div class="gq-q">${gqEsc(x.q)}</div>
      ${x.why ? `<div class="gq-why">Because of: ${gqEsc(x.why)}</div>` : ''}
      <label for="gapAnswer" style="margin:0;">Your answer</label>
      <textarea id="gapAnswer" class="gq-answer" data-gap-draft="${state.idx}" placeholder="Say it or type it…" style="min-height:96px;">${gqEsc(x.draft || '')}</textarea>
      <div class="gq-buttons">
        <button class="secondary icon-btn" data-gap-mic="1" aria-label="Answer by voice" type="button">${GQ_MIC}</button>
        <button class="grow" data-gap-save="${state.idx}" type="button">Save and next</button>
        <button class="secondary" data-gap-skip="${state.idx}" type="button">Skip</button>
      </div>
    </div>
    <div class="gq-swipe">Swipe left to skip</div>`;
}

async function loadGaps(fresh) {
  const btn = document.getElementById('gapsBtn');
  const msg = document.getElementById('gapsMsg');
  const cached = gqRead(GQ_CACHE.gaps);
  if (!fresh) { renderGaps(cached); return; }
  btn.disabled = true; btn.textContent = 'Reading your brain…';
  try {
    const data = await gqFetch('gap-questions');
    if (data.skipped) { showMsg(msg, gqEsc(data.note || 'Not enough recent thoughts yet.'), false); return; }
    const state = { at: Date.now(), idx: 0, questions: data.questions.map(q => ({ q: q.q, why: q.why })) };
    gqWrite(GQ_CACHE.gaps, state);
    renderGaps(state);
  } catch (err) {
    showMsg(msg, gqEsc(err.message || 'Could not get questions.'), false);
  } finally {
    btn.disabled = false;
    renderGaps(gqRead(GQ_CACHE.gaps));
  }
}

function gapSkip(i) {
  const state = gqRead(GQ_CACHE.gaps);
  if (!state || !state.questions[i]) return;
  state.questions[i].status = 'skipped';
  gapsNext(state); gqWrite(GQ_CACHE.gaps, state); renderGaps(state);
}

document.getElementById('gapsList').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.gapMic) { obDictate(document.getElementById('gapAnswer'), b); return; }
  if (b.dataset.gapSkip !== undefined) { gapSkip(Number(b.dataset.gapSkip)); return; }
  if (b.dataset.gapSave === undefined) return;
  const i = Number(b.dataset.gapSave);
  const state = gqRead(GQ_CACHE.gaps);
  if (!state) return;
  const answer = document.getElementById('gapAnswer').value.trim();
  const msg = document.getElementById('gapsMsg');
  if (!answer) { showMsg(msg, 'Type or say an answer first, or tap Skip.', false); return; }
  const q = state.questions[i];
  b.disabled = true;
  try {
    // Question + answer together so the thought makes sense on its own later.
    const r = await obSaveThought({ content: `${q.q}\n${answer}`, metadata: { source: 'gap-questions' } });
    q.status = 'saved'; delete q.draft;
    gapsNext(state); gqWrite(GQ_CACHE.gaps, state); renderGaps(state);
    if (r.queued) showMsg(msg, 'Saved on this phone. It goes to your brain when you\'re back online.', true);
  } catch (err) {
    b.disabled = false;
    showMsg(msg, gqEsc(err.message || 'Save failed.'), false);
  }
});

// Remember what I'm typing so leaving the screen (or closing the app) doesn't lose it.
document.getElementById('gapsList').addEventListener('input', (e) => {
  const i = e.target.dataset.gapDraft;
  if (i === undefined) return;
  const state = gqRead(GQ_CACHE.gaps);
  if (!state || !state.questions[Number(i)]) return;
  state.questions[Number(i)].draft = e.target.value;
  gqWrite(GQ_CACHE.gaps, state);
});

// Swipe left on the card to skip it.
(function () {
  const list = document.getElementById('gapsList');
  let x0 = null, y0 = 0, card = null;
  list.addEventListener('touchstart', (e) => {
    card = e.target.closest('#gapCard');
    if (!card || e.target.closest('textarea, button')) { card = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!card || x0 === null) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) > Math.abs(dx)) return;
    card.style.transition = 'none';
    card.style.transform = `translateX(${Math.min(0, dx)}px) rotate(${Math.min(0, dx) / 40}deg)`;
  }, { passive: true });
  list.addEventListener('touchend', (e) => {
    if (!card || x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const c = card; card = null; x0 = null;
    c.style.transition = '';
    if (dx < -90) { c.style.transform = 'translateX(-120%)'; c.style.opacity = '0'; setTimeout(() => gapSkip(Number(c.dataset.i)), 180); }
    else c.style.transform = '';
  });
})();

document.getElementById('gapsBtn').addEventListener('click', () => loadGaps(true));

// ---------- Quiz ----------
// state: { at, idx, questions: [{ course, q, a, shown?, result?: 'got' | 'miss' }] }
const quizDone = (x) => !!x.result;

function renderQuiz(state) {
  const list = document.getElementById('quizList');
  const meta = document.getElementById('quizMeta');
  const btn = document.getElementById('quizBtn');
  if (!state || !state.questions || !state.questions.length) {
    meta.textContent = '';
    btn.className = ''; btn.textContent = 'New quiz';
    list.innerHTML = `<div class="gq-card gq-done"><div class="big">Quick quiz</div>
      <div class="gq-why">3 questions from your recent class notes. Answer out loud, then reveal.</div></div>`;
    return;
  }
  const qs = state.questions;
  if (state.idx === undefined) { const i = qs.findIndex(x => !quizDone(x)); state.idx = i === -1 ? qs.length : i; }
  const right = qs.filter(x => x.result === 'got').length;
  const done = qs.filter(quizDone).length;
  meta.textContent = `From your class notes · ${gqWhen(state.at)}${done ? ` · ${right}/${done} right` : ''}`;
  if (state.idx >= qs.length) {
    btn.className = ''; btn.textContent = 'New quiz';
    const missed = qs.filter(x => x.result === 'miss');
    list.innerHTML = `<div class="gq-card gq-done"><div class="big">${right}/${qs.length} right</div>
      <div class="gq-why">${missed.length ? 'Review these:' : 'Nice work. Nothing to review.'}</div></div>
      ${missed.map(x => `<div class="gq-card" style="margin-top:10px; gap:10px;">
        ${x.course ? `<span class="pl-chip" style="align-self:flex-start; margin:0;">${gqEsc(x.course)}</span>` : ''}
        <div style="font-size:16px; font-weight:600; line-height:1.4;">${gqEsc(x.q)}</div>
        <div class="gq-answer-box">${gqEsc(x.a)}</div></div>`).join('')}`;
    return;
  }
  btn.className = 'secondary'; btn.textContent = 'New quiz';
  const x = qs[state.idx], i = state.idx;
  list.innerHTML = `${gqSteps(qs, i, quizDone)}
    <div class="gq-card">
      <div class="gq-kicker">${x.course ? gqEsc(x.course) : 'Class notes'}</div>
      <div class="gq-q">${gqEsc(x.q)}</div>
      ${x.shown
        ? `<div class="gq-answer-box">${gqEsc(x.a)}</div>
           <div class="gq-buttons"><button class="grow gq-got" data-quiz-got="${i}" type="button">Got it</button>
           <button class="grow gq-miss" data-quiz-miss="${i}" type="button">Missed it</button></div>`
        : `<div class="gq-why">Say your answer out loud first.</div>
           <button data-quiz-show="${i}" type="button" style="width:100%;">Reveal answer</button>`}
    </div>`;
}

async function loadQuiz(fresh) {
  const btn = document.getElementById('quizBtn');
  const msg = document.getElementById('quizMsg');
  if (!fresh) { renderQuiz(gqRead(GQ_CACHE.quiz)); return; }
  btn.disabled = true; btn.textContent = 'Writing your quiz…';
  try {
    const data = await gqFetch('daily-quiz');
    if (data.skipped) { showMsg(msg, gqEsc(data.note || 'No class notes saved recently.'), false); return; }
    const state = { at: Date.now(), idx: 0, questions: data.questions.map(q => ({ course: q.course, q: q.q, a: q.a })) };
    gqWrite(GQ_CACHE.quiz, state);
  } catch (err) {
    showMsg(msg, gqEsc(err.message || 'Could not get a quiz.'), false);
  } finally {
    btn.disabled = false;
    renderQuiz(gqRead(GQ_CACHE.quiz));
  }
}

document.getElementById('quizList').addEventListener('click', (e) => {
  const state = gqRead(GQ_CACHE.quiz);
  const b = e.target.closest('button');
  if (!state || !b) return;
  const d = b.dataset;
  if (d.quizShow !== undefined) state.questions[Number(d.quizShow)].shown = true;
  else if (d.quizGot !== undefined) { state.questions[Number(d.quizGot)].result = 'got'; state.idx = Number(d.quizGot) + 1; }
  else if (d.quizMiss !== undefined) { state.questions[Number(d.quizMiss)].result = 'miss'; state.idx = Number(d.quizMiss) + 1; }
  else return;
  gqWrite(GQ_CACHE.quiz, state); renderQuiz(state);
});
document.getElementById('quizBtn').addEventListener('click', () => loadQuiz(true));
