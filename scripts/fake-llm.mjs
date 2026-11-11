/**
 * 假 LLM 服务：只实现协议，不实现模型。
 * 用来验证 Ollama(/api/chat, NDJSON) 与 OpenAI 兼容(/v1/chat/completions, SSE)
 * 两条接入路径的流式解析是否正确——不需要真的装模型。
 */

import http from 'node:http';

const PORT = Number(process.env.FAKE_PORT || 11499);
const REPLY = '这话我听着有点意外<e:surprise:0.8><g:camera>。你再说说细节<e:thinking:0.5>？';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function* chunks(text, n = 3) {
  for (let i = 0; i < text.length; i += n) yield text.slice(i, i + n);
}

async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ models: [{ name: 'fake-qwen:4b', size: 1 }] })
      );
      return;
    }

    if (url.pathname === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      if (!body.messages || !body.messages[0] || body.messages[0].role !== 'system') {
        res.writeHead(400).end('missing system prompt');
        return;
      }
      if (!body.stream) {
        res.writeHead(400).end('expected stream:true');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const c of chunks(REPLY)) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: c }, done: false }) + '\n');
        await sleep(20);
      }
      res.write(JSON.stringify({ done: true }) + '\n');
      res.end();
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      if (!req.headers.authorization) {
        res.writeHead(401).end('no auth');
        return;
      }
      if (!body.stream) {
        res.writeHead(400).end('expected stream:true');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks(REPLY)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        await sleep(20);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404).end('nope');
  })
  .listen(PORT, '127.0.0.1', () => console.log(`fake-llm on ${PORT}`));
