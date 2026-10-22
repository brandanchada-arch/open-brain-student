// Brain Calendar: the "Today / This week" page (Brain Calendar #25, #41, #13, #17, #9).
// Tasks live in Brain Calendar's own tables (bc_tasks, bc_goals ...).
// Google Calendar events come from the bc-calendar cloud function.
// Milestone 2: plans waiting for your OK (#33), check-ins (#49), goals (#60),
// Milestone 4: notifications on this device (#63), quick add in plain words (#69),
// "Different time" and the Sunday skipped list answered here instead of Telegram (#64).
// and choosing how long a new item lasts (#59).
// "Schedule" puts an item from "Not scheduled yet" on the calendar without retyping it.
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
      source: t.source || 'app', info: t.item_type === 'info', notes: t.notes || null,
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
    row.item_type = 'due';
  }
  return row;
}

// "Schedule" on an unscheduled item: day + time + length -> the block's times, or an error to show.
function plannerScheduleTimes(date, time, minutes, now) {
  if (!date || !time) return { error: 'Pick a day and a time.' };
  const start = new Date(`${date}T${time}`);
  if (isNaN(start)) return { error: 'Pick a day and a time.' };
  if (start.getTime() < new Date(now).getTime() - 5 * 60000) return { error: 'That time has already passed.' };
  const end = new Date(start.getTime() + (Number(minutes) > 0 ? Number(minutes) : 60) * 60000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Length choices for a new timed item (#59). The default (a setting) is always one of them.
function plannerDurationOptions(defaultMinutes) {
  const d = Number(defaultMinutes) > 0 ? Number(defaultMinutes) : 60;
  const list = [15, 30, 45, 60, 90, 120, 180, 240];
  if (!list.includes(d)) list.push(d);
  const label = m => (m < 60 || m % 30 ? `${m} min` : m === 60 ? '1 hour' : `${m / 60} hours`);
  return list.sort((a, b) => a - b).map(m => ({ value: m, label: label(m), selected: m === d }));
}

// Goal names typed in the app (#60): trimmed, not empty, no duplicates (any case).
function plannerCleanGoalName(name, existing, exceptId) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) return { error: 'Type a name for the goal.' };
  const clash = (existing || []).find(g => g.id !== exceptId && g.name.toLowerCase() === n.toLowerCase());
  if (clash) return { error: `You already have a goal called "${clash.name}".` };
  return { name: n };
}

// Notifications (Brain Calendar #63): what to show, given what this device can do.
// iPhone only allows web push from the Home Screen app, so say so in Safari.
function plannerPushStatus(o) {
  if (o.ios && !o.standalone) {
    return { text: 'On iPhone, notifications only work from the Home Screen app: tap Share, then "Add to Home Screen", open the app from there and turn them on.', canTurnOn: false, canTest: false };
  }
  if (!o.supported) return { text: 'This browser can\'t show notifications from the app.', canTurnOn: false, canTest: false };
  if (o.permission === 'denied') return { text: 'Notifications are blocked for this app. Allow them in your phone or browser settings, then come back.', canTurnOn: false, canTest: false };
  if (o.subscribed) return { text: 'Notifications are on for this device.', canTurnOn: false, canTest: true };
  return { text: 'Turn on notifications to get reminders before events, the 7:00 AM summary and urgent alerts.', canTurnOn: true, canTest: false };
}

// The server's public key (base64url) as bytes, for pushManager.subscribe().
function plannerB64ToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// What quick add understood (#69), in plain words.
function plannerQuickSummary(t) {
  if (!t) return '';
  if (t.scheduled_start) {
    const day = new Date(t.scheduled_start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const mins = Math.round((new Date(t.scheduled_end) - new Date(t.scheduled_start)) / 60000);
    return `Added "${t.title}": ${day}, ${plannerFmtTime(t.scheduled_start)}–${plannerFmtTime(t.scheduled_end)} (${mins} min), on your Brain calendar.`;
  }
  if (t.due_at) return `Added "${t.title}", due ${new Date(t.due_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}. It's under "Not scheduled yet".`;
  return `Added "${t.title}" under "Not scheduled yet".`;
}

// The Sunday "skipped this week" list (#22), numbered as in the readout. Hidden after 7 days.
function plannerSkippedRows(list, emails, now) {
  if (!list || !Array.isArray(list.ids) || !list.sent_at) return [];
  if (new Date(now) - new Date(list.sent_at) > 7 * 86400000) return [];
  const byId = new Map((emails || []).map(e => [e.id, e]));
  return list.ids.map((id, i) => ({ n: i + 1, email: byId.get(id) })).filter(r => r.email)
    .map(r => ({ n: r.n, from: r.email.from_name || r.email.from_email, subject: r.email.subject || '', learned: r.email.feedback === 'should_ping' }));
}

if (typeof module !== 'undefined') {
  module.exports = {
    plannerBuildView, plannerRange, plannerDayKey, plannerFormToTask, plannerScheduleTimes, plannerDurationOptions, plannerCleanGoalName,
    plannerPushStatus, plannerB64ToBytes, plannerQuickSummary, plannerSkippedRows,
  };
}

// ---------- The page ----------

if (typeof document !== 'undefined') {
  const P = { view: 'today', goals: [], allGoals: [], settings: {}, ready: false, busy: false, noteFor: null, tray: [], schedFor: null, other: null, props: [], checks: [], pushChecked: false };
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = body => sb.functions.invoke('bc-calendar', { body });

  function plannerNote(html, kind) {
    el('plannerNotes').insertAdjacentHTML('beforeend', `<div class="msg ${kind || 'err'}">${html}</div>`);
  }

  async function plannerLoadGoals() {
    const { data } = await sb.from('bc_goals').select('id,name,active,sort_order').order('sort_order');
    P.allGoals = data || [];
    P.goals = P.allGoals.filter(g => g.active);
    const keep = el('plannerGoal').value;
    el('plannerGoal').innerHTML = '<option value="">No goal</option>' +
      P.goals.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    el('plannerGoal').value = P.goals.some(g => g.id === keep) ? keep : '';
    plannerRenderGoals();
  }

  async function plannerSetup() {
    const { error } = await sb.rpc('bc_seed_defaults', { p_app_url: location.origin.startsWith('https://') ? location.origin + location.pathname.replace(/index\.html$/, '') : null });
    if (error) throw new Error('Brain Calendar tables are not set up yet. Run brain-calendar/sql/001_foundation.sql and 002_calendar_halo.sql in the Supabase SQL Editor.');
    const { data: settings } = await sb.from('bc_settings').select('key,value');
    P.settings = Object.fromEntries((settings || []).map(s => [s.key, s.value]));
    el('plannerMinutes').innerHTML = plannerDurationOptions(P.settings.default_block_minutes)
      .map(o => `<option value="${o.value}" ${o.selected ? 'selected' : ''}>${o.label}</option>`).join('');
    await plannerLoadGoals();
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
      const eventsQ = api({ action: 'events', from: from.toISOString(), to: to.toISOString() }).catch(err => ({ error: err }));
      const costQ = sb.rpc('bc_cost_status');
      const proposalsQ = sb.from('bc_proposals').select('id,kind,summary,created_at').eq('status', 'pending').in('kind', ['schedule', 'replan', 'interview']).order('created_at');
      const checkinsQ = sb.from('bc_checkins').select('id,title,block_start,block_end').is('answer', null).order('block_end', { ascending: false }).limit(10);

      const [{ data: tasks, error: tErr }, ev, cost, props, checks] = await Promise.all([tasksQ, eventsQ, costQ, proposalsQ, checkinsQ]);
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

      P.props = props.data || [];
      P.checks = checks.data || [];
      plannerRenderWaiting(P.props, P.checks);
      plannerLoadSkipped();
      if (!P.pushChecked) { P.pushChecked = true; plannerRenderPush(true); }
      plannerRender(plannerBuildView(tasks || [], events, P.view, now));

      // Tasks with a time that aren't on the Brain calendar yet (e.g. added before Google was connected).
      if (ev.data?.connected && !ev.data.paused) {
        const pending = (tasks || []).filter(t => t.status === 'open' && t.scheduled_start && !t.google_event_id && new Date(t.scheduled_end) > now);
        for (const t of pending) await api({ action: 'schedule-task', task_id: t.id });
      }
    } catch (err) {
      el('plannerTimeline').innerHTML = '';
      el('plannerTray').innerHTML = '';
      plannerNote(esc(err.message || 'Could not load your plan.'));
    } finally {
      P.busy = false;
    }
  }

  // Plans waiting for a yes (#33) and check-ins waiting for an answer (#49).
  function plannerRenderWaiting(props, checks) {
    let html = '';
    if (P.noteFor) {
      const q = P.noteFor.answer === 'done' ? 'Anything worth noting? (optional)' : 'What happened? (optional)';
      html += `<div class="pl-item"><div class="pl-body"><div class="pl-title">${esc(P.noteFor.title)}: ${q}</div>
        <div class="row" style="margin-top:6px;"><input type="text" id="plannerNoteText" placeholder="A few words, or skip">
        <button id="plannerNoteSave" style="flex:0 0 auto;">Save</button>
        <button id="plannerNoteSkip" class="secondary" style="flex:0 0 auto;">Skip</button></div></div></div>`;
    }
    if (props.length) {
      html += '<div class="pl-day">Waiting for your OK</div>' + props.map(p => `<div class="pl-item"><div class="pl-body">
        <div class="pl-title">${esc(p.summary)}</div>
        <div class="pl-actions"><button data-decide="${p.id}:approved">${p.kind === 'replan' ? 'Approve all' : 'Approve'}</button>
        ${p.kind === 'schedule' ? `<button class="secondary" data-other="${p.id}">Different time</button>` : ''}
        <button class="secondary" data-decide="${p.id}:not_now">Not now</button></div>${plannerOtherHtml(p)}</div></div>`).join('');
    }
    if (checks.length) {
      html += '<div class="pl-day">How did it go? <span style="text-transform:none; font-weight:400;">No rush</span></div>' + checks.map(c => `<div class="pl-item"><div class="pl-body">
        <div class="pl-title">${esc(c.title)}</div>
        <div class="pl-when">${c.block_start ? esc(new Date(c.block_start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + plannerFmtTime(c.block_start) + '–' + plannerFmtTime(c.block_end)) : ''} · waiting</div>
        <div class="pl-actions"><button data-checkin="${c.id}:done" data-title="${esc(c.title)}">Yes, I did it</button>
        <button class="secondary" data-checkin="${c.id}:not_done" data-title="${esc(c.title)}">I didn't do it</button></div></div></div>`).join('');
    }
    el('plannerWaiting').innerHTML = html;
  }

  function plannerItemHtml(i, showDate, inTray) {
    const when = i.allDay ? 'All day'
      : i.start ? `${showDate ? new Date(i.start).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : ''}${plannerFmtTime(i.start)}${i.end ? '–' + plannerFmtTime(i.end) : ''}`
      : i.due ? `due ${new Date(i.due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
    const goal = i.goal ? `<span class="pl-chip">${esc(i.goal)}</span>` : '';
    const src = i.source === 'halo' ? '<span class="pl-chip">Halo</span>' : '';
    const cal = i.kind === 'event' ? `<span class="pl-chip ${i.calendar === 'brain' ? 'brain' : ''}">${i.calendar === 'brain' ? 'Brain' : 'Calendar'}</span>` : '';
    const box = i.kind === 'task'
      ? `<input type="checkbox" class="pl-check" data-id="${i.id}" ${i.done ? 'checked' : ''} aria-label="Done">`
      : '<span class="pl-dot"></span>';
    const notes = i.info && i.notes ? `<div class="pl-when">${esc(i.notes.slice(0, 160))}${i.notes.length > 160 ? '…' : ''}</div>` : '';
    const sched = inTray && i.kind === 'task' && !i.done ? plannerScheduleHtml(i) : '';
    return `<div class="pl-item ${i.done ? 'done' : ''}">${box}
      <div class="pl-body"><div class="pl-title">${esc(i.title)}</div>
      <div class="pl-when">${esc(when)} ${goal}${src}${cal}</div>${notes}${sched}</div></div>`;
  }

  // The "Schedule" button, or (once tapped) day / time / length to put it on the calendar.
  function plannerScheduleHtml(i) {
    if (P.schedFor !== i.id) {
      return `<div class="pl-actions"><button class="secondary" data-schedule="${i.id}">Schedule</button></div>`;
    }
    const lengths = plannerDurationOptions(P.settings.default_block_minutes)
      .map(o => `<option value="${o.value}" ${o.selected ? 'selected' : ''}>${o.label}</option>`).join('');
    return `<div class="row" style="margin-top:8px;">
        <input type="date" id="plannerSchedDate" value="${plannerDayKey(new Date())}" aria-label="Day">
        <input type="time" id="plannerSchedTime" aria-label="Time">
        <select id="plannerSchedMinutes" aria-label="How long">${lengths}</select></div>
      <div id="plannerSchedMsg"></div>
      <div class="pl-actions"><button data-sched-save="${i.id}">Put on calendar</button>
        <button class="secondary" data-sched-cancel="1">Cancel</button></div>`;
  }

  function plannerRenderTray() {
    el('plannerTray').innerHTML = P.tray.length ? P.tray.map(i => plannerItemHtml(i, false, true)).join('') : '<div class="pl-empty">All caught up.</div>';
  }

  async function plannerSchedule(id) {
    const t = plannerScheduleTimes(el('plannerSchedDate').value, el('plannerSchedTime').value, el('plannerSchedMinutes').value, new Date());
    if (t.error) { el('plannerSchedMsg').innerHTML = `<div class="msg err">${esc(t.error)}</div>`; return; }
    // Through the server, so a suggestion still waiting for this item is closed too.
    const { data, error } = await api({ action: 'set-time', task_id: id, start: t.start, end: t.end });
    if (error || !data?.ok) {
      el('plannerSchedMsg').innerHTML = `<div class="msg err">${data?.error === 'time_passed' ? 'That time has already passed.' : 'Could not save that. Try again.'}</div>`;
      return;
    }
    P.schedFor = null;
    plannerLoad();
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
    P.tray = v.tray;
    if (!P.tray.some(i => i.id === P.schedFor && !i.done)) P.schedFor = null;
    plannerRenderTray();
  }

  // Goals: add, rename, show/hide (#17, #60). Hidden goals stay on old items.
  function plannerRenderGoals() {
    el('plannerGoalList').innerHTML = P.allGoals.map(g => `<div class="row" style="margin-top:6px; align-items:center;">
      <input type="text" value="${esc(g.name)}" data-goal-name="${g.id}" aria-label="Goal name">
      <label style="flex:0 0 auto; margin:0; display:flex; gap:4px; align-items:center;"><input type="checkbox" data-goal-active="${g.id}" ${g.active ? 'checked' : ''} style="width:auto;"> show</label>
      <button class="secondary" data-goal-save="${g.id}" style="flex:0 0 auto;">Save</button></div>`).join('');
  }

  async function plannerSaveGoal(id) {
    const name = document.querySelector(`[data-goal-name="${id}"]`).value;
    const active = document.querySelector(`[data-goal-active="${id}"]`).checked;
    const clean = plannerCleanGoalName(name, P.allGoals, id);
    if (clean.error) { el('plannerGoalMsg').innerHTML = `<div class="msg err">${esc(clean.error)}</div>`; return; }
    const { error } = await sb.from('bc_goals').update({ name: clean.name, active }).eq('id', id);
    el('plannerGoalMsg').innerHTML = error ? `<div class="msg err">${esc(error.message)}</div>` : '<div class="msg ok">Saved.</div>';
    await plannerLoadGoals();
  }

  async function plannerAddGoal() {
    const clean = plannerCleanGoalName(el('plannerNewGoal').value, P.allGoals);
    if (clean.error) { el('plannerGoalMsg').innerHTML = `<div class="msg err">${esc(clean.error)}</div>`; return; }
    const order = Math.max(0, ...P.allGoals.map(g => g.sort_order || 0)) + 1;
    const { error } = await sb.from('bc_goals').insert({ name: clean.name, sort_order: order, user_id: currentUser.id });
    el('plannerGoalMsg').innerHTML = error ? `<div class="msg err">${esc(error.message)}</div>` : '<div class="msg ok">Goal added.</div>';
    if (!error) el('plannerNewGoal').value = '';
    await plannerLoadGoals();
  }

  async function plannerToggle(id, done) {
    // Through the server, so finishing early also frees the rest of the block (#39).
    const { data, error } = await api({ action: 'set-done', task_id: id, done });
    if (error || !data?.ok) plannerNote('Could not save that. Try again.');
    plannerLoad();
  }

  async function plannerDecide(id, decision) {
    const { data, error } = await api({ action: 'decide', proposal_id: id, decision });
    if (error || !data?.ok) plannerNote('Could not save that. Try again.');
    else if (data.result === 'stale') plannerNote(esc(data.text), 'ok');
    plannerLoad();
  }

  async function plannerCheckin(id, answer, title) {
    const { data, error } = await api({ action: 'checkin', checkin_id: id, answer });
    if (error || !data?.ok) { plannerNote('Could not save that. Try again.'); return; }
    P.noteFor = { id, answer, title };
    plannerLoad();
  }

  async function plannerSaveNote() {
    const note = el('plannerNoteText').value.trim();
    const f = P.noteFor;
    P.noteFor = null;
    if (note && f) await api({ action: 'checkin-note', checkin_id: f.id, note });
    plannerLoad();
  }

  // ---- "Different time" on a suggestion (was a Telegram button, Brain Calendar #64) ----
  function plannerOtherHtml(p) {
    const o = P.other;
    if (!o || o.id !== p.id) return '';
    if (o.loading) return '<div class="pl-when" style="margin-top:8px;">Finding open times…</div>';
    const opts = (o.options || []).map((s, i) => `<button class="secondary" data-other-pick="${p.id}:${i}">${esc(new Date(s.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + plannerFmtTime(s.start) + '–' + plannerFmtTime(s.end))}</button>`).join('');
    return `<div style="margin-top:10px;">
      <div class="pl-when">${o.options && o.options.length ? 'Other open times:' : 'No other open times found.'}${o.calendarRead === false ? ' (Couldn\'t read your calendar just now, so check these against your classes.)' : ''}</div>
      <div class="pl-actions">${opts}</div>
      <div class="row" style="margin-top:8px;"><input type="text" id="plannerOtherText" placeholder='Or type one, like "Thu 7pm"'>
        <button data-other-type="${p.id}" style="flex:0 0 auto;">Use it</button></div>
      ${o.msg ? `<div class="msg err">${esc(o.msg)}</div>` : ''}</div>`;
  }

  async function plannerOtherTimes(id) {
    P.other = { id, loading: true };
    plannerRenderWaiting(P.props, P.checks);
    const { data } = await api({ action: 'other-times', proposal_id: id });
    if (!data?.ok) { P.other = null; plannerNote(data?.error === 'already' ? 'That suggestion was already decided.' : 'Could not look up other times. Try again.'); plannerLoad(); return; }
    P.other = { id, options: data.options, calendarRead: data.calendarRead };
    plannerRenderWaiting(P.props, P.checks);
  }

  async function plannerChooseTime(id, body) {
    const { data } = await api({ action: 'choose-time', proposal_id: id, ...body });
    if (!data?.ok) {
      const why = { no_time: 'I couldn\'t find a day and time in that. Try something like "Thu 7pm".', time_passed: 'That time has already passed.', ai_unavailable: 'I can\'t read typed times right now. Pick one of the times above.' }[data?.error] || data?.text || 'Could not save that. Try again.';
      P.other = { ...P.other, msg: why };
      plannerRenderWaiting(P.props, P.checks);
      return;
    }
    P.other = null;
    plannerLoad();
  }

  // ---- Quick add (Brain Calendar #69): one box, plain words ----
  async function plannerQuickAdd() {
    const text = el('plannerQuick').value.trim();
    if (!text) { el('plannerQuick').focus(); return; }
    const btn = el('plannerQuickBtn'); btn.disabled = true;
    el('plannerQuickMsg').innerHTML = '<div class="pl-when">Adding…</div>';
    try {
      const { data, error } = await api({ action: 'quick-add', text });
      if (error || !data?.ok) { el('plannerQuickMsg').innerHTML = '<div class="msg err">Could not add that. Try again.</div>'; return; }
      el('plannerQuick').value = '';
      const note = data.understood ? '' : ' (I couldn\'t read a date or time; use "Schedule" on it, or More options.)';
      el('plannerQuickMsg').innerHTML = `<div class="msg ok">${esc(plannerQuickSummary(data.task) + note)}</div>`;
      plannerLoad();
    } finally { btn.disabled = false; }
  }

  // ---- The Sunday "skipped this week" list (#22), answered here instead of Telegram ----
  async function plannerLoadSkipped() {
    try {
      const { data: rows } = await sb.from('bc_settings').select('key,value').eq('key', 'skipped_list');
      const list = rows && rows[0] ? rows[0].value : null;
      if (!list || !Array.isArray(list.ids) || !list.ids.length) { el('plannerSkipped').innerHTML = ''; return; }
      const { data: emails } = await sb.from('bc_emails').select('id,from_name,from_email,subject,feedback').in('id', list.ids);
      const r = plannerSkippedRows(list, emails || [], new Date());
      el('plannerSkipped').innerHTML = r.length ? '<div class="pl-day">Skipped this week <span style="text-transform:none; font-weight:400;">tap one that should have come through</span></div>' +
        r.map(x => `<div class="pl-item"><div class="pl-body"><div class="pl-title">${esc(x.from)}</div><div class="pl-when">${esc(x.subject)}</div>
          <div class="pl-actions">${x.learned ? '<span class="pl-chip">Will come through from now on</span>' : `<button class="secondary" data-skipped="${x.n}">Should have come through</button>`}</div></div></div>`).join('') : '';
    } catch { el('plannerSkipped').innerHTML = ''; }
  }

  async function plannerLearnSkipped(n) {
    const { data } = await api({ action: 'learn-skipped', numbers: [Number(n)] });
    if (!data?.ok) plannerNote('Could not save that. Try again.');
    else plannerNote(esc(`Got it. Mail from ${data.learned.join(', ')} will come through from now on.`), 'ok');
    plannerLoadSkipped();
  }

  // ---- Notifications on this device (Brain Calendar #63) ----
  function plannerDevice() {
    const ua = navigator.userAgent || '';
    return {
      ios: /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
      standalone: (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
      supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'default',
    };
  }

  async function plannerSwReg() {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg || null;
  }

  async function plannerRenderPush(refresh) {
    const d = plannerDevice();
    let sub = null;
    try { const reg = d.supported ? await plannerSwReg() : null; sub = reg ? await reg.pushManager.getSubscription() : null; } catch { /* no service worker (preview) */ }
    // Tell the server about this device again on each visit, so a renewed subscription isn't lost.
    if (sub && refresh) api({ action: 'push-subscribe', subscription: sub.toJSON(), user_agent: navigator.userAgent }).catch(() => {});
    const s = plannerPushStatus({ ...d, subscribed: !!sub });
    const buttons = (s.canTurnOn ? '<button id="plannerPushOn">Turn on notifications</button>' : '') +
      (s.canTest ? '<button class="secondary" id="plannerPushTest">Send test</button><button class="secondary" id="plannerPushOff">Turn off here</button>' : '');
    const html = `<div class="pl-body"><div class="pl-when">${esc(s.text)}</div>${buttons ? `<div class="pl-actions">${buttons}</div>` : ''}<div id="plannerPushMsg"></div></div>`;
    el('plannerPush').innerHTML = s.canTest
      ? `<details class="card" style="margin-bottom:8px;"><summary style="cursor:pointer; font-size:13px; color:#999;">Notifications: on</summary>${html}</details>`
      : `<div class="pl-item">${html}</div>`;
  }

  async function plannerPushOn() {
    const msg = t => { const m = el('plannerPushMsg'); if (m) m.innerHTML = t; };
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { await plannerRenderPush(); return; }
      const { data: cfg } = await api({ action: 'push-config' });
      if (!cfg?.publicKey) { msg('<div class="msg err">Notifications aren\'t set up on the server yet (VAPID keys missing).</div>'); return; }
      const reg = await plannerSwReg();
      if (!reg) { msg('<div class="msg err">The app\'s service worker isn\'t running. Reload the app and try again.</div>'); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: plannerB64ToBytes(cfg.publicKey) });
      const { data } = await api({ action: 'push-subscribe', subscription: sub.toJSON(), user_agent: navigator.userAgent });
      if (!data?.ok) { msg('<div class="msg err">Could not save this device. Try again.</div>'); return; }
      await plannerRenderPush();
      const m = el('plannerPushMsg'); if (m) m.innerHTML = '<div class="msg ok">Notifications are on. Tap "Send test" to try one.</div>';
    } catch (err) {
      msg(`<div class="msg err">${esc(err.message || 'Could not turn notifications on.')}</div>`);
    }
  }

  async function plannerPushTest() {
    const { data } = await api({ action: 'push-test' });
    const m = el('plannerPushMsg');
    if (m) m.innerHTML = data?.ok ? `<div class="msg ok">Sent to ${data.sent} ${data.sent === 1 ? 'device' : 'devices'}. It should arrive in a few seconds.</div>` : '<div class="msg err">The test didn\'t go out. Try turning notifications off and on again.</div>';
  }

  async function plannerPushOff() {
    try {
      const reg = await plannerSwReg();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) { await api({ action: 'push-unsubscribe', endpoint: sub.endpoint }); await sub.unsubscribe(); }
    } catch { /* already off */ }
    plannerRenderPush();
  }

  async function plannerAdd() {
    const title = el('plannerTitle').value;
    if (!title.trim()) return;
    const row = plannerFormToTask(title, el('plannerGoal').value, el('plannerDate').value, el('plannerTime').value,
      Number(el('plannerMinutes').value) || Number(P.settings.default_block_minutes) || 60);
    const { data, error } = await sb.from('bc_tasks').insert({ ...row, user_id: currentUser.id }).select().single();
    if (error) { plannerNote(esc(error.message)); return; }
    el('plannerTitle').value = ''; el('plannerTime').value = ''; el('plannerDate').value = '';
    if (data.scheduled_start) {
      // Brandan typed the time himself, so this is his "yes" (#43). Put it on the Brain calendar (#23).
      await api({ action: 'schedule-task', task_id: data.id }).catch(() => {});
    }
    plannerLoad();
  }

  document.addEventListener('change', e => {
    if (e.target.classList && e.target.classList.contains('pl-check')) plannerToggle(e.target.dataset.id, e.target.checked);
  });
  document.addEventListener('click', e => {
    const d = e.target.dataset || {};
    if (e.target.id === 'plannerAddBtn') plannerAdd();
    if (e.target.id === 'plannerQuickBtn') plannerQuickAdd();
    if (e.target.id === 'plannerPushOn') plannerPushOn();
    if (e.target.id === 'plannerPushTest') plannerPushTest();
    if (e.target.id === 'plannerPushOff') plannerPushOff();
    if (d.other) plannerOtherTimes(d.other);
    if (d.otherPick) { const [id, i] = d.otherPick.split(':'); plannerChooseTime(id, { index: Number(i) }); }
    if (d.otherType) plannerChooseTime(d.otherType, { text: (el('plannerOtherText') || {}).value || '' });
    if (d.skipped) plannerLearnSkipped(d.skipped);
    if (e.target.id === 'plannerNoteSave') plannerSaveNote();
    if (e.target.id === 'plannerNoteSkip') { P.noteFor = null; plannerLoad(); }
    if (e.target.id === 'plannerAddGoal') plannerAddGoal();
    if (d.goalSave) plannerSaveGoal(d.goalSave);
    if (d.schedule) { P.schedFor = d.schedule; plannerRenderTray(); el('plannerSchedTime').focus(); }
    if (d.schedCancel) { P.schedFor = null; plannerRenderTray(); }
    if (d.schedSave) plannerSchedule(d.schedSave);
    if (d.decide) { const [id, decision] = d.decide.split(':'); plannerDecide(id, decision); }
    if (d.checkin) { const [id, answer] = d.checkin.split(':'); plannerCheckin(id, answer, d.title); }
    if (d.view) {
      P.view = d.view;
      document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('secondary', b.dataset.view !== P.view));
      plannerLoad();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'plannerTitle' && e.key === 'Enter') plannerAdd();
    if (e.target.id === 'plannerQuick' && e.key === 'Enter') plannerQuickAdd();
    if (e.target.id === 'plannerOtherText' && e.key === 'Enter' && P.other) plannerChooseTime(P.other.id, { text: e.target.value });
    if (e.target.id === 'plannerNoteText' && e.key === 'Enter') plannerSaveNote();
  });

  window.loadPlanner = plannerLoad;
}
