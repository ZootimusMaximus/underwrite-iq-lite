"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { extractSignals } = require("../behavior-scoring/signal-extractor");

const NOW = new Date("2026-06-21T12:00:00Z").getTime();

function msg(direction, timestamp, body = "", channel = "sms") {
  return { direction, timestamp: new Date(timestamp).toISOString(), body, channel };
}

describe("extractSignals", () => {
  it("computes median reply time from inbound→outbound pairs", () => {
    const messages = [
      msg("inbound", NOW - 2 * 3600 * 1000),
      msg("outbound", NOW - 1 * 3600 * 1000),
      msg("inbound", NOW - 4 * 3600 * 1000),
      msg("outbound", NOW - 3.5 * 3600 * 1000)
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.ok(Math.abs(signals.median_reply_time_hours - 0.75) < 0.1);
  });

  it("computes reply rate: outbound replied-to / total outbound", () => {
    const messages = [
      msg("outbound", NOW - 10 * 3600 * 1000),
      msg("inbound", NOW - 9 * 3600 * 1000),
      msg("outbound", NOW - 8 * 3600 * 1000)
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.ok(Math.abs(signals.reply_rate - 0.5) < 0.1);
  });

  it("ghost streak counts consecutive trailing outbounds", () => {
    const messages = [
      msg("inbound", NOW - 5 * 3600 * 1000),
      msg("outbound", NOW - 4 * 3600 * 1000),
      msg("outbound", NOW - 3 * 3600 * 1000),
      msg("outbound", NOW - 2 * 3600 * 1000)
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.equal(signals.ghost_streak, 3);
  });

  it("ghost streak null when last message is inbound", () => {
    const messages = [
      msg("outbound", NOW - 3 * 3600 * 1000),
      msg("inbound", NOW - 1 * 3600 * 1000)
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.equal(signals.ghost_streak, null);
  });

  it("inbound_initiated counts leading/sequential inbound messages", () => {
    const messages = [
      msg("inbound", NOW - 5 * 3600 * 1000, "Hello"),
      msg("inbound", NOW - 4 * 3600 * 1000, "Anyone?"),
      msg("outbound", NOW - 3 * 3600 * 1000, "Hi"),
      msg("inbound", NOW - 1 * 3600 * 1000, "Follow up")
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.ok(signals.inbound_initiated > 0);
  });

  it("filters out channel=other messages", () => {
    const messages = [
      {
        direction: "inbound",
        timestamp: new Date(NOW - 2 * 3600 * 1000).toISOString(),
        body: "test",
        channel: "other"
      },
      msg("outbound", NOW - 1 * 3600 * 1000)
    ];
    const signals = extractSignals(messages, [], [], NOW);
    assert.equal(signals.median_reply_time_hours, null);
  });

  it("extracts paid_deposit intent action from client record", () => {
    const client = { paid_deposit: true };
    const signals = extractSignals([], [client], [], NOW);
    assert.ok(signals.intent_actions.some(a => a.type === "paid_deposit"));
  });

  it("extracts booked_call from funding round stage", () => {
    const round = { Stage: "Call Booked", createdTime: new Date(NOW).toISOString() };
    const signals = extractSignals([], [], [round], NOW);
    assert.ok(signals.intent_actions.some(a => a.type === "booked_call"));
  });

  it("extracts no_show friction event from client", () => {
    const client = { no_show: true };
    const signals = extractSignals([], [client], [], NOW);
    assert.ok(signals.friction_events.some(e => e.type === "no_show"));
  });

  it("extracts reschedule from funding round", () => {
    const round = { reschedule: true, Stage: "Active", createdTime: new Date(NOW).toISOString() };
    const signals = extractSignals([], [], [round], NOW);
    assert.ok(signals.friction_events.some(e => e.type === "reschedule"));
  });

  it("absent signals (video/click/open) are null", () => {
    const signals = extractSignals([], [], [], NOW);
    assert.equal(signals.video_watch_pct, null);
    assert.equal(signals.click_rate, null);
    assert.equal(signals.open_rate, null);
  });

  it("empty inputs don't crash", () => {
    assert.doesNotThrow(() => extractSignals([], [], [], NOW));
  });

  it("message_bodies returned for keyword scanning", () => {
    const messages = [msg("inbound", NOW - 1000, "I am ready to sign up")];
    const signals = extractSignals(messages, [], [], NOW);
    assert.equal(signals.message_bodies.length, 1);
    assert.equal(signals.message_bodies[0].text, "I am ready to sign up");
  });
});
