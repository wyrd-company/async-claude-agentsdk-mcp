import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const PERMISSION_MODE_ENV = "ASYNC_CLAUDE_MCP_PERMISSION_MODE";

const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

export type ServerConfig = {
  permissionMode: PermissionMode;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = permissionModeSchema.safeParse(env[PERMISSION_MODE_ENV] ?? "bypassPermissions");
  if (!parsed.success) {
    throw new Error(
      `${PERMISSION_MODE_ENV} must be one of: ${permissionModeSchema.options.join(", ")}.`,
    );
  }

  return { permissionMode: parsed.data };
}
