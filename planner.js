// Brain Calendar: the "Today / This week" page (Brain Calendar #25, #41, #13, #17, #9).
// Tasks live in Brain Calendar's own tables (bc_tasks, bc_goals ...).
// Google Calendar events come from the bc-calendar cloud function.
// This file never reads or writes Open Brain thoughts.

// ---------- Pure helpers (no page needed; tested in brain-calendar/tests) ----------

function plannerDayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function plannerStartOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Today = today only. Week = today plus the next 6 days.
function plannerRange(view, now) {
  const from = plannerStartOfDay(now);
  const to = new Date(from);
  to.setDate(to.getDate() + (view === 'week' ? 7 : 1));
  return { from, to };
}

function plannerFmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function plannerDayLabel(key, now) {
  const today = plannerDayKey(now);
  const t = new Date(now); t.setDate(t.getDate() + 1);
  if (key === today) return 'Today';
  if (key === plannerDayKey(t)) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// Turn tasks + calendar events into what the page shows:
//   overdue: scheduled before today and not checked off (they never disappear, #13)
//   days:    timeline per day, sorted by time (#41)
//   tray:    "Not scheduled yet" (#41)
function plannerBuildView(tasks, events, view, now) {
  const { from, to } = plannerRange(view, now);
  const todayKey = plannerDayKey(now);
  const days = new Map();
  for (let d = new Date(from); d < to; d.setDate(d.getDate() + 1)) days.set(plannerDayKey(d), []);

  const overdue = [], tray = [];
  const taskIds = new Set(tasks.map(t => t.id));
  const doneToday = t => t.status === 'done' && t.done_at && plannerDayKey(t.done_at) === todayKey;

  for (const t of tasks) {
    const item = {
      kind: 'task', id: t.id, title: t.title, done: t.status === 'done',
      start: t.scheduled_start, end: t.scheduled_end, due: t.due_at,
      goal: t.goal ? t.goal.name : null, allDay: false,
    };
    if (!t.scheduled_start) {
      if (t.status === 'open' || doneToday(t)) tray.push(item);
      continue;
    }
    const start = new Date(t.scheduled_start);
    if (start < from) {
      if (t.status === 'open') overdue.push(item);
      continue;
    }
    if (start >= to) continue;
    days.get(plannerDayKey(start))?.push(item);
  }

  for (const e of events) {
    if (e.taskId && taskIds.has(e.taskId)) continue; // already shown as a task with a checkbox
    const item = { kind: 'event', id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendar: e.calendar };
    if (e.allDay) {
      // all-day events run from start date up to (not including) end date
      for (let d = new Date(e.start + 'T00:00:00'); plannerDayKey(d) < e.end; d.setDate(d.getDate() + 1)) {
        days.get(plannerDayKey(d))?.push({ ...item });
      }
    } else {
      days.get(plannerDayKey(e.start))?.push(item);
    }
  }

  const byTime = (a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1);
  overdue.sort(byTime);
  tray.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0));
  return {
    overdue,
    tray,
    days: [...days.entries()].map(([key, items]) => ({ key, label: plannerDayLabel(key, now), items: items.sort(byTime) })),
  };
}

// Date + optional time from the add form -> what to store.
// With a time: a block on the timeline. Date only: a due date, stays in the tray.
function plannerFormToTask(title, goalId, date, time, blockMinutes) {
  const row = { title: title.trim(), goal_id: goalId || null, source: 'app' };
  if (date && time) {
    const start = new Date(`${date}T${time}`);
    row.scheduled_start = start.toISOString();
    row.scheduled_end = new Date(start.getTime() + (blockMinutes || 60) * 60000).toISOString();
  } else if (date) {
    row.due_at = new Date(`${date}T23:59`).toISOString();
  }
  return row;
}

if (typeof module !== 'undefined') {
  module.exports = { plannerBuildView, plannerRange, plannerDayKey, plannerFormToTask };
}

// ---------- The page ----------

if (typeof document !== 'undefined') {
  const P = { view: 'today', goals: [], settings: {}, ready: false, busy: false };
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function plannerNote(html, kind) {
    el('plannerNotes').insertAdjacentHTML('beforeend', `<div class="msg ${kind || 'err'}">${html}</div>`);
  }

  async function plannerSetup() {
    const { error } = await sb.rpc('bc_seed_defaults', { p_app_url: location.origin.startsWith('https://') ? location.origin + location.pathname.replace(/index\.html$/, '') : null });
    if (error) throw new Error('Brain Calendar tables are not set up yet. Run brain-calendar/sql/001_foundation.sql in the Supabase SQL Editor.');
    const [{ data: goals }, { data: settings }] = await Promise.all([
      sb.from('bc_goals').select('id,name').eq('active', true).order('sort_order'),
      sb.from('bc_settings').select('key,value'),
    ]);
    P.goals = goals || [];
    P.settings = Object.fromEntries((settings || []).map(s => [s.key, s.value]));
    el('plannerGoal').innerHTML = '<option value="">No goal</option>' +
      P.goals.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    P.ready = true;
  }

  async function plannerLoad() {
    if (P.busy) return;
    P.busy = true;
    el('plannerNotes').innerHTML = '';
    try {
      if (!P.ready) await plannerSetup();
      const now = new Date();
      const { from, to } = plannerRange(P.view, now);

      const tasksQ = sb.from('bc_tasks').select('*, goal:bc_goals(name)')
        .or(`status.eq.open,done_at.gte."${plannerStartOfDay(now).toISOString()}",and(scheduled_start.gte."${from.toISOString()}",scheduled_start.lt."${to.toISOString()}")`)
        .order('created_at');
      const eventsQ = sb.functions.invoke('bc-calendar', { body: { action: 'events', from: from.toISOString(), to: to.toISOString() } })
        .catch(err => ({ error: err }));
      const costQ = sb.rpc('bc_cost_status');

      const [{ data: tasks, error: tErr }, ev, cost] = await Promise.all([tasksQ, eventsQ, costQ]);
      if (tErr) throw tErr;

      let events = [];
      if (ev.error) plannerNote('Could not reach Google Calendar right now. Showing tasks only.');
      else if (ev.data?.error === 'google_auth_expired') plannerNote(esc(ev.data.message));
      else if (ev.data?.paused) plannerNote('Calendar is paused (setting enabled.calendar).', 'ok');
      else if (ev.data && !ev.data.connected) plannerNote('Google Calendar is not connected yet. Showing tasks only.', 'ok');
      else events = ev.data?.events || [];

      const c = cost.data && cost.data[0];
      if (c && c.over_budget) {
        plannerNote(`Heads up: projected cost this month is $${Number(c.projected_month).toFixed(2)}, above your $${Number(c.budget).toFixed(2)} budget.`);
      }

      plannerRender(plannerBuildView(tasks || [], events, P.view, now));

      // Tasks with a time that aren't on the Brain calendar yet (e.g. added before Google was connected).
      if (ev.data?.connected && !ev.data.paused) {
        const pending = (tasks || []).filter(t => t.status === 'open' && t.scheduled_start && !t.google_event_id && new Date(t.scheduled_end) > now);
        for (const t of pending) await sb.functions.invoke('bc-calendar', { body: { action: 'schedule-task', task_id: t.id } });
      }
    } catch (err) {
      el('plannerTimeline').innerHTML = '';
      el('plannerTray').innerHTML = '';
      plannerNote(esc(err.message || 'Could not load your plan.'));
    } finally {
      P.busy = false;
    }
  }

  function plannerItemHtml(i, showDate) {
    const when = i.allDay ? 'All day'
      : i.start ? `${showDate ? new Date(i.start).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : ''}${plannerFmtTime(i.start)}${i.end ? '–' + plannerFmtTime(i.end) : ''}`
      : i.due ? `due ${new Date(i.due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
    const goal = i.goal ? `<span class="pl-chip">${esc(i.goal)}</span>` : '';
    const cal = i.kind === 'event' ? `<span class="pl-chip ${i.calendar === 'brain' ? 'brain' : ''}">${i.calendar === 'brain' ? 'Brain' : 'Calendar'}</span>` : '';
    const box = i.kind === 'task'
      ? `<input type="checkbox" class="pl-check" data-id="${i.id}" ${i.done ? 'checked' : ''} aria-label="Done">`
      : '<span class="pl-dot"></span>';
    return `<div class="pl-item ${i.done ? 'done' : ''}">${box}
      <div class="pl-body"><div class="pl-title">${esc(i.title)}</div>
      <div class="pl-when">${esc(when)} ${goal}${cal}</div></div></div>`;
  }

  function plannerRender(v) {
    let html = '';
    if (v.overdue.length) {
      html += `<div class="pl-day">Earlier, not checked off</div>` + v.overdue.map(i => plannerItemHtml(i, true)).join('');
    }
    for (const d of v.days) {
      html += `<div class="pl-day">${esc(d.label)}</div>`;
      html += d.items.length ? d.items.map(i => plannerItemHtml(i)).join('') : '<div class="pl-empty">Nothing scheduled.</div>';
    }
    el('plannerTimeline').innerHTML = html;
    el('plannerTray').innerHTML = v.tray.length ? v.tray.map(i => plannerItemHtml(i)).join('') : '<div class="pl-empty">All caught up.</div>';
  }

  async function plannerToggle(id, done) {
    const { error } = await sb.from('bc_tasks')
      .update({ status: done ? 'done' : 'open', done_at: done ? new Date().toISOString() : null })
      .eq('id', id);
    if (error) plannerNote(esc(error.message));
    plannerLoad();
  }

  async function plannerAdd() {
    const title = el('plannerTitle').value;
    if (!title.trim()) return;
    const row = plannerFormToTask(title, el('plannerGoal').value, el('plannerDate').value, el('plannerTime').value,
      Number(P.settings.default_block_minutes) || 60);
    const { data, error } = await sb.from('bc_tasks').insert({ ...row, user_id: currentUser.id }).select().single();
    if (error) { plannerNote(esc(error.message)); return; }
    el('plannerTitle').value = ''; el('plannerTime').value = ''; el('plannerDate').value = '';
    if (data.scheduled_start) {
      // Brandan typed the time himself, so this is his "yes" (#43). Put it on the Brain calendar (#23).
      await sb.functions.invoke('bc-calendar', { body: { action: 'schedule-task', task_id: data.id } }).catch(() => {});
    }
    plannerLoad();
  }

  document.addEventListener('change', e => {
    if (e.target.classList && e.target.classList.contains('pl-check')) plannerToggle(e.target.dataset.id, e.target.checked);
  });
  document.addEventListener('click', e => {
    if (e.target.id === 'plannerAddBtn') plannerAdd();
    if (e.target.dataset && e.target.dataset.view) {
      P.view = e.target.dataset.view;
      document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('secondary', b.dataset.view !== P.view));
      plannerLoad();
    }
  });
  document.addEventListener('keydown', e => { if (e.target.id === 'plannerTitle' && e.key === 'Enter') plannerAdd(); });

  window.loadPlanner = plannerLoad;
}
