# COS+ Agent Bridge

Host-side bridge for Chat On Steroids Plus.

```bash
cos-plus start /path/to/project
```

This starts the local coding daemon and a free Cloudflare Quick Tunnel, then prints the exact client command to give to ChatGPT.

Use `cos-plus stop` to revoke the current remote connection. Use `agent-bridge start --root . --local` for loopback-only operation.
