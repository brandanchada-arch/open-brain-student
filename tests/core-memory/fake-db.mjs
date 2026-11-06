// A tiny in-memory stand-in for the supabase-js client, enough for these tests.
// Supports from(t).select/insert/upsert + eq/neq/is/gte/in/order/limit + single/maybeSingle,
// and rpc(name, args) through handlers you pass in. Every call is recorded in `log`.
let nextId = 1;
const newId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

export function fakeDb(tables = {}, rpcHandlers = {}) {
  const data = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(r => ({ ...r }))]));
  const log = [];

  function query(table) {
    const state = { table, filters: [], op: 'select', rows: null, order: null, limit: null, single: null, opts: {} };
    const rowsOf = () => (data[table] ??= []);
    const matches = (r) => state.filters.every(f => f(r));
    const run = () => {
      log.push({ table, op: state.op, filters: state.filterNames ?? [] });
      if (state.failWith) return { data: null, error: { message: state.failWith } };
      if (state.op === 'insert' || state.op === 'upsert') {
        const added = [];
        for (const r of state.rows) {
          if (state.op === 'upsert' && state.opts.onConflict) {
            const keys = state.opts.onConflict.split(',');
            const hit = rowsOf().find(x => keys.every(k => x[k] === r[k]));
            if (hit) { if (!state.opts.ignoreDuplicates) Object.assign(hit, r); continue; }
          }
          const row = { id: newId(), created_at: new Date().toISOString(), ...r };
          rowsOf().push(row); added.push(row);
        }
        return finish(added);
      }
      let out = rowsOf().filter(matches);
      if (state.op === 'update') {
        out.forEach((r) => Object.assign(r, state.patch));
        return finish(out);
      }
      if (state.order) {
        const { col, asc } = state.order;
        out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (state.limit != null) out = out.slice(0, state.limit);
      return finish(out);
    };
    const finish = (rows) => {
      if (state.single === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not one row' } };
      if (state.single === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const q = {
      select() { return q; },
      insert(rows) { state.op = 'insert'; state.rows = Array.isArray(rows) ? rows : [rows]; return q; },
      update(patch) { state.op = 'update'; state.patch = patch; return q; },
      lt(c, v) { (state.filterNames ??= []).push(`lt:${c}`); state.filters.push(r => Date.parse(r[c]) < Date.parse(v)); return q; },
      upsert(rows, opts = {}) { state.op = 'upsert'; state.rows = Array.isArray(rows) ? rows : [rows]; state.opts = opts; return q; },
      eq(c, v) { (state.filterNames ??= []).push(`eq:${c}`); state.filters.push(r => r[c] === v); return q; },
      neq(c, v) { (state.filterNames ??= []).push(`neq:${c}`); state.filters.push(r => r[c] !== v); return q; },
      is(c, v) { (state.filterNames ??= []).push(`is:${c}`); state.filters.push(r => (r[c] ?? null) === v); return q; },
      gte(c, v) { (state.filterNames ??= []).push(`gte:${c}`); state.filters.push(r => Date.parse(r[c]) >= Date.parse(v)); return q; },
      in(c, vs) { (state.filterNames ??= []).push(`in:${c}`); state.filters.push(r => vs.includes(r[c])); return q; },
      or(expr) { (state.filterNames ??= []).push(`or:${expr}`); return q; },
      order(col, o = {}) { state.order = { col, asc: o.ascending !== false }; return q; },
      limit(n) { state.limit = n; return q; },
      single() { state.single = 'single'; return q; },
      maybeSingle() { state.single = 'maybe'; return q; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return q;
  }

  return {
    data, log,
    from: (t) => query(t),
    async rpc(name, args) {
      log.push({ rpc: name, args });
      const h = rpcHandlers[name];
      if (!h) return { data: null, error: { message: `no rpc ${name}` } };
      try { return { data: await h(args, data), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
  };
}
