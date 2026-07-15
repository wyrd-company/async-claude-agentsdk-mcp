import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ClaudeRunner, type ClaudeQueryFactory, type RunnerEvent } from "./claude-runner.js";
import type { ServerConfig } from "./config.js";
import { SessionStore, type CodexOrigin, type SessionRecord } from "./session-store.js";

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

const startShape = {
  prompt: z.string().min(1).describe("Prompt to send to Claude."),
  model: z.string().min(1).optional().describe("Claude model override for this session."),
  effort: effortSchema.optional().describe("Reasoning effort for this session."),
  cwd: z.string().min(1).optional().describe("Working directory for Claude."),
};

const continueShape = {
  session_id: z.string().uuid().describe("Session handle returned by claude."),
  prompt: z.string().min(1).describe("Prompt for the next turn in the completed session."),
};

const statusShape = {
  session_id: z.string().uuid().describe("Session handle returned by claude."),
};

export type CreateServerOptions = {
  queryFactory?: ClaudeQueryFactory;
  store?: SessionStore;
};

export type AsyncClaudeServer = {
  server: McpServer;
  store: SessionStore;
  runner: ClaudeRunner;
};

export function createServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): AsyncClaudeServer {
  const server = new McpServer(
    { name: "async-claude-agentsdk-mcp", version: "0.1.0" },
    {
      capabilities: { logging: {}, tools: {} },
      instructions:
        "Use claude to start a Claude sub-agent and continue your own work immediately. The call returns a session handle without waiting for Claude. Use claude-status for an immediate snapshot when useful. Use claude-continue only after the previous turn is completed.",
    },
  );
  const store = options.store ?? new SessionStore();
  const runner = new ClaudeRunner(store, config, {
    queryFactory: options.queryFactory,
    onEvent: (event) => sendEventNotification(server, event),
  });

  server.tool(
    "claude",
    "Start a Claude Agent SDK session in the background and immediately return its session handle.",
    startShape,
    async ({ prompt, model, effort, cwd }, extra) => {
      const session = store.create({
        prompt,
        model,
        effort,
        cwd,
        origin: codexOrigin(extra._meta),
      });
      runner.start(session.id, prompt);
      return jsonResult(startPayload(session));
    },
  );

  server.tool(
    "claude-continue",
    "Start another background turn in a completed Claude session and immediately return.",
    continueShape,
    async ({ session_id, prompt }) => {
      const existing = store.get(session_id);
      if (!existing) return errorResult(`Unknown session: ${session_id}`);

      try {
        const claudeSessionId = existing.claudeSessionId;
        const session = store.beginContinuation(session_id, prompt);
        runner.start(session.id, prompt, claudeSessionId);
        return jsonResult(startPayload(session));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    "claude-status",
    "Return an immediate snapshot of a Claude session, including current todos and reported problems.",
    statusShape,
    async ({ session_id }) => {
      const session = store.get(session_id);
      if (!session) return errorResult(`Unknown session: ${session_id}`);
      return jsonResult(statusPayload(session));
    },
  );

  let servicesClosed = false;
  const closeServices = () => {
    if (servicesClosed) return;
    servicesClosed = true;
    runner.close();
  };
  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    originalOnClose?.();
    closeServices();
  };
  const originalClose = server.close.bind(server);
  server.close = async () => {
    closeServices();
    await originalClose();
  };

  return { server, store, runner };
}

function startPayload(session: SessionRecord): Record<string, unknown> {
  return {
    session_id: session.id,
    status: session.status,
    turn: session.turn,
    message: "Claude is running asynchronously. The MCP call is complete.",
  };
}

function statusPayload(session: SessionRecord): Record<string, unknown> {
  return compact({
    session_id: session.id,
    claude_session_id: session.claudeSessionId,
    status: session.status,
    turn: session.turn,
    model: session.model,
    effort: session.effort,
    cwd: session.cwd,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    status_summary: session.statusSummary,
    todos: session.todos,
    problems: session.problems,
    result: session.result,
    error: session.error,
    origin: session.origin,
  });
}

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function codexOrigin(meta: Record<string, unknown> | undefined): CodexOrigin | undefined {
  if (!meta) return undefined;
  const turnMeta = asRecord(meta["x-codex-turn-metadata"]);
  const origin = compact({
    sessionId: stringValue(turnMeta?.session_id),
    threadId: stringValue(turnMeta?.thread_id) ?? stringValue(meta.threadId),
    turnId: stringValue(turnMeta?.turn_id),
  });
  return Object.keys(origin).length > 0 ? origin : undefined;
}

async function sendEventNotification(server: McpServer, event: RunnerEvent): Promise<void> {
  const latestProblem = event.session.problems.at(-1);
  await server.server.sendLoggingMessage({
    level:
      event.type === "failed" ? "error" : event.type === "problem" ? "warning" : "info",
    logger: "async-claude-agentsdk-mcp",
    data: compact({
      session_id: event.session.id,
      claude_session_id: event.session.claudeSessionId,
      event: event.type,
      status: event.session.status,
      turn: event.session.turn,
      summary: event.session.statusSummary,
      problem: event.type === "problem" ? latestProblem : undefined,
      error: event.session.error,
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
