import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowProcessCutoffQueryScope } from "../support/infrastructure/flow-process-query-readback.js";

const early = "2026-01-02T00:00:00.000Z";
const late = "2026-01-03T00:00:00.000Z";
const activity = (eventId, finishedAt) => ({ processEvent: { eventId, occurredAt: finishedAt }, timing: { finishedAt } });

test("cutoff query keeps all selected events in one saved ledger time range across page requests", () => {
  const events = [{ eventId: "late-event" }, { eventId: "early-event" }];
  const activities = [activity("unrelated-old-event", "2026-01-01T00:00:00.000Z"),
    activity("early-event", early), activity("late-event", late)];
  const scope = new FlowProcessCutoffQueryScope({ events, activities });
  for (const after of [null, "opaque-next-page"]) {
    const request = scope.request("001-cutoff-query", after);
    assert.equal(request.specId, "001-cutoff-query");
    assert.equal(request.recordedAt.gte, early);
    assert.equal(request.recordedAt.lt, null);
    assert.equal(request.page.after, after);
    assert.deepEqual(scope.eventIds, ["late-event", "early-event"]);
  }
});

test("cutoff query refuses incomplete event identity or ledger timing without a fallback range", () => {
  const cases = [
    { name: "empty cutoff", events: [], activities: [] },
    { name: "missing identity", events: [{}], activities: [activity(undefined, early)] },
    { name: "missing event", events: [{ eventId: "missing" }], activities: [activity("other", early)] },
    { name: "duplicate saved event", events: [{ eventId: "event" }], activities: [activity("event", early), activity("event", late)] },
    { name: "missing timing", events: [{ eventId: "event" }], activities: [{ processEvent: { eventId: "event" } }] },
    { name: "invalid timing", events: [{ eventId: "event" }], activities: [activity("event", "2026-01-02")] },
    { name: "event timing mismatch", events: [{ eventId: "event" }], activities: [{
      processEvent: { eventId: "event", occurredAt: late }, timing: { finishedAt: early },
    }] },
  ];
  for (const input of cases) {
    assert.throws(() => new FlowProcessCutoffQueryScope(input), { code: "ERR_ASSERTION" }, input.name);
  }
});
