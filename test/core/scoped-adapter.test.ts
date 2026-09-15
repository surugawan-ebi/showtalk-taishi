import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentScopedAdapter,
  CoreError,
  type AdapterSession,
  type AgentAdapter,
  type AgentEvent,
  type CreateSessionRequest,
  type ResumeSessionRequest,
  type SendMessageRequest,
} from "../../src/core/index.js";

class BlockingChildAdapter implements AgentAdapter {
  readonly kind = "child";
  readonly capabilities = {
    streaming: true,
    approval: false,
    interrupt: true,
    resume: true,
    toolEvents: false,
  };
  readonly entered: Promise<void>;
  #enter!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#enter = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  async createSession(): Promise<AdapterSession> {
    return { id: "backend" };
  }

  async *sendMessage(): AsyncIterable<AgentEvent> {
    this.#enter();
    await this.#released;
    yield { type: "message.completed", text: "done" };
  }

  release(): void {
    this.#release();
  }

  async interrupt(): Promise<void> {
    this.release();
  }
}

class ChildAdapter implements AgentAdapter {
  readonly kind = "child";
  readonly capabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: true,
  };
  readonly calls: string[] = [];

  constructor(readonly label: string) {}

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    this.calls.push(`create:${request.agent.id}`);
    return { id: `${this.label}-thread`, state: { child: this.label } };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    this.calls.push(`resume:${request.agent.id}`);
    return { id: request.adapterSessionId };
  }

  async *sendMessage(
    _session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.calls.push(`send:${request.text}`);
    yield { type: "message.completed", text: this.label };
  }

  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
  }
}

test("routes every session operation to its isolated Agent adapter", async () => {
  const implementer = new ChildAdapter("implementer");
  const reviewer = new ChildAdapter("reviewer");
  const scoped = new AgentScopedAdapter(
    "codex",
    new Map([
      ["implementer", implementer],
      ["reviewer", reviewer],
    ]),
  );
  const session = await scoped.createSession({
    agent: { id: "reviewer", adapter: "codex", channelId: "C2" },
    reason: "delegation",
  });

  const events: AgentEvent[] = [];
  for await (const event of scoped.sendMessage(session, {
    text: "review",
    source: { type: "human" },
  })) {
    events.push(event);
  }
  await scoped.interrupt(session);

  assert.deepEqual(implementer.calls, []);
  assert.deepEqual(reviewer.calls, [
    "create:reviewer",
    "send:review",
    "interrupt",
  ]);
  assert.equal(session.state?.showtalkTaishiAgentId, "reviewer");
  assert.equal(events[0]?.type, "message.completed");
});

test("restores the Agent binding while resuming persisted sessions", async () => {
  const child = new ChildAdapter("implementer");
  const scoped = new AgentScopedAdapter("codex", new Map([["implementer", child]]));
  const resumed = await scoped.resumeSession({
    agent: { id: "implementer", adapter: "codex", channelId: "C1" },
    adapterSessionId: "stored-thread",
  });
  assert.equal(resumed.state?.showtalkTaishiAgentId, "implementer");
  assert.deepEqual(child.calls, ["resume:implementer"]);
});

test("fails closed when a persisted session has no Agent identity", async () => {
  const child = new ChildAdapter("implementer");
  const scoped = new AgentScopedAdapter("codex", new Map([["implementer", child]]));
  const events = scoped
    .sendMessage(
      { id: "legacy" },
      { text: "hello", source: { type: "human" } },
    )
    [Symbol.asyncIterator]();
  await assert.rejects(
    () => events.next(),
    /missing its scoped Agent identity/,
  );
});

test("allows only one active turn per authenticated Agent identity", async () => {
  const child = new BlockingChildAdapter();
  const scoped = new AgentScopedAdapter("codex", new Map([["implementer", child]]));
  const firstSession = await scoped.createSession({
    agent: { id: "implementer", adapter: "codex", channelId: "C1" },
    reason: "slack_conversation",
  });
  const secondSession: AdapterSession = {
    id: "another-thread",
    ...(firstSession.state === undefined ? {} : { state: firstSession.state }),
  };

  const first = scoped
    .sendMessage(firstSession, { text: "first", source: { type: "human" } })
    [Symbol.asyncIterator]();
  const firstEvent = first.next();
  await child.entered;

  const second = scoped
    .sendMessage(secondSession, { text: "second", source: { type: "human" } })
    [Symbol.asyncIterator]();
  await assert.rejects(
    () => second.next(),
    (error) => error instanceof CoreError && error.code === "AGENT_BUSY",
  );

  child.release();
  assert.equal((await firstEvent).value?.type, "message.completed");
  await first.next();

  const retry = scoped
    .sendMessage(secondSession, { text: "retry", source: { type: "human" } })
    [Symbol.asyncIterator]();
  assert.equal((await retry.next()).value?.type, "message.completed");
});
