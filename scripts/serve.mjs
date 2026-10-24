import http from 'node:http';
import worker from '../dist/server/index.js';
const origin = 'http://127.0.0.1:8787';
// Explicit allowlist: runtime configuration stays in this process, never assets.
const env = Object.fromEntries(['PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','AI_PROVIDER','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','OPENAI_API_KEY','OPENAI_MODEL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
http.createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== '127.0.0.1:8787') {
      outgoing.writeHead(403).end('Use the loopback URL'); return;
    }
    const chunks = []; let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 2097152) { outgoing.writeHead(413).end('Request too large'); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    // Never trust or fabricate a platform identity. Capabilities are not identity.
    headers.delete('oai-authenticated-user-id');
    const method = incoming.method || 'GET';
    const response = await worker.fetch(new Request(new URL(incoming.url, origin), {
      method, headers,
      ...(['GET','HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) })
    }), env, {});
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500).end('Local request failed');
  }
}).listen(8787, '127.0.0.1', () => console.log(`Open ${origin}`));
