import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  type AsyncClaudeServer,
  type ClaudeQueryInput,
} from "../src/index.js";

type DeferredRun = {
  resolve: (messages: SDKMessage[]) => void;
  reject: (error: unknown) => void;
};

class FakeClaude {
  readonly calls: ClaudeQueryInput[] = [];
  readonly runs: DeferredRun[] = [];

  readonly query = (input: ClaudeQueryInput): AsyncIterable<SDKMessage> => {
    this.calls.push(input);
    let resolve!: DeferredRun["resolve"];
    let reject!: DeferredRun["reject"];
    const messages = new Promise<SDKMessage[]>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.runs.push({ resolve, reject });

    return (async function* () {
      for (const message of await messages) yield message;
    })();
  };
}

type ConnectedClient = {
  client: Client;
  close(): Promise<void>;
};

describe("async Claude MCP server", () => {
  const servers: AsyncClaudeServer[] = [];
  const clients: ConnectedClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map(({ server }) => server.close()));
  });

  it("exposes the three asynchronous session tools", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const { client } = await connect(instance.server);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "claude",
      "claude-continue",
      "claude-status",
    ]);
  });

  it("returns before Claude finishes and passes run options to the Agent SDK", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const { client } = await connect(instance.server);

    const started = await client.callTool({
      name: "claude",
      arguments: {
        prompt: "Build the feature",
        model: "claude-opus-4-6",
        effort: "high",
        cwd: "/tmp/project",
      },
      _meta: {
        threadId: "thread-fallback",
        "x-codex-turn-metadata": {
          session_id: "codex-session",
          thread_id: "codex-thread",
          turn_id: "codex-turn",
        },
      },
    });
    const payload = structured(started);

    expect(payload.status).toBe("running");
    expect(payload.message).toBe("Claude is running asynchronously. The MCP call is complete.");
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0].prompt).toBe("Build the feature");
    expect(fake.calls[0].options).toMatchObject({
      cwd: "/tmp/project",
      model: "claude-opus-4-6",
      effort: "high",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });

    const status = await client.callTool({
      name: "claude-status",
      arguments: { session_id: payload.session_id },
    });
    expect(structured(status)).toMatchObject({
      session_id: payload.session_id,
      status: "running",
      origin: {
        sessionId: "codex-session",
        threadId: "codex-thread",
        turnId: "codex-turn",
      },
    });
  });

  it("records status, todos, and problems reported by Claude", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const { client } = await connect(instance.server);
    const started = structured(
      await client.callTool({ name: "claude", arguments: { prompt: "Work through this" } }),
    );
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const reporter = fake.calls[0].options?.mcpServers?.async_claude_status;
    if (!reporter || reporter.type !== "sdk") throw new Error("Missing SDK reporter server.");
    const reporterClient = await connect(reporter.instance);

    await reporterClient.client.callTool({
      name: "report_status",
      arguments: {
        summary: "Implementing tests",
        todos: [
          { content: "Implement server", status: "completed" },
          { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
        ],
      },
    });
    await reporterClient.client.callTool({
      name: "report_problem",
      arguments: {
        message: "Fixture is incomplete",
        details: "The expected response is missing.",
        blocking: false,
      },
    });

    const status = structured(
      await client.callTool({
        name: "claude-status",
        arguments: { session_id: started.session_id },
      }),
    );
    expect(status.status_summary).toBe("Implementing tests");
    expect(status.todos).toEqual([
      { content: "Implement server", status: "completed" },
      { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
    ]);
    expect(status.problems).toEqual([
      expect.objectContaining({
        message: "Fixture is incomplete",
        details: "The expected response is missing.",
        blocking: false,
      }),
    ]);
  });

  it("records completion and continues the same Claude session asynchronously", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const { client } = await connect(instance.server);
    const started = structured(
      await client.callTool({ name: "claude", arguments: { prompt: "First turn" } }),
    );
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

    fake.runs[0].resolve([successResult("claude-session-1", "First result")]);
    await vi.waitFor(() =>
      expect(instance.store.require(started.session_id).status).toBe("completed"),
    );

    const completed = structured(
      await client.callTool({
        name: "claude-status",
        arguments: { session_id: started.session_id },
      }),
    );
    expect(completed).toMatchObject({
      claude_session_id: "claude-session-1",
      status: "completed",
      result: { text: "First result" },
    });

    const continued = structured(
      await client.callTool({
        name: "claude-continue",
        arguments: { session_id: started.session_id, prompt: "Second turn" },
      }),
    );
    expect(continued).toMatchObject({
      session_id: started.session_id,
      status: "running",
      turn: 2,
    });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]).toMatchObject({
      prompt: "Second turn",
      options: { resume: "claude-session-1" },
    });
  });

  it("reports Agent SDK errors without leaving the session running", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const { client } = await connect(instance.server);
    const started = structured(
      await client.callTool({ name: "claude", arguments: { prompt: "Fail" } }),
    );
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

    fake.runs[0].reject(new Error("authentication failed"));
    await vi.waitFor(() => expect(instance.store.require(started.session_id).status).toBe("failed"));

    const status = structured(
      await client.callTool({
        name: "claude-status",
        arguments: { session_id: started.session_id },
      }),
    );
    expect(status).toMatchObject({ status: "failed", error: "authentication failed" });
  });

  it("aborts background Claude work when the MCP transport closes", async () => {
    const fake = new FakeClaude();
    const instance = createTestServer(fake);
    const connected = await connect(instance.server);
    await connected.client.callTool({ name: "claude", arguments: { prompt: "Keep working" } });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    await connected.close();

    expect(fake.calls[0].options?.abortController?.signal.aborted).toBe(true);
  });

  function createTestServer(fake: FakeClaude): AsyncClaudeServer {
    const instance = createServer(
      { permissionMode: "bypassPermissions" },
      { queryFactory: fake.query },
    );
    servers.push(instance);
    return instance;
  }

  async function connect(server: McpServer): Promise<ConnectedClient> {
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const connected = {
      client,
      close: async () => {
        await client.close();
      },
    };
    clients.push(connected);
    return connected;
  }
});

function structured(result: unknown): Record<string, any> {
  const value = result as { structuredContent?: Record<string, unknown> };
  if (!value.structuredContent) throw new Error("Expected structured content.");
  return value.structuredContent;
}

function successResult(sessionId: string, result: string): SDKMessage {
  return {
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
  } as unknown as SDKMessage;
}
