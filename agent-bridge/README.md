# Agent Bridge

Agent Bridge is the lightweight local coding layer added by Chat On Steroids Plus.
It exposes filesystem, patching and persistent terminal operations through a small
JSON-friendly CLI, so a local agent that can run commands can use the same kind of
primitives normally exposed by a coding MCP.

## Commands

- `read` - bounded file reads and directory listings
- `find` - ripgrep when available, with a Node fallback
- `apply-patch` - validate and apply unified git patches
- `exec` - start a command in the persistent daemon
- `write-stdin` - poll or write to an existing process
- `processes` / `kill` - inspect and stop process sessions

Filesystem operations are confined to the selected workspace root. Shell commands
run with the permissions of your normal user account and are not an OS sandbox.

Run `agent-bridge --help` after installation for the complete CLI.
