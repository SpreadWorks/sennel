import assert from "node:assert/strict";
import { CanonicalFlowVersionReader, QueryRequest } from "../../../src/flow/query.js";
import { isFlowQueryDatetime, validateFlowQueryResponse } from "../../../src/flow/query-contract.js";

/** The whole saved cutoff determines the range before any page is queried. */
export class FlowProcessCutoffQueryScope {
  constructor({ events, activities }) {
    assert.ok(Array.isArray(events) && events.length > 0, "a cutoff query requires every selected fence event");
    this.eventIds = Object.freeze(events.map((event) => {
      assert.ok(typeof event.eventId === "string" && event.eventId !== "", "a cutoff event requires its saved identity");
      return event.eventId;
    }));
    const recordedAt = this.eventIds.map((eventId) => {
      const published = activities.filter((activity) => activity.processEvent != null && activity.processEvent.eventId === eventId);
      assert.equal(published.length, 1, "every cutoff event requires exactly one saved Activity before selecting its query range");
      const finishedAt = published[0].timing?.finishedAt;
      assert.ok(isFlowQueryDatetime(finishedAt), "every cutoff event requires its actual saved ledger timing");
      assert.equal(finishedAt, published[0].processEvent.occurredAt,
        "cutoff ledger timing must equal its saved process event time");
      return finishedAt;
    });
    this.gte = recordedAt.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
    Object.freeze(this);
  }

  request(specId, after) {
    return new QueryRequest({ resource: "activities", condition: { specId },
      page: { limit: 100, after }, recordedAt: { gte: this.gte } });
  }
}

/** Consume ordinary paginated queries, including events beyond the first page. */
export class FlowProcessQueryReadback {
  constructor(items) {
    this.items = new Map(items.filter(item => item.processEvent).map(item => [item.processEvent.eventId, item]));
  }

  static async read(root, specId) {
    return this.#read(root, specId, null);
  }

  static async readCutoff(root, specId, input) {
    return this.#read(root, specId, new FlowProcessCutoffQueryScope(input));
  }

  static async #read(root, specId, scope) {
    const reader = new CanonicalFlowVersionReader({ repositoryRoot: root });
    const items = [];
    let after = null;
    for (;;) {
      const request = scope === null ? new QueryRequest({
        resource: "activities", condition: { specId }, page: { limit: 100, after },
      }) : scope.request(specId, after);
      const read = await reader.read(specId, 1, request);
      assert.equal(read.version.projectionError, null);
      const response = read.version.response;
      validateFlowQueryResponse(response);
      items.push(...response.items);
      if (!response.pageInfo.hasNext) return new this(items);
      assert.ok(response.pageInfo.endCursor);
      assert.notEqual(response.pageInfo.endCursor, after);
      after = response.pageInfo.endCursor;
    }
  }

  assertActivity(activity) {
    const item = this.items.get(activity.processEvent.eventId);
    assert.ok(item, "the ordinary query must expose the real process event");
    assert.equal(item.activity.id, activity.id);
    assert.equal(item.processEvent.callId, activity.processEvent.callId);
  }
}
