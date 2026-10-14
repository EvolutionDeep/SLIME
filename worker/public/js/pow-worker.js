// pow-worker.js — grinds the per-epoch proof-of-work off the main thread.
//
// It mirrors world.ts `powHash` verbatim: the browser does the expensive
// search (find a nonce whose hash has enough leading zero bits), the Worker
// verifies any submitted answer in O(1) by recomputing the same hash. Runs in
// ~30ms time-slices so it never wedges the isolate, and reports a live rate so
// the dashboard can show your device actually working.

function powHash(a, b) {
  let h = Math.imul(a >>> 0, 2654435761) ^ Math.imul(b >>> 0, 40503);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return h >>> 0;
}

let stop = false;

self.onmessage = (e) => {
  const { id, challenge, difficulty } = e.data;
  stop = false;
  const shift = 32 - difficulty;
  let n = (Math.random() * 0xffffffff) >>> 0;   // random start so devices diverge
  let tries = 0;
  const t0 = Date.now();

  const step = () => {
    if (stop) return;
    const sliceEnd = Date.now() + 30;
    do {
      if ((powHash(challenge, n) >>> shift) === 0) {
        self.postMessage({ type: "solved", id, nonce: n >>> 0, attempts: tries });
        return;
      }
      n = (n + 1) >>> 0;
      tries++;
    } while (Date.now() < sliceEnd);
    self.postMessage({
      type: "progress", id, attempts: tries,
      hps: tries / (Math.max(1, Date.now() - t0) / 1000),
    });
    setTimeout(step, 0);   // yield to the event loop between slices
  };
  step();
};
