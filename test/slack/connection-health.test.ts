import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { SlackConnectionHealth } from "../../src/slack/connection-health.js";

class FakeSocketClient extends EventEmitter {
  active = false;
  readonly websocket = { isActive: () => this.active };
}

test("records one degraded interval and one recovery without Slack payloads", () => {
  const client = new FakeSocketClient();
  const lines: string[] = [];
  let now = 0;
  const health = new SlackConnectionHealth(client, {
    now: () => now,
    degradedAfterMs: 100,
    checkIntervalMs: 1_000,
    log: (line) => lines.push(line),
  });
  health.start();
  client.active = true;
  client.emit("connected");
  assert.equal(health.status(), "connected");
  now = 10;
  client.active = false;
  client.emit("close");
  client.emit("reconnecting");
  now = 109;
  health.check();
  assert.equal(health.status(), "disconnected");
  now = 110;
  health.check();
  health.check();
  assert.equal(health.status(), "degraded");
  client.active = true;
  client.emit("connected");
  assert.equal(health.status(), "connected");
  health.stop();
  client.emit("close");
  assert.deepEqual(lines.map((line) => JSON.parse(line) as { event: string }), [
    { component: "showtalk.slack_connection", event: "connected" },
    { component: "showtalk.slack_connection", event: "disconnected" },
    { component: "showtalk.slack_connection", event: "degraded" },
    { component: "showtalk.slack_connection", event: "recovered" },
  ]);
});

test("detects a silent socket loss and a startup that never connects", () => {
  const client = new FakeSocketClient();
  let now = 0;
  const health = new SlackConnectionHealth(client, {
    now: () => now,
    degradedAfterMs: 100,
    checkIntervalMs: 1_000,
    log: () => undefined,
  });
  health.start();
  now = 100;
  health.check();
  assert.equal(health.status(), "degraded");
  client.active = true;
  client.emit("connected");
  now = 101;
  client.active = false;
  health.check();
  assert.equal(health.status(), "disconnected");
  health.stop();
  assert.equal(health.status(), "stopped");
});

