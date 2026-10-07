// Brain Calendar: the "Jobs" page (Brain Calendar #28, #33, #6, #43, #27).
// Jobs live in Brain Calendar's own bc_jobs table. They come from job-alert
// emails (scored by AI) and from employer emails; you move them along here.
// Interview times found in emails wait here (and in Telegram) for one tap (#43).
// This file never reads or writes Open Brain thoughts.

// ---------- Pure helpers (no page needed; tested in brain-calendar/tests) ----------

const JOBS_STAGES = [
  { key: 'new', label: 'New matches' },
  { key: 'interested', label: 'Interested' },
  { key: 'applied', label: 'Applied' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
];

// Group jobs into the pipeline. New matches below the score cutoff are hidden (#6).
function jobsBuildPipeline(jobs, cutoff) {
  const min = Number(cutoff) >= 0 ? Number(cutoff) : 7;
  const groups = JOBS_STAGES.map(s => ({ ...s, items: [] }));
  const closed = [];
  let hiddenLow = 0;
  for (const j of jobs || []) {
    if (j.status === 'rejected' || j.status === 'archived') { closed.push(j); continue; }
    if (j.status === 'new' && j.score !== null && j.score !== undefined && Number(j.score) < min) { hiddenLow++; continue; }
    const g = groups.find(x => x.key === j.status);
    if (g) g.items.push(j);
  }
  const byScore = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(b.created_at).localeCompare(String(a.created_at));
  const byTime = (a, b) => String(b.status_changed_at || b.created_at).localeCompare(String(a.status_changed_at || a.created_at));
  for (const g of groups) g.items.sort(g.key === 'new' ? byScore : byTime);
  closed.sort(byTime);
  return { groups, closed, hiddenLow, cutoff: min };
}

// The buttons on a job card: where it can go next.
function jobsNextActions(status) {
  const next = {
    new: [['interested', 'Interested'], ['applied', 'I applied']],
    interested: [['applied', 'I applied']],
    applied: [['interviewing', 'Interviewing'], ['rejected', 'Rejected']],
    interviewing: [['offer', 'Offer'], ['rejected', 'Rejected']],
    offer: [],
    rejected: [['applied', 'Reopen']],
    archived: [['new', 'Restore']],
  }[status] || [];
  const out = next.map(([to, label]) => ({ to, label }));
  if (status !== 'archived') out.push({ to: 'archived', label: 'Archive' });
  return out;
}

// What the app has cost this month, by feature (#27).
function jobsCostByFeature(rows, now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const by = {};
  let total = 0;
  for (const r of rows || []) {
    if (new Date(r.created_at).getTime() < start) continue;
    const a = Number(r.amount_usd) || 0;
    by[r.feature] = (by[r.feature] || 0) + a;
    total += a;
  }
  return { total, features: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([feature, amount]) => ({ feature, amount })) };
}

if (typeof module !== 'undefined') {
  module.exports = { jobsBuildPipeline, jobsNextActions, jobsCostByFeature, JOBS_STAGES };
}

// ---------- The page ----------

if (typeof document !== 'undefined') {
  const J = { busy: false };
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

  function jobsNote(html, kind) {
    el('jobsNotes').insertAdjacentHTML('beforeend', `<div class="msg ${kind || 'err'}">${html}</div>`);
  }

  function jobCard(j) {
    const score = j.score !== null && j.score !== undefined ? `<span class="pl-chip">${esc(Number(j.score))}/10</span>` : '';
    const src = j.source ? `<span class="pl-chip brain">${esc(j.source)}</span>` : '';
    const where = [j.company, j.location].filter(Boolean).map(esc).join(' · ');
    const when = j.status === 'applied' && j.applied_at ? `applied ${day(j.applied_at)}` : day(j.status_changed_at || j.created_at);
    const link = j.url ? `<a class="link" href="${esc(j.url)}" target="_blank" rel="noopener">Open email</a>` : '';
    const btns = jobsNextActions(j.status).map(a =>
      `<button class="${a.to === 'archived' || a.to === 'rejected' ? 'secondary' : ''}" data-job="${j.id}:${a.to}">${esc(a.label)}</button>`).join('');
    return `<div class="pl-item"><div class="pl-body">
      <div class="pl-title">${esc(j.title || '(no title)')}</div>
      <div class="pl-when">${where} ${score}${src}</div>
      <div class="pl-when">${esc(when)}${j.notes ? ' · ' + esc(j.notes) : ''} ${link}</div>
      <div class="pl-actions">${btns}</div></div></div>`;
  }

  async function jobsLoad() {
    if (J.busy) return;
    J.busy = true;
    el('jobsNotes').innerHTML = '';
    try {
      const [jobsR, setR, propR, costR] = await Promise.all([
        sb.from('bc_jobs').select('*').order('created_at', { ascending: false }).limit(500),
        sb.from('bc_settings').select('key,value').in('key', ['job_score_cutoff', 'enabled.job_search']),
        sb.from('bc_proposals').select('id,summary').eq('status', 'pending').eq('kind', 'interview').order('created_at'),
        sb.from('bc_costs').select('feature,amount_usd,created_at').gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
      ]);
      if (jobsR.error) throw new Error('Job tables are not set up yet. Run brain-calendar/sql/004_jobs_email.sql in the Supabase SQL Editor.');
      const s = Object.fromEntries((setR.data || []).map(x => [x.key, x.value]));
      if (s['enabled.job_search'] === false) jobsNote('The job search is paused (setting enabled.job_search).', 'ok');
      const v = jobsBuildPipeline(jobsR.data || [], s.job_score_cutoff ?? 7);

      let html = '';
      const props = propR.data || [];
      if (props.length) {
        html += '<div class="pl-day">Interviews waiting for your OK</div>' + props.map(p => `<div class="pl-item"><div class="pl-body">
          <div class="pl-title">${esc(p.summary)}</div>
          <div class="pl-actions"><button data-job-decide="${p.id}:approved">Approve</button>
          <button class="secondary" data-job-decide="${p.id}:not_now">Not now</button></div></div></div>`).join('');
      }
      for (const g of v.groups) {
        html += `<div class="pl-day">${esc(g.label)}${g.key === 'new' ? ` <span style="text-transform:none; font-weight:400;">(score ${v.cutoff}+)</span>` : ''}</div>`;
        html += g.items.length ? g.items.map(jobCard).join('') : '<div class="pl-empty">None yet.</div>';
      }
      if (v.hiddenLow) html += `<div class="pl-empty">${v.hiddenLow} lower-scoring ${v.hiddenLow === 1 ? 'opening is' : 'openings are'} hidden (cutoff ${v.cutoff}, setting job_score_cutoff).</div>`;
      if (v.closed.length) {
        html += `<details class="card"><summary style="cursor:pointer; font-size:13px; color:#999;">Closed (${v.closed.length})</summary>${v.closed.map(jobCard).join('')}</details>`;
      }
      el('jobsList').innerHTML = html;

      const c = jobsCostByFeature(costR.data || [], new Date());
      el('jobsCost').innerHTML = `This month the app's AI has cost $${c.total.toFixed(2)}` +
        (c.features.length ? ': ' + c.features.map(f => `${esc(f.feature)} $${f.amount.toFixed(3)}`).join(', ') : '.');
    } catch (err) {
      el('jobsList').innerHTML = '';
      jobsNote(esc(err.message || 'Could not load jobs.'));
    } finally {
      J.busy = false;
    }
  }

  async function jobsMove(id, status) {
    const { error } = await sb.from('bc_jobs').update({ status }).eq('id', id);
    if (error) jobsNote('Could not save that. Try again.');
    jobsLoad();
  }

  async function jobsDecide(id, decision) {
    // Same server action as the Today page, so Approve puts the interview on the Brain calendar.
    const { data, error } = await sb.functions.invoke('bc-calendar', { body: { action: 'decide', proposal_id: id, decision } });
    if (error || !data?.ok) jobsNote('Could not save that. Try again.');
    else if (data.result === 'stale') jobsNote(esc(data.text), 'ok');
    jobsLoad();
  }

  document.addEventListener('click', e => {
    const d = e.target.dataset || {};
    if (d.job) { const [id, to] = d.job.split(':'); jobsMove(id, to); }
    if (d.jobDecide) { const [id, decision] = d.jobDecide.split(':'); jobsDecide(id, decision); }
  });

  window.loadJobs = jobsLoad;
}
