// Test helpers: a fake Deno runtime so Supabase edge-function files can be loaded in Node.
// Everything here is made up. No real URLs are ever called: fetch is replaced by a fake.

export function installFakeDeno(env = {}) {
  const served = { handler: null };
  globalThis.Deno = {
    env: { get: (k) => (k in env ? env[k] : undefined) },
    serve: (h) => { served.handler = h; },
  };
  return served;
}

/** Replaces global fetch. `routes` is a list of [matcherFn, responderFn]. Records every call. */
export function installFakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = init.body;
    try { body = JSON.parse(init.body); } catch { /* not json */ }
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    for (const [match, respond] of routes) {
      if (match(u, init)) {
        const out = await respond(u, body, init);
        return new Response(JSON.stringify(out?.json ?? out ?? {}), { status: out?.status ?? 200 });
      }
    }
    throw new Error(`Test fetch to unexpected URL: ${u}`);
  };
  return calls;
}

export const FAKE_URL = 'https://fake-project.example.test';
