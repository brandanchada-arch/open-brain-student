// Study → Library reader: shows the "door check" warning (Nov 3, 2026).
// When a web page, transcript or PDF was saved, the server checked it for text that tries to
// give instructions to an AI and stored the result in metadata.door_check. If it was flagged,
// this adds a warning box under the title. The entry is saved and usable as normal; Ask and
// the quiz always treat library text as data, never as instructions.
// Watches the reader (library.js) instead of changing it.

(function () {
  const reader = document.getElementById('libReader');
  if (!reader || !window.MutationObserver) return;
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const cache = new Map();   // entry id -> door_check (or null)

  async function doorCheckFor(id) {
    if (cache.has(id)) return cache.get(id);
    const { data, error } = await sb.from('library').select('door_check:metadata->door_check').eq('id', id).maybeSingle();
    const result = error ? null : (data && data.door_check) || null;
    if (!error) cache.set(id, result);
    return result;
  }

  async function addFlag() {
    const entry = reader._entry;
    if (!entry || !entry.id || reader.hidden || reader.querySelector('.door-flag')) return;
    let check;
    try { check = await doorCheckFor(entry.id); } catch (_) { return; }
    // The reader may have moved on to another entry while we waited.
    if (!check || check.flagged !== true || reader._entry !== entry || reader.querySelector('.door-flag')) return;
    const reasons = Array.isArray(check.reasons) ? check.reasons.slice(0, 5) : [];
    const box = document.createElement('div');
    box.className = 'door-flag';
    box.setAttribute('role', 'note');
    box.innerHTML = `<b>Heads-up:</b> this text contains wording that looks like instructions to an AI.
      It was saved as normal, and Ask and quizzes only ever treat it as information.
      ${reasons.length ? `<div class="door-reasons">Why: ${reasons.map(esc).join(' · ')}</div>` : ''}`;
    const meta = reader.querySelector('.thought-meta');
    if (meta) meta.after(box); else reader.prepend(box);
  }

  // library.js replaces the reader's HTML each time it opens an entry or shows more.
  new MutationObserver(() => { addFlag(); }).observe(reader, { childList: true });
})();
