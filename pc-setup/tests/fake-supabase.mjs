// A tiny in-memory stand-in for the supabase-js client: only what export-brain uses
// (from().select().eq().is().gt().order().limit()). It records every method name so a
// test can prove the function never writes.
export function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(`from:${table}`);
      const filters = [];
      let order = null, limit = Infinity;
      const q = {
        select(cols) { calls.push(`select:${cols}`); return q; },
        eq(col, val) { calls.push(`eq:${col}`); filters.push((r) => r[col] === val); return q; },
        is(col, val) { calls.push(`is:${col}`); filters.push((r) => (r[col] ?? null) === val); return q; },
        gt(col, val) { calls.push(`gt:${col}`); filters.push((r) => String(r[col]) > String(val)); return q; },
        order(col) { order = col; return q; },
        limit(n) { limit = n; return q; },
        then(resolve) {
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (order) rows = [...rows].sort((a, b) => (String(a[order]) < String(b[order]) ? -1 : 1));
          resolve({ data: rows.slice(0, limit).map((r) => ({ ...r })), error: null });
        },
      };
      // Any write method fails the test loudly.
      for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { throw new Error(`WRITE ATTEMPTED: ${m}`); };
      return q;
    },
    rpc() { throw new Error("rpc not expected"); },
  };
}

// Made-up ids only. OWNER is a placeholder, not anyone's real id.
export const OWNER = "00000000-0000-4000-8000-000000000001";
export const OTHER = "00000000-0000-4000-8000-000000000002";
export const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
