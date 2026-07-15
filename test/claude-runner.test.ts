import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeRunner,
  SessionStore,
  type ClaudeQueryInput,
  type RunnerEvent,
} from "../src/index.js";

describe("ClaudeRunner", () => {
  it("does not launch a queued run after the runner closes", async () => {
    const store = new SessionStore();
    const session = store.create({ prompt: "first" });
    const queryFactory = vi.fn(() => emptyMessages());
    const runner = new ClaudeRunner(
      store,
      { permissionMode: "bypassPermissions" },
      { queryFactory },
    );

    runner.start(session.id, "first");
    runner.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryFactory).not.toHaveBeenCalled();
  });

  it("preserves a successful result when SDK stream disposal throws", async () => {
    const store = new SessionStore();
    const session = store.create({ prompt: "first" });
    const queryFactory = () => streamWithFailingCleanup(successResult("claude-session", "done")[0]);
    const runner = new ClaudeRunner(
      store,
      { permissionMode: "bypassPermissions" },
      { queryFactory },
    );

    runner.start(session.id, "first");
    await vi.waitFor(() => expect(store.require(session.id).status).toBe("completed"));

    expect(store.require(session.id).result?.text).toBe("done");
  });

  it("keeps a continued turn cancellable while the preceding completion event drains", async () => {
    const store = new SessionStore();
    const session = store.create({ prompt: "first" });
    const calls: ClaudeQueryInput[] = [];
    const runs: Array<(messages: SDKMessage[]) => void> = [];
    let releaseCompletion!: () => void;
    const completionDrained = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const queryFactory = (input: ClaudeQueryInput): AsyncIterable<SDKMessage> => {
      calls.push(input);
      let resolve!: (messages: SDKMessage[]) => void;
      const messages = new Promise<SDKMessage[]>((resolvePromise) => {
        resolve = resolvePromise;
      });
      runs.push(resolve);
      return (async function* () {
        for (const message of await messages) yield message;
      })();
    };
    const runner = new ClaudeRunner(
      store,
      { permissionMode: "bypassPermissions" },
      {
        queryFactory,
        onEvent: async (event: RunnerEvent) => {
          if (event.type === "completed" && event.session.turn === 1) {
            await completionDrained;
          }
        },
      },
    );

    runner.start(session.id, "first");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0](successResult("claude-session", "first result"));
    await vi.waitFor(() => expect(store.require(session.id).status).toBe("completed"));

    store.beginContinuation(session.id, "second");
    runner.start(session.id, "second", "claude-session");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    releaseCompletion();
    await new Promise((resolve) => setTimeout(resolve, 0));

    runner.close();

    expect(calls[1].options?.abortController?.signal.aborted).toBe(true);
  });
});

async function* emptyMessages(): AsyncIterable<SDKMessage> {}

async function* streamWithFailingCleanup(message: SDKMessage): AsyncIterable<SDKMessage> {
  try {
    yield message;
  } finally {
    throw new Error("cleanup failed");
  }
}

function successResult(sessionId: string, result: string): SDKMessage[] {
  return [
    {
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result,
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    } as unknown as SDKMessage,
  ];
}
