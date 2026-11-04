// A made-up stand-in for supabase-js, used when loading edge-function files in Node.
// Every query returns no rows. Calls are recorded in globalThis.__sb so tests can see
// whether the function read anything or asked who the user is.
export const OWNER = '00000000-0000-0000-0000-000000000001';
export const OWNER_LOGIN = 'owner-login-token';
export const OTHER_LOGIN = 'someone-else-login-token';

function chain(log, table) {
  const result = { data: [], error: null };
  const p = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(result).then(res, rej);
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data: null, error: null });
      return (...args) => { log.push({ table, op: String(prop), args }); return p; };
    },
  });
  return p;
}

export function createClient(_url, key, opts = {}) {
  const log = (globalThis.__sb ??= { from: [], getUser: [] });
  const authHeader = opts?.global?.headers?.Authorization ?? '';
  return {
    from: (table) => { log.from.push(table); return chain(log.from, table); },
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => {
        log.getUser.push(authHeader);
        if (authHeader === `Bearer ${OWNER_LOGIN}`) return { data: { user: { id: OWNER } } };
        if (authHeader === `Bearer ${OTHER_LOGIN}`) return { data: { user: { id: '00000000-0000-0000-0000-000000000099' } } };
        return { data: { user: null } };
      },
      admin: { listUsers: async () => ({ data: { users: [] } }) },
    },
  };
}
export const jsonrepair = (s) => s;
export class SupabaseClient {}
