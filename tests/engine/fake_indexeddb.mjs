// Minimal in-memory IndexedDB fake: exactly the API surface pch.js createIdbStore() uses
// (open + onupgradeneeded, createObjectStore, transaction(store, mode).objectStore(store)
// get/put/delete/openCursor, request.onsuccess, transaction.oncomplete/onerror/onabort).
// Callbacks fire asynchronously like the real thing. Values are structured-cloned on put.
export function makeFakeIndexedDB() {
  /** @type {Map<string, Record<string, Map<string, any>>>} */
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const api = {
    _stores: new Map(),
    open(name) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        let fresh = false;
        if (!dbs.has(name)) { dbs.set(name, {}); fresh = true; }
        const stores = dbs.get(name);
        api._stores.set(name, stores);
        const db = {
          createObjectStore(s) { stores[s] = new Map(); },
          transaction(storeName, _mode) {
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            let pending = 0;
            const done = () => later(() => { if (pending === 0 && tx.oncomplete) tx.oncomplete(); });
            const request = (fn) => { const r = { result: undefined, onsuccess: null }; pending++; later(() => { r.result = fn(r); pending--; if (r.onsuccess) r.onsuccess(); done(); }); return r; };
            tx.objectStore = () => {
              const m = stores[storeName];
              return {
                get: (k) => request(() => (m.has(k) ? structuredClone(m.get(k)) : undefined)),
                put: (v, k) => request(() => { m.set(k, structuredClone(v)); }),
                delete: (k) => request(() => { m.delete(k); }),
                openCursor: () => {
                  const keys = [...m.keys()];
                  let i = 0;
                  const r = { result: null, onsuccess: null };
                  pending++;
                  const step = () => later(() => {
                    if (i < keys.length) { const k = keys[i++]; r.result = { key: k, value: structuredClone(m.get(k)), continue: step }; if (r.onsuccess) r.onsuccess(); }
                    else { r.result = null; if (r.onsuccess) r.onsuccess(); pending--; done(); }
                  });
                  step();
                  return r;
                },
              };
            };
            later(done);
            return tx;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
  return api;
}
