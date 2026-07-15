# async-claude-agentsdk-mcp

An MCP server that lets coding agents run Claude Agent SDK sessions as asynchronous sub-agents.

`claude` and `claude-continue` return as soon as the background turn is scheduled. They never hold an MCP request open while Claude works. `claude-status` is an immediate point-in-time read of the in-memory session state.

## Tools

### `claude`

Starts a new Claude session and immediately returns a wrapper-owned `session_id`.

Inputs:

- `prompt` (required): the task for Claude;
- `model` (optional): a Claude model override;
- `effort` (optional): `low`, `medium`, `high`, `xhigh`, or `max`;
- `cwd` (optional): the working directory for the session.

Example result:

```json
{
  "session_id": "0bd9d545-6016-4a5e-89b7-93f85a059f38",
  "status": "running",
  "turn": 1,
  "message": "Claude is running asynchronously. The MCP call is complete."
}
```

### `claude-continue`

Starts another background turn in a completed session. It keeps the wrapper `session_id` and resumes the underlying Claude Agent SDK session.

Inputs:

- `session_id` (required): the handle returned by `claude`;
- `prompt` (required): the next prompt.

Continuation is rejected while the preceding turn is running or if it failed without producing a resumable Claude session.

### `claude-status`

Returns the current state without waiting for a change. The response includes:

- lifecycle status: `running`, `completed`, or `failed`;
- the underlying Claude session ID once the SDK reports it;
- the latest status summary and todo list reported by Claude;
- caller-relevant problems reported by Claude;
- the latest completed result or failure;
- originating Codex session, thread, and turn IDs when Codex supplied them in MCP `_meta`.

## Claude status reporting

Every Claude run receives an in-process MCP server with two tools:

- `report_status`: replaces the current todo list and optionally records the current focus;
- `report_problem`: appends a risk, blocker, or failure for the caller.

The tools only update session state and send best-effort MCP logging notifications. They do not block Claude waiting for the caller. Native `TodoWrite` calls are also captured when present in the Agent SDK message stream.

## Permissions

The default permission mode is `bypassPermissions`. This intentionally gives Claude unrestricted tool execution in its environment and requires the Agent SDK's `allowDangerouslySkipPermissions` acknowledgement.

Set `ASYNC_CLAUDE_MCP_PERMISSION_MODE` to change it:

```bash
export ASYNC_CLAUDE_MCP_PERMISSION_MODE=default
```

Accepted values are `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, and `auto`.

## Install and run

```bash
npm install
npm run build
node dist/src/cli.js
```

Example Codex configuration:

```toml
[mcp_servers.async_claude]
command = "node"
args = ["/absolute/path/to/async-claude-agentsdk-mcp/dist/src/cli.js"]
```

The server uses stdio and writes protocol messages only to stdout. Claude Agent SDK authentication and settings are inherited from the server process environment.

Session records are in memory. They survive multiple MCP tool calls and Claude turns while the stdio server remains running, but they do not survive a server restart.

## Development

```bash
npm test
npm run build
```
