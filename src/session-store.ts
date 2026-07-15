import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export type SessionStatus = "running" | "completed" | "failed";
export type TodoStatus = "pending" | "in_progress" | "completed";

export type SessionTodo = {
  content: string;
  status: TodoStatus;
  activeForm?: string;
};

export type SessionProblem = {
  message: string;
  details?: string;
  blocking: boolean;
  reportedAt: string;
};

export type SessionResult = {
  text: string;
  durationMs: number;
  durationApiMs: number;
  turns: number;
  totalCostUsd: number;
  stopReason: string | null;
};

export type CodexOrigin = {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
};

export type SessionRecord = {
  id: string;
  claudeSessionId?: string;
  status: SessionStatus;
  turn: number;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  statusSummary?: string;
  todos: SessionTodo[];
  problems: SessionProblem[];
  result?: SessionResult;
  error?: string;
  origin?: CodexOrigin;
};

export type CreateSessionInput = Pick<SessionRecord, "prompt" | "model" | "effort" | "cwd" | "origin">;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      ...input,
      id: crypto.randomUUID(),
      status: "running",
      turn: 1,
      createdAt: now,
      updatedAt: now,
      todos: [],
      problems: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  require(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  setClaudeSessionId(id: string, claudeSessionId: string): SessionRecord {
    return this.update(id, { claudeSessionId });
  }

  reportStatus(id: string, input: { summary?: string; todos?: SessionTodo[] }): SessionRecord {
    return this.update(id, {
      ...(input.summary !== undefined ? { statusSummary: input.summary } : {}),
      ...(input.todos ? { todos: input.todos } : {}),
    });
  }

  reportProblem(
    id: string,
    input: { message: string; details?: string; blocking?: boolean },
  ): SessionRecord {
    const session = this.require(id);
    const problem: SessionProblem = {
      message: input.message,
      details: input.details,
      blocking: input.blocking ?? false,
      reportedAt: new Date().toISOString(),
    };
    return this.update(id, { problems: [...session.problems, problem] });
  }

  complete(id: string, result: SessionResult): SessionRecord {
    return this.update(id, { status: "completed", result, error: undefined });
  }

  fail(id: string, error: string): SessionRecord {
    return this.update(id, { status: "failed", error, result: undefined });
  }

  beginContinuation(id: string, prompt: string): SessionRecord {
    const session = this.require(id);
    if (session.status !== "completed") {
      throw new Error(
        `Session ${id} is ${session.status}; only completed sessions can be continued.`,
      );
    }
    if (!session.claudeSessionId) {
      throw new Error(`Session ${id} does not have a resumable Claude session id.`);
    }

    return this.update(id, {
      status: "running",
      turn: session.turn + 1,
      prompt,
      statusSummary: undefined,
      result: undefined,
      error: undefined,
    });
  }

  private update(
    id: string,
    patch: Partial<Omit<SessionRecord, "id" | "createdAt">>,
  ): SessionRecord {
    const session = this.require(id);
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    return session;
  }
}
