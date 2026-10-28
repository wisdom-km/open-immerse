/**
 * One text-layer read per page at a time.
 * A cancelled read can still be inside pdf.js. The next read of that page waits
 * until it returns, so the two renders do not overlap.
 */

const lanes = new Map();

export function claimTextLane(page) {
  const prev = lanes.get(page) || Promise.resolve();
  let releaseGate = () => {};
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const tail = prev.catch(() => {}).then(() => gate);
  lanes.set(page, tail);
  let released = false;
  return {
    ready: prev.catch(() => {}),
    release() {
      if (released) return;
      released = true;
      releaseGate();
      if (lanes.get(page) === tail) lanes.delete(page);
    }
  };
}
