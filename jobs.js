// Brain Calendar: the "Jobs" page (Brain Calendar #28, #33, #6, #43, #27, #71-#74).
// Jobs live in Brain Calendar's own bc_jobs table. They come from job-alert
// emails and the JSearch job search (scored by AI), and from employer emails;
// you move them along here. Tap a job to read the full posting, then mark it
// Applied or Not interested. Interview times found in emails wait here for one tap (#43).
// A job notification opens #jobs/<id>, which shows that job.
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
// "Not interested", rejected and archived go to the closed list. Phoenix Valley first (#72).
function jobsBuildPipeline(jobs, cutoff) {
  const min = Number(cutoff) >= 0 ? Number(cutoff) : 7;
  const groups = JOBS_STAGES.map(s => ({ ...s, items: [] }));
  const closed = [];
  let hiddenLow = 0;
  for (const j of jobs || []) {
    if (j.status === 'rejected' || j.status === 'archived' || j.status === 'not_interested') { closed.push(j); continue; }
    if (j.status === 'new' && j.score !== null && j.score !== undefined && Number(j.score) < min) { hiddenLow++; continue; }
    const g = groups.find(x => x.key === j.status);
    if (g) g.items.push(j);
  }
  const byScore = (a, b) => Number(jobsInValley(b.location)) - Number(jobsInValley(a.location)) ||
    (Number(b.score) || 0) - (Number(a.score) || 0) || String(b.created_at).localeCompare(String(a.created_at));
  const byTime = (a, b) => String(b.status_changed_at || b.created_at).localeCompare(String(a.status_changed_at || a.created_at));
  for (const g of groups) g.items.sort(g.key === 'new' ? byScore : byTime);
  closed.sort(byTime);
  return { groups, closed, hiddenLow, cutoff: min };
}

// The buttons on a job card: where it can go next.
function jobsNextActions(status) {
  const next = {
    new: [['interested', 'Interested'], ['applied', 'Applied'], ['not_interested', 'Not interested']],
    interested: [['applied', 'Applied'], ['not_interested', 'Not interested']],
    applied: [['interviewing', 'Interviewing'], ['rejected', 'Rejected']],
    interviewing: [['offer', 'Offer'], ['rejected', 'Rejected']],
    offer: [],
    rejected: [['applied', 'Reopen']],
    archived: [['new', 'Restore']],
    not_interested: [['new', 'Restore']],
  }[status] || [];
  const out = next.map(([to, label]) => ({ to, label }));
  if (status !== 'archived' && status !== 'not_interested') out.push({ to: 'archived', label: 'Archive' });
  return out;
}

// The Phoenix Valley (#72), same list as the server's jobs.ts.
const JOBS_VALLEY = ['phoenix', 'scottsdale', 'tempe', 'mesa', 'chandler', 'gilbert', 'glendale', 'peoria', 'surprise', 'goodyear',
  'avondale', 'buckeye', 'queen creek', 'paradise valley', 'fountain hills', 'litchfield park', 'tolleson', 'el mirage', 'cave creek',
  'sun city', 'laveen', 'ahwatukee', 'apache junction', 'san tan valley'];
function jobsInValley(location) {
  const l = String(location || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !!l && JOBS_VALLEY.some(c => l === c || l.startsWith(c + ' ') || l.includes(' ' + c + ' ') || l.endsWith(' ' + c));
}

// Going through the list (#74): which jobs a filter shows.
const JOBS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'valley', label: 'Phoenix Valley' },
  { key: 'remote', label: 'Remote' },
  { key: 'applied', label: 'Applied' },
  { key: 'not_interested', label: 'Not interested' },
];
function jobsFilter(jobs, filter) {
  const f = filter || 'all';
  return (jobs || []).filter(j => {
    if (f === 'valley') return jobsInValley(j.location) && j.status !== 'not_interested';
    if (f === 'remote') return /remote|anywhere|work from home/i.test(j.location || '') && j.status !== 'not_interested';
    if (f === 'applied') return ['applied', 'interviewing', 'offer'].includes(j.status);
    if (f === 'not_interested') return j.status === 'not_interested';
    return true;
  });
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
  module.exports = { jobsBuildPipeline, jobsNextActions, jobsCostByFeature, jobsInValley, jobsFilter, JOBS_STAGES, JOBS_FILTERS };
}

// ---------- The page ----------

if (typeof document !== 'undefined') {
  const J = { busy: false, filter: 'all', open: null, posting: {}, jobs: [], cutoff: 7, props: [] };
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  const COLS = 'id,title,company,location,score,status,source,url,apply_url,notes,created_at,status_changed_at,applied_at,posted_at,email_ref';

  function jobsNote(html, kind) {
    el('jobsNotes').insertAdjacentHTML('beforeend', `<div class="msg ${kind || 'err'}">${html}</div>`);
  }

  // A job card; tapping the title opens the full posting (#74).
  function jobCard(j) {
    const score = j.score !== null && j.score !== undefined ? `<span class="pl-chip">${esc(Number(j.score))}/10</span>` : '';
    const src = j.source ? `<span class="pl-chip brain">${esc(j.source)}</span>` : '';
    const valley = jobsInValley(j.location) ? '<span class="pl-chip">Phoenix Valley</span>' : '';
    const where = [j.company, j.location].filter(Boolean).map(esc).join(' · ');
    const when = j.status === 'applied' && j.applied_at ? `applied ${day(j.applied_at)}`
      : j.posted_at ? `posted ${day(j.posted_at)}` : day(j.status_changed_at || j.created_at);
    const btns = jobsNextActions(j.status).map(a =>
      `<button class="${['archived', 'rejected', 'not_interested'].includes(a.to) ? 'secondary' : ''}" data-job="${j.id}:${a.to}">${esc(a.label)}</button>`).join('');
    const open = J.open === j.id;
    let detail = '';
    if (open) {
      const p = J.posting[j.id];
      const text = p === undefined ? 'Loading the posting…'
        : p ? p
        : j.email_ref ? 'This job came from a job-alert email; the full posting is on the site (link below).' : 'No posting text was saved for this job.';
      const links = [
        j.apply_url ? `<a class="link" href="${esc(j.apply_url)}" target="_blank" rel="noopener">Apply / see it on the site</a>` : '',
        j.email_ref && j.url ? `<a class="link" href="${esc(j.url)}" target="_blank" rel="noopener">Open the email</a>` : '',
      ].filter(Boolean).join(' · ');
      detail = `<div class="pl-post">${esc(text)}</div>${links ? `<div class="pl-when" style="margin-top:8px;">${links}</div>` : ''}`;
    }
    return `<div class="pl-item ${open ? 'open' : ''}" id="job-${j.id}"><div class="pl-body">
      <div class="pl-title" data-job-open="${j.id}" style="cursor:pointer;">${esc(j.title || '(no title)')}</div>
      <div class="pl-when">${where} ${score}${valley}${src}</div>
      <div class="pl-when">${esc(when)}${j.notes ? ' · ' + esc(j.notes) : ''}</div>
      ${detail}
      <div class="pl-actions">${btns}</div></div></div>`;
  }

  function jobsRender() {
    let html = '';
    if (J.props.length) {
      html += '<div class="pl-day">Interviews waiting for your OK</div>' + J.props.map(p => `<div class="pl-item"><div class="pl-body">
        <div class="pl-title">${esc(p.summary)}</div>
        <div class="pl-actions"><button data-job-decide="${p.id}:approved">Approve</button>
        <button class="secondary" data-job-decide="${p.id}:not_now">Not now</button></div></div></div>`).join('');
    }
    html += '<div class="pl-filter">' + JOBS_FILTERS.map(f => `<button class="${J.filter === f.key ? '' : 'secondary'}" data-job-filter="${f.key}">${esc(f.label)}</button>`).join('') + '</div>';
    const shown = jobsFilter(J.jobs, J.filter);
    if (J.filter === 'all') {
      const v = jobsBuildPipeline(shown, J.cutoff);
      for (const g of v.groups) {
        html += `<div class="pl-day">${esc(g.label)}${g.key === 'new' ? ` <span style="text-transform:none; font-weight:400;">(score ${v.cutoff}+, Phoenix Valley first)</span>` : ''}</div>`;
        html += g.items.length ? g.items.map(jobCard).join('') : '<div class="pl-empty">None yet.</div>';
      }
      if (v.hiddenLow) html += `<div class="pl-empty">${v.hiddenLow} lower-scoring ${v.hiddenLow === 1 ? 'opening is' : 'openings are'} hidden (cutoff ${v.cutoff}, setting job_score_cutoff).</div>`;
      if (v.closed.length) {
        html += `<details class="card"><summary style="cursor:pointer; font-size:13px; color:#999;">Closed and not interested (${v.closed.length})</summary>${v.closed.map(jobCard).join('')}</details>`;
      }
    } else {
      const v = jobsBuildPipeline(shown, J.filter === 'not_interested' ? 0 : J.cutoff);
      const list = [...v.groups.flatMap(g => g.items), ...(J.filter === 'not_interested' ? v.closed : [])];
      html += list.length ? list.map(jobCard).join('') : '<div class="pl-empty">No jobs here.</div>';
    }
    el('jobsList').innerHTML = html;
  }

  async function jobsOpen(id, scroll) {
    J.open = J.open === id && !scroll ? null : id;
    jobsRender();
    if (J.open && J.posting[id] === undefined) {
      const { data } = await sb.from('bc_jobs').select('description').eq('id', id).single();
      J.posting[id] = data && data.description ? data.description : null;
      jobsRender();
    }
    if (scroll && el(`job-${id}`)) el(`job-${id}`).scrollIntoView({ block: 'start' });
  }

  async function jobsLoad() {
    if (J.busy) return;
    J.busy = true;
    el('jobsNotes').innerHTML = '';
    try {
      const [jobsR, setR, propR, costR] = await Promise.all([
        sb.from('bc_jobs').select(COLS).order('created_at', { ascending: false }).limit(500),
        sb.from('bc_settings').select('key,value').in('key', ['job_score_cutoff', 'enabled.job_search']),
        sb.from('bc_proposals').select('id,summary').eq('status', 'pending').eq('kind', 'interview').order('created_at'),
        sb.from('bc_costs').select('feature,amount_usd,created_at').gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
      ]);
      if (jobsR.error) throw new Error('Job tables are not set up yet. Run brain-calendar/sql/004_jobs_email.sql and 005_push_reminders_jobs.sql in the Supabase SQL Editor.');
      const s = Object.fromEntries((setR.data || []).map(x => [x.key, x.value]));
      if (s['enabled.job_search'] === false) jobsNote('The job search is paused (setting enabled.job_search).', 'ok');
      J.jobs = jobsR.data || [];
      J.cutoff = s.job_score_cutoff ?? 7;
      J.props = propR.data || [];
      // A job notification (#jobs/<id>) opens that job (#74).
      const want = window.obJobOpen;
      window.obJobOpen = null;
      if (want && J.jobs.some(j => j.id === want)) { J.filter = 'all'; J.open = null; }
      jobsRender();
      if (want && J.jobs.some(j => j.id === want)) jobsOpen(want, true);

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
    // Applied / Not interested: a job marked like this is never alerted again (#74).
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
    if (d.jobOpen) jobsOpen(d.jobOpen);
    if (d.jobFilter) { J.filter = d.jobFilter; jobsRender(); }
  });

  window.loadJobs = jobsLoad;
}
