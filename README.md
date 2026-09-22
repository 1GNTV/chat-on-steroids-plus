# Chat On Steroids Plus

A fork of [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) with an additional local CLI bridge for coding workflows.

The original Chat On Steroids application is still here. **Plus** adds `Agent Bridge`: a small local daemon + command-line interface that exposes the useful coding primitives without requiring the caller to speak MCP.

## Install Agent Bridge

Requirements: **Node.js 20+**, npm and Git.

### Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/1GNTV/chat-on-steroids-plus/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/1GNTV/chat-on-steroids-plus/main/install.sh | sh
```

The installer clones/updates this repository in `~/.chat-on-steroids-plus` and installs the lightweight `agent-bridge` command globally with npm. Re-running the installer updates the existing installation.

If you prefer not to pipe a remote script into your shell, clone the repository and install manually:

```bash
git clone https://github.com/1GNTV/chat-on-steroids-plus.git
cd chat-on-steroids-plus/agent-bridge
npm install -g .
```

## 30-second start

Go to the project you want the agent to work on:

```bash
cd /path/to/my-project
agent-bridge start --root .
agent-bridge capabilities
```

Then the local coding surface is available:

```bash
agent-bridge read src/App.tsx --start-line 1 --end-line 120
agent-bridge find "useEffect" src
agent-bridge exec --cmd "npm test"
```

Long-running commands stay alive in the daemon. `exec` returns a `session_id`; use it to poll output later:

```bash
agent-bridge write-stdin 1 --yield-ms 1000
```

or send interactive input:

```bash
agent-bridge write-stdin 1 --chars "y\n"
```

For agents, there is also one generic JSON entrypoint:

```bash
agent-bridge call '{"action":"read","args":{"path":"package.json"}}'
```

Available actions in the first version are:

- `read` - files, line ranges and directory listings
- `find` - repository text search
- `apply_patch` - validated unified patches through `git apply`
- `exec_command` - persistent shell commands
- `write_stdin` - poll/send input to a running command
- `processes` and `kill` - process session management

## Why this exists

Chat On Steroids already contains a strong local coding engine, but its normal product architecture connects that engine through MCP, Electron and the browser integration. Agent Bridge provides a much smaller transport for environments that can already invoke a local command.

It is not an MCP bypass and does not change ChatGPT account capabilities or quotas. It simply provides local actions through a CLI/JSON interface.

## Security model

Filesystem actions are restricted to the workspace passed to `agent-bridge start --root ...` and canonical paths are checked to stop traversal outside that root.

`exec_command` is intentionally different: it launches a normal shell process with the permissions of your user account. The workspace controls its starting directory, but arbitrary shell commands are **not** an operating-system sandbox. Only let trusted agents use command execution.

The daemon listens only on `127.0.0.1` on a random local port and authenticates requests with a random token stored under the current user's home directory.

## Development

The bridge is intentionally isolated in `agent-bridge/` so upstream Chat On Steroids remains easy to sync.

```bash
cd agent-bridge
npm test
npm pack --dry-run
```

CI runs the bridge tests on Windows, macOS and Linux with Node 20 and 22.

## Upstream and license

This repository is a fork of [totec448-spec/chat-on-steroids](https://github.com/totec448-spec/chat-on-steroids). The upstream project and this fork are distributed under the MIT License; see [`LICENSE`](./LICENSE).

Chat On Steroids Plus is an independent fork and is not an official OpenAI product.
