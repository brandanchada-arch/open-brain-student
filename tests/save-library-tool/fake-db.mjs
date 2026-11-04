// A tiny in-memory stand-in for the supabase-js client, enough for save_to_library.
// Supports from(t).select/insert/update/delete/upsert + eq/is/in/limit/order + single/maybeSingle.
// Every call is recorded in `log` (table + operation), so tests can prove what was (not) touched.
// Also exported as `createClient`, so the real open-brain-mcp/index.ts can be pointed at it.
let nextId = 1;
const newId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

export function fakeDb(tables = {}, { failOn } = {}) {
  const data = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const log = [];

  function query(table) {
    const state = { op: 'select', rows: null, patch: null, filters: [], limit: null, single: null };
    const rowsOf = () => (data[table] ??= []);
    const matches = (r) => state.filters.every((f) => f(r));
    const finish = (rows) => {
      if (state.single === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not one row' } };
      if (state.single === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const run = () => {
      log.push({ table, op: state.op });
      if (failOn && failOn(table, state.op)) return { data: null, error: { message: `made-up ${state.op} failure` } };
      if (state.op === 'insert' || state.op === 'upsert') {
        const added = state.rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
        rowsOf().push(...added);
        return finish(added);
      }
      if (state.op === 'update') {
        const hit = rowsOf().filter(matches);
        for (const r of hit) Object.assign(r, state.patch);
        return finish(hit);
      }
      if (state.op === 'delete') {
        const keep = rowsOf().filter((r) => !matches(r));
        const gone = rowsOf().length - keep.length;
        data[table] = keep;
        return { data: null, error: null, count: gone };
      }
      let out = rowsOf().filter(matches);
      if (state.limit != null) out = out.slice(0, state.limit);
      return finish(out.map((r) => ({ ...r })));
    };
    const q = {
      select() { return q; },
      insert(rows) { state.op = 'insert'; state.rows = Array.isArray(rows) ? rows : [rows]; return q; },
      upsert(rows) { state.op = 'upsert'; state.rows = Array.isArray(rows) ? rows : [rows]; return q; },
      update(patch) { state.op = 'update'; state.patch = patch; return q; },
      delete() { state.op = 'delete'; return q; },
      eq(c, v) { state.filters.push((r) => r[c] === v); return q; },
      is(c, v) { state.filters.push((r) => (r[c] ?? null) === v); return q; },
      in(c, vs) { state.filters.push((r) => vs.includes(r[c])); return q; },
      order() { return q; },
      limit(n) { state.limit = n; return q; },
      single() { state.single = 'single'; return q; },
      maybeSingle() { state.single = 'maybe'; return q; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return q;
  }

  return { data, log, from: (t) => query(t), rpc: async () => ({ data: null, error: { message: 'no rpc in this fake' } }) };
}

/** For the real index.ts: every createClient() returns the database the test put in globalThis.__fakeDb. */
export function createClient() {
  return globalThis.__fakeDb;
}
