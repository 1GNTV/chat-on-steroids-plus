import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { decodeConnection, remoteCall } from '../src/core.mjs';

let server;
let url;
const token = 'abc123';

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { action: body.action, args: body.args } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `https://example.test`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('decodeConnection decodes a valid bundle', () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://demo.trycloudflare.com', token }), 'utf8').toString('base64url');
  assert.deepEqual(decodeConnection(`cosplus://v1/${payload}`), {
    url: 'https://demo.trycloudflare.com',
    token
  });
});

test('decodeConnection rejects non-HTTPS endpoints', () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'http://example.com', token }), 'utf8').toString('base64url');
  assert.throws(() => decodeConnection(`cosplus://v1/${payload}`), /HTTPS/);
});

test('remoteCall sends bearer auth and JSON request', async () => {
  const address = server.address();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const rewritten = String(input).replace('https://example.test', `http://127.0.0.1:${address.port}`);
    return originalFetch(rewritten, init);
  };
  try {
    const result = await remoteCall({ url, token }, 'read', { path: 'README.md' });
    assert.equal(result.action, 'read');
    assert.equal(result.args.path, 'README.md');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
