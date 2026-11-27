// Node tests of the v0.17 result-grid hibernation planner (src/ui/hibernate.ts, CONTRACT.md v0.17).
// Run: node scripts/test-hibernate.mjs   (Node ≥ 22.18; older Node 22: node --experimental-strip-types …)
import assert from "node:assert/strict";

const H = await import("../src/ui/hibernate.ts");

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✕ ${name}\n  ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

const c = (o = {}) => ({ visible: false, busy: false, pending: false, rows: 0, ...o });
const many = (n, o = {}) => Array.from({ length: n }, () => c(o));
const opts = { live: 10, rowBudget: 100_000 };

test("defaults", () => {
  assert.equal(H.LIVE_CONSOLES, 10);
  assert.equal(H.DEFAULT_RESULT_ROWS, 100_000);
});
test("10 or fewer consoles: nothing hibernates", () => {
  assert.deepEqual(H.planHibernation(many(10, { rows: 1e6 }), opts), Array(10).fill("keep"));
  assert.deepEqual(H.planHibernation([], opts), []);
});
test("beyond the 10 most recent: hibernate", () => {
  const plan = H.planHibernation(many(13, { rows: 500 }), opts);
  assert.deepEqual(plan.slice(0, 10), Array(10).fill("keep"));
  assert.deepEqual(plan.slice(10), ["hibernate", "hibernate", "hibernate"]);
});
test("visible, busy and pending consoles are never hibernated", () => {
  const list = [...many(10), c({ visible: true, rows: 1e6 }), c({ busy: true, rows: 1e6 }), c({ pending: true, rows: 1e6 }), c({ rows: 1e6 })];
  assert.deepEqual(H.planHibernation(list, opts).slice(10), ["keep", "keep", "keep", "release"]);
});
test("row budget: more than the budget releases, exactly the budget only hibernates", () => {
  const list = [...many(10), c({ rows: 100_000 }), c({ rows: 100_001 }), c({ rows: 0 })];
  assert.deepEqual(H.planHibernation(list, opts).slice(10), ["hibernate", "release", "hibernate"]);
});
test("budget 0 = never release rows", () => {
  const list = [...many(10), c({ rows: 5e6 })];
  assert.deepEqual(H.planHibernation(list, { live: 10, rowBudget: 0 }).slice(10), ["hibernate"]);
  assert.deepEqual(H.planHibernation(list, { live: 10, rowBudget: -5 }).slice(10), ["hibernate"]);
});
test("budget ignores recency inside the live window", () => {
  const list = [c({ rows: 9e6 }), ...many(10, { rows: 9e6 })];
  const plan = H.planHibernation(list, opts);
  assert.equal(plan[0], "keep");
  assert.equal(plan[10], "release");
});
test("a smaller live count", () => {
  assert.deepEqual(H.planHibernation(many(4, { rows: 10 }), { live: 2, rowBudget: 5 }), ["keep", "keep", "release", "release"]);
  // at least one console (the most recent) always keeps its grid
  assert.deepEqual(H.planHibernation(many(2), { live: 0, rowBudget: 0 }), ["keep", "hibernate"]);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
