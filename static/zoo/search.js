"use strict";

// The catalogue stays in one worker. Subsequent keystrokes send only the query.
(() => {
  let worker;
  let sequence = 0;
  const pending = new Map();
  window.atlasZooSearch = (query, entries, {signal}) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    if (!worker) {
      worker = new Worker("./search-worker.js", {type: "module"});
      worker.onmessage = ({data}) => {
        const job = pending.get(data.id);
        if (job) job.finish(data);
      };
      worker.onerror = () => {
        worker.terminate();
        worker = null;
        for (const job of pending.values()) job.finish({error: "Could not load catalogue search. Try again."});
      };
      worker.postMessage({entries});
    }
    const id = ++sequence;
    const abort = () => {
      pending.delete(id);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, {once: true});
    pending.set(id, {finish(data) {
      pending.delete(id);
      signal.removeEventListener("abort", abort);
      if (data.error) reject(new Error(data.error));
      else resolve({ids: data.ids});
    }});
    worker.postMessage({id, query});
  });
})();
