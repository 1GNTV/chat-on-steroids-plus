# Chat On Steroids Plus

**Connect ChatGPT to a project on your computer with one command.**

Chat On Steroids Plus keeps the original Chat On Steroids project and adds a lightweight remote coding bridge. Your computer runs the tools; ChatGPT gets a tiny CLI client. A free Cloudflare Quick Tunnel links the two, so there is no port forwarding, VPS, domain, or extra subscription.

## 1. Install on your computer

Requirements: **Node.js 20+**, npm and Git.

### Windows

Open PowerShell:

```powershell
irm https://raw.githubusercontent.com/1GNTV/chat-on-steroids-plus/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/1GNTV/chat-on-steroids-plus/main/install.sh | sh
```

The installer can be run again later to update COS+.

## 2. Share one project

Open a terminal in the project you want ChatGPT to work on:

```bash
cd /path/to/my-project
cos-plus start .
```

On first use, COS+ automatically downloads the official `cloudflared` binary if it is not already installed. It then starts a local bridge, creates a free temporary Quick Tunnel, and prints **one command**.

It looks like this:

```text
COS+ ready

Workspace: /path/to/my-project
Tunnel:    https://random-words.trycloudflare.com

Give ChatGPT this exact command:

npm install --global https://github.com/1GNTV/chat-on-steroids-plus/archive/refs/heads/cos-plus-client.tar.gz && cos-plus connect cosplus://v1/...
```

Paste that command into ChatGPT and ask it to run it. After that, the agent can use `cos-plus` to work on the selected project.

Run `cos-plus start .` again at any time to reprint the current connection command.

## 3. Stop access

```bash
cos-plus stop
```

That stops the Quick Tunnel and the local bridge. A future start creates a fresh secret.

Check status with:

```bash
cos-plus status
```

## Agent tools

The remote agent gets these actions:

| Tool | What it does |
| --- | --- |
| `read` | Read text files, line ranges, or list a directory |
| `find` | Search text across the workspace |
| `apply_patch` | Create/edit/delete files with a validated unified patch |
| `exec_command` | Start a shell command in the workspace |
| `write_stdin` | Read more output from or send input to a running command |
| `processes` | List command sessions started through COS+ |
| `kill` | Stop a command session |

There is also `capabilities` so the client can discover the available tool surface.

## How it works

```text
ChatGPT environment
      |
      | cos-plus client (HTTPS + secret)
      v
*.trycloudflare.com
      |
      | Cloudflare Quick Tunnel
      v
127.0.0.1 on your computer
      |
      v
COS+ Agent Bridge
      |
      +-- files in the selected workspace
      +-- shell processes started in that workspace
```

Both local servers bind only to `127.0.0.1`. `cloudflared` makes the outbound tunnel connection; you do not open a router port.

Quick Tunnels are an official Cloudflare development/testing feature and do not require a Cloudflare account. They are temporary and have no uptime SLA, so the public URL can change when COS+ is restarted.


## MCP-like protocol mode

COS+ V3 keeps the simple commands, but also exposes an MCP-like protocol surface so an agent can discover tools instead of relying on hard-coded CLI knowledge.

```bash
cos-plus initialize
cos-plus tools
cos-plus call-tool read '{"path":"package.json"}'
```

The tool registry contains names, descriptions, JSON Schemas and annotations. Calls return typed `content`, `structuredContent`, `isError` and stable error codes.

Resources are discoverable too:

```bash
cos-plus resources
cos-plus read-resource resource://workspace/tree
cos-plus read-resource resource://git/status
cos-plus read-resource resource://git/diff
cos-plus read-resource resource://project/metadata
```

Persistent command sessions also appear as tasks:

```bash
cos-plus tasks
cos-plus task process:1 --yield-ms 1000
cos-plus cancel process:1
```

For a protocol-oriented agent, `cos-plus agent` exposes newline-delimited JSON-RPC 2.0 over stdin/stdout. Supported methods are `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `tasks/list`, `tasks/get`, `tasks/cancel`, and `ping`.

This is intentionally **MCP-like rather than a native MCP transport**: the agent still reaches COS+ through the tiny CLI + HTTPS tunnel, but discovery, schemas, invocation, typed results, resources and task lifecycle now follow the same style of interaction.

## Security

The connection string printed by `cos-plus start` is a **secret capability**. Anyone who has it while the host is running can use the exposed tools. Do not post it publicly.

Filesystem operations are restricted to the workspace selected at startup, including canonical-path checks against `..` traversal and symlink escapes.

`exec_command` is intentionally powerful: commands run with the permissions of your normal OS user. It is **not** an OS sandbox. Only connect an agent you trust.

Traffic to the public endpoint uses HTTPS and every request requires the random 256-bit bridge secret. COS+ does not run a paid relay server of its own.

## Local-only mode

You can still use the bridge without exposing a tunnel:

```bash
agent-bridge start --root . --local
```

The local daemon listens only on loopback.

## Development

The additions are isolated from the upstream Electron application:

```text
agent-bridge/    host + local daemon + Quick Tunnel launcher
remote-client/   tiny client installed in the agent environment
```

Run the tests with:

```bash
cd agent-bridge && npm test
cd ../remote-client && npm test
```

## Upstream and license

This repository is a fork of [totec448-spec/chat-on-steroids](https://github.com/totec448-spec/chat-on-steroids). The upstream project and this fork are distributed under the MIT License; see [`LICENSE`](./LICENSE).

Chat On Steroids Plus is an independent fork and is not an official OpenAI product.
