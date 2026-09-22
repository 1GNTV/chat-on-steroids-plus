# COS+ Remote Client

Tiny zero-dependency command-line client used by ChatGPT to call a COS+ host over HTTPS.

Normally you do not install this manually. `cos-plus start` on the host computer prints the exact command to give ChatGPT.

## MCP-like V3

After connecting, the agent can run `cos-plus initialize`, `cos-plus tools`, `cos-plus resources`, task commands, or `cos-plus agent` for newline-delimited JSON-RPC 2.0 over stdin/stdout.
