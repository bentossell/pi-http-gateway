# pi-http-gateway

Turn any running [pi](https://github.com/badlogic/pi-mono/) session into an HTTP gateway. Post prompts from anywhere — phone, Shortcuts, webhooks, other agents — all feeding into the same living session.

Like [OpenClaw](https://github.com/openclaw/openclaw)'s gateway architecture, but using pi as the agent runtime. One prompt at a time, serialized per session.

## Install

```
pi install npm:pi-http-gateway
```

Or load directly:

```bash
pi -e ./index.ts
```

## How it works

Pi starts normally with the full TUI. The extension starts an HTTP server in-process on `:3141`. External clients POST prompts → queued FIFO → injected via `pi.sendUserMessage()` → response captured and returned.

```
┌──────────────────────────────────────┐
│           pi (interactive TUI)       │
│                                      │
│   ┌──────────────────────────────┐   │
│   │  pi-http-gateway extension   │   │
│   │  HTTP server :3141           │   │
│   │  POST /prompt                │   │
│   │  GET  /status                │   │
│   │  GET  /health                │   │
│   │  GET  /history               │   │
│   └──────────┬───────────────────┘   │
│              ▼                        │
│   pi.sendUserMessage() → agent loop  │
└──────────────────────────────────────┘
         │
         │ tailscale serve :3141
         ▼
   https://your-machine.ts.net
```

## Usage

```bash
# Send a prompt (sync — waits for response)
curl -X POST http://localhost:3141/prompt \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{"prompt": "check build status"}'

# Fire and forget
curl -X POST http://localhost:3141/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "analyze logs", "mode": "fire"}'

# Check status
curl http://localhost:3141/status

# Recent jobs
curl http://localhost:3141/history

# Specific job
curl http://localhost:3141/job/abc123
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check → `{"ok": true}` |
| `GET` | `/status` | Queue depth, active job, uptime |
| `POST` | `/prompt` | Send prompt (`sync` or `fire` mode) |
| `GET` | `/history` | Last 50 jobs |
| `GET` | `/job/:id` | Specific job result |

### POST /prompt

```json
{
  "prompt": "do something useful",
  "mode": "sync"
}
```

- `sync` (default): waits for agent to complete, returns full response
- `fire`: returns immediately with job ID, processes in background

## Auth

Set `GATEWAY_TOKEN` env var. All endpoints require `Authorization: Bearer <token>`. If unset, gateway runs open (local-only use).

## Config

| Env var | Default | Description |
|---------|---------|-------------|
| `GATEWAY_PORT` | `3141` | HTTP port |
| `GATEWAY_TOKEN` | (none) | Bearer token for auth |
| `GATEWAY_MAX_QUEUE` | `10` | Max queued prompts |
| `GATEWAY_LOG` | `~/.pi/gateway-log.jsonl` | Job log path |

## Pair with pi-schedule-prompt

```bash
pi install npm:pi-schedule-prompt
pi install npm:pi-http-gateway
```

Now your pi session has:
- **Heartbeat**: scheduled/recurring prompts (cron, intervals, reminders)
- **Gateway**: on-demand prompts from anywhere via HTTP

Both feed into the same interactive session.

## Expose via Tailscale

```bash
tailscale serve --bg 3141
```

Accessible from phone/anywhere on your tailnet.

## TUI integration

- Status bar shows `⚡ :3141`
- Widget below editor shows gateway state + current job
- `/gateway` command shows status and recent jobs

## License

MIT
