import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import {
  SessionStore,
  type SessionRecord,
} from "./session-store.js";

const STATUS_SERVER_NAME = "async_claude_status";
const STATUS_TOOL_NAME = `mcp__${STATUS_SERVER_NAME}__report_status`;
const PROBLEM_TOOL_NAME = `mcp__${STATUS_SERVER_NAME}__report_problem`;

const todoSchema = z.object({
  content: z.string().min(1).describe("A concise description of the task."),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z
    .string()
    .min(1)
    .optional()
    .describe("Present-tense description shown while the task is in progress."),
});

export type ClaudeQueryInput = {
  prompt: string;
  options?: Options;
};

export type ClaudeQueryFactory = (input: ClaudeQueryInput) => AsyncIterable<SDKMessage>;

export type RunnerEvent =
  | { type: "status"; session: SessionRecord }
  | { type: "problem"; session: SessionRecord }
  | { type: "completed"; session: SessionRecord }
  | { type: "failed"; session: SessionRecord };

export type ClaudeRunnerOptions = {
  queryFactory?: ClaudeQueryFactory;
  onEvent?: (event: RunnerEvent) => void | Promise<void>;
};

export class ClaudeRunner {
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly onEvent?: ClaudeRunnerOptions["onEvent"];
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;

  constructor(
    private readonly store: SessionStore,
    private readonly config: ServerConfig,
    options: ClaudeRunnerOptions = {},
  ) {
    this.queryFactory = options.queryFactory ?? query;
    this.onEvent = options.onEvent;
  }

  start(sessionId: string, prompt: string, resume?: string): void {
    if (this.closed) throw new Error("Claude runner is closed.");

    queueMicrotask(() => {
      if (this.closed) return;
      void this.run(sessionId, prompt, resume);
    });
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private async run(sessionId: string, prompt: string, resume?: string): Promise<void> {
    const session = this.store.require(sessionId);
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    let receivedResult = false;

    try {
      const reporter = this.createReporter(sessionId);
      const stream = this.queryFactory({
        prompt,
        options: {
          abortController: controller,
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: this.config.permissionMode,
          allowDangerouslySkipPermissions:
            this.config.permissionMode === "bypassPermissions" ? true : undefined,
          resume,
          mcpServers: { [STATUS_SERVER_NAME]: reporter },
          allowedTools: [STATUS_TOOL_NAME, PROBLEM_TOOL_NAME],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "Use the async_claude_status MCP tools to report meaningful progress. Call report_status when your task list or current focus changes. Call report_problem for risks, blockers, or failures the caller should know about. These reports are non-blocking; continue working unless the task itself cannot proceed.",
          },
        },
      });

      for await (const message of stream) {
        this.captureSessionId(sessionId, message);
        this.captureNativeTodos(sessionId, message);

        if (message.type === "result") {
          receivedResult = true;
          await this.finishFromResult(sessionId, message);
          break;
        }
      }

      if (!receivedResult && !controller.signal.aborted) {
        const failed = this.store.fail(
          sessionId,
          "Claude Agent SDK stream ended without a result message.",
        );
        await this.emit({ type: "failed", session: failed });
      }
    } catch (error) {
      if (
        !receivedResult &&
        !this.closed &&
        this.controllers.get(sessionId) === controller
      ) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.store.fail(sessionId, message);
        await this.emit({ type: "failed", session: failed });
      }
    } finally {
      if (this.controllers.get(sessionId) === controller) {
        this.controllers.delete(sessionId);
      }
    }
  }

  private createReporter(sessionId: string) {
    return createSdkMcpServer({
      name: STATUS_SERVER_NAME,
      version: "0.1.0",
      alwaysLoad: true,
      instructions:
        "Report task status and caller-relevant problems while you work. Reports are recorded for asynchronous callers and never wait for a response.",
      tools: [
        tool(
          "report_status",
          "Record the current focus and complete task list for the asynchronous caller.",
          {
            summary: z.string().min(1).optional().describe("Current focus or progress summary."),
            todos: z
              .array(todoSchema)
              .optional()
              .describe("The complete current todo list. Pass an empty list to clear it."),
          },
          async ({ summary, todos }) => {
            const updated = this.store.reportStatus(sessionId, { summary, todos });
            await this.emit({ type: "status", session: updated });
            return callbackResult("Status recorded.");
          },
        ),
        tool(
          "report_problem",
          "Record a risk, blocker, or failure for the asynchronous caller.",
          {
            message: z.string().min(1).describe("Concise problem statement."),
            details: z.string().min(1).optional().describe("Diagnostic context or impact."),
            blocking: z
              .boolean()
              .default(false)
              .describe("Whether this prevents the requested task from completing."),
          },
          async ({ message, details, blocking }) => {
            const updated = this.store.reportProblem(sessionId, { message, details, blocking });
            await this.emit({ type: "problem", session: updated });
            return callbackResult("Problem recorded.");
          },
        ),
      ],
    });
  }

  private captureSessionId(sessionId: string, message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") {
      this.store.setClaudeSessionId(sessionId, message.session_id);
    }
  }

  private captureNativeTodos(sessionId: string, message: SDKMessage): void {
    if (message.type !== "assistant") return;

    for (const block of message.message.content) {
      if (block.type !== "tool_use" || block.name !== "TodoWrite") continue;
      const input = block.input as { todos?: unknown };
      const parsed = z.array(todoSchema).safeParse(input.todos);
      if (parsed.success) this.store.reportStatus(sessionId, { todos: parsed.data });
    }
  }

  private async finishFromResult(sessionId: string, result: SDKResultMessage): Promise<void> {
    if (result.subtype === "success") {
      const completed = this.store.complete(sessionId, {
        text: result.result,
        durationMs: result.duration_ms,
        durationApiMs: result.duration_api_ms,
        turns: result.num_turns,
        totalCostUsd: result.total_cost_usd,
        stopReason: result.stop_reason,
      });
      await this.emit({ type: "completed", session: completed });
      return;
    }

    const error = result.errors.join("\n").trim() || `Claude ended with ${result.subtype}.`;
    const failed = this.store.fail(sessionId, error);
    await this.emit({ type: "failed", session: failed });
  }

  private async emit(event: RunnerEvent): Promise<void> {
    try {
      await this.onEvent?.(event);
    } catch {
      // Notification delivery is best effort and must not change session state.
    }
  }
}

function callbackResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
