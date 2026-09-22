export function decodeConnection(value) {
  if (typeof value !== 'string' || !value.startsWith('cosplus://v1/')) {
    throw new Error('Invalid COS+ connection string');
  }
  const encoded = value.slice('cosplus://v1/'.length);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid COS+ connection string');
  }
  if (parsed?.v !== 1 || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
    throw new Error('Invalid COS+ connection payload');
  }
  const url = new URL(parsed.url);
  if (url.protocol !== 'https:') throw new Error('COS+ remote URL must use HTTPS');
  return { url: url.origin, token: parsed.token };
}

export async function remoteCall(config, action, args = {}, timeoutMs = 35_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}/v1/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({ action, args }),
      signal: controller.signal
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error(`COS+ host returned HTTP ${response.status}`); }
    if (!response.ok || !payload?.ok) {
      const remote = payload?.error;
      const error = new Error(typeof remote === 'string' ? remote : remote?.message || `COS+ host returned HTTP ${response.status}`);
      if (remote?.code) error.code = remote.code;
      if (remote?.data !== undefined) error.data = remote.data;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}
