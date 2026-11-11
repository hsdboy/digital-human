import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSystemPrompt } from './src/persona.js';

const execFileP = promisify(execFile);
const root = process.cwd();
const port = Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.wav': 'audio/wav',
};

// ---------------------------------------------------------------- LLM 提供方

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OLLAMA_MODEL_ENV = process.env.OLLAMA_MODEL || '';

let cache = { at: 0, value: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive(url, ms = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function resolveProvider() {
  const now = Date.now();
  if (cache.value && now - cache.at < 15000) return cache.value;

  const forced = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  let out;

  if (forced === 'mock') {
    out = { name: 'mock', model: null, hint: '内置模拟流，未连接真实模型' };
  } else if (forced === 'openai' || (!forced.startsWith('mock') && !forced.startsWith('ollama') && OPENAI_BASE)) {
    out = { name: 'openai', model: process.env.OPENAI_MODEL || 'qwen2.5:7b', base: OPENAI_BASE };
  } else if (forced === 'ollama') {
    out = { name: 'ollama', model: OLLAMA_MODEL_ENV, base: OLLAMA_URL };
  } else if (await alive(`${OLLAMA_URL}/api/tags`)) {
    out = { name: 'ollama', model: OLLAMA_MODEL_ENV, base: OLLAMA_URL };
  } else {
    out = {
      name: 'mock',
      model: null,
      hint: '未检测到本地模型。装 Ollama 后重启本服务即自动切换：brew install ollama && ollama pull qwen2.5:4b',
    };
  }

  if (out.name === 'ollama' && !out.model) {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`);
      const j = await r.json();
      const models = j.models || [];
      if (!models.length) {
        out.model = 'qwen2.5:4b';
        out.hint = `Ollama 已运行但没有模型，先执行 ollama pull qwen2.5:7b`;
      } else {
        // 别取第一个：机器上往往同时躺着几个尺寸，0.5B 那种连标签格式都守不住，
        // 拿它冒充"接入大模型"只会让人以为是表情层坏了。按体积挑最大的，
        // 但跳过明显非对话的（embedding 模型），它们的输出接不上标签协议。
        const chat = models.filter((m) => !/embed|bge|gte|rerank/i.test(m.name || ''));
        const pool = chat.length ? chat : models;
        pool.sort((a, b) => (b.size || 0) - (a.size || 0));
        out.model = pool[0].name;
      }
    } catch {
      out.name = 'mock';
      out.model = null;
    }
  }

  cache = { at: now, value: out };
  return out;
}

/** Ollama 原生 /api/chat，NDJSON 流 */
async function* streamOllama(cfg, messages) {
  const res = await fetch(`${cfg.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      // 默认 keep_alive 只有 5 分钟，7B 重新加载要好几秒，对话中途被
      // 卸载一次就是一次几秒的卡顿。常驻 30 分钟，代价只是占着不动。
      keep_alive: '30m',
      options: { temperature: 0.85, top_p: 0.9, repeat_penalty: 1.05, num_predict: 220 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status} ${(await res.text()).slice(0, 120)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const c = j.message && j.message.content;
        if (c) yield c;
      } catch {
        /* 忽略半行 */
      }
    }
  }
}

/** 任意 OpenAI 兼容端点（LM Studio / llama.cpp server / vLLM / 云端） */
async function* streamOpenAI(cfg, messages) {
  const res = await fetch(`${cfg.base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_KEY || 'none'}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: 0.85,
      max_tokens: 260,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status} ${(await res.text()).slice(0, 120)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (c) yield c;
      } catch {
        /* 忽略 */
      }
    }
  }
}

// ---------------------------------------------------------------- 模拟流
// 没有本地模型时用它跑通整条链路。刻意把标签切在 chunk 边界上，
// 用来验证前端解析器能跨块缓冲（真实模型也一定会这样切）。

const MOCK_SCRIPTS = [
  {
    match: /天气|下雨|晴|冷|热/,
    text: '外面挺好的，有点风<p:0.25>。你要出门的话<e:thinking:0.5>记得带件外套。',
  },
  {
    match: /累|烦|难过|压力|加班|老板|骂/,
    text: '听着就挺难受的<e:sadness:0.65><g:away>。是最近一直这样，还是就今天特别糟<e:thinking:0.5>？',
  },
  {
    match: /开心|好事|成功|升职|涨薪|赢了|通过/,
    text: '真的假的<e:surprise:0.8>？那太好了<e:joy:0.9>！<g:camera>快说说细节。',
  },
  {
    match: /你是谁|介绍|名字|叫什么/,
    text: '我就是<e:thinking:0.35>住在这块屏幕里的一个人<e:joy:0.45>。<g:camera>现在能看见表情，对吧？',
  },
  {
    match: /生气|讨厌|烦死|离谱/,
    text: '这确实有点过分了<e:anger:0.6><m:press:0.9>。你当时怎么回的？',
  },
  {
    match: /害怕|担心|焦虑|紧张/,
    text: '先别急<p:0.3>。<e:thinking:0.55><g:down>最坏的结果其实也没那么糟。',
  },
  {
    match: /彩票|中奖|发财|赚了|好运/,
    text: '天哪<e:surprise:0.9>！真的中奖了<e:joy:0.95><g:camera>？那不是得请我吃饭。',
  },
  {
    match: /吃|饭|饿|咖啡/,
    text: '我吃不了<e:sadness:0.4>，只能看着<e:joy:0.5>。你想吃什么？',
  },
];

const MOCK_FALLBACKS = [
  '嗯<p:0.2>，我在听<e:thinking:0.45>。你接着说。',
  '这个有意思<e:surprise:0.55>。<g:camera>你怎么想到的？',
  '我大概明白你的意思了<e:thinking:0.5>。不过<e:sadness:0.35>，这事是不是还有点别的顾虑？',
  '说实话<e:thinking:0.4>，我也没太想清楚<e:joy:0.3>。',
];

function mockReply(userText) {
  const s = String(userText || '');
  for (const m of MOCK_SCRIPTS) if (m.match.test(s)) return m.text;
  return MOCK_FALLBACKS[(Math.random() * MOCK_FALLBACKS.length) | 0];
}

/** MOCK_BARE=1：模拟一个"不打标签"的模型，用来验证纯文本推断 */
const MOCK_BARE = process.env.MOCK_BARE === '1';

async function* streamMock(cfg, messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  let text = mockReply(lastUser && lastUser.content);
  if (MOCK_BARE) text = text.replace(/<[^>]{0,48}>/g, '');
  let i = 0;
  while (i < text.length) {
    // 1~3 字一块，标签必被切断
    const n = 1 + ((Math.random() * 3) | 0);
    const chunk = text.slice(i, i + n);
    i += n;
    yield chunk;
    const pause = /[。！？，…]/.test(chunk) ? 110 + Math.random() * 70 : 18 + Math.random() * 34;
    await sleep(pause);
  }
}

// ---------------------------------------------------------------- TTS

const TTSD_BIN = path.join(root, 'native', 'ttsd');
const TTS_BIN = path.join(root, 'native', 'tts');
const TTS_VOICE = process.env.TTS_VOICE || 'auto';
const CACHE_DIR = path.join(root, '.cache', 'tts');
const ttsCache = new Map();
const ttsInflight = new Map();
const MAX_TTS_CHARS = 240;

/** 常驻合成进程：逐行请求 / 逐行应答 */
let daemon = null;
let daemonSeq = 0;
let daemonBuf = '';
const daemonPending = new Map();

function ttsReady() {
  return fs.existsSync(TTSD_BIN) || fs.existsSync(TTS_BIN);
}

function ensureDaemon() {
  if (daemon && daemon.exitCode === null) return daemon;

  daemon = spawn(TTSD_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  daemonBuf = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => {
    daemonBuf += chunk;
    let i;
    while ((i = daemonBuf.indexOf('\n')) >= 0) {
      const line = daemonBuf.slice(0, i);
      daemonBuf = daemonBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = daemonPending.get(msg.id);
      if (resolve) {
        daemonPending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  daemon.stderr.on('data', () => {});
  daemon.on('exit', () => {
    for (const resolve of daemonPending.values()) resolve({ ok: false, error: 'daemon exited' });
    daemonPending.clear();
    daemon = null;
  });
  return daemon;
}

function daemonSynth(text, out, rate, pitch) {
  return new Promise((resolve, reject) => {
    const d = ensureDaemon();
    const id = String(++daemonSeq);
    const timer = setTimeout(() => {
      daemonPending.delete(id);
      reject(new Error('tts timeout'));
    }, 20000);
    daemonPending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    d.stdin.write(JSON.stringify({ id, text, voice: TTS_VOICE, out, rate, pitch }) + '\n');
  });
}

function stopDaemon() {
  if (daemon && daemon.exitCode === null) daemon.kill();
  daemon = null;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopDaemon();
    process.exit(0);
  });
}

/** 去掉 AVAudioFile 写入的填充块，顺便把 RIFF 长度字段修正 */
function stripJunk(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  const parts = [Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')];
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const end = Math.min(buf.length, off + 8 + size + (size % 2));
    if (id !== 'JUNK' && id !== 'FLLR' && id !== 'LIST') parts.push(buf.subarray(off, end));
    off = end;
  }
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/**
 * 语音缓存键。
 *
 * 语速/音高必须进哈希：情绪不同 → 参数不同 → 同一句话要重新合成。
 * 但也不能让缓存为 0.001 的差异无限膨胀，所以先量化到 0.02。
 */
function ttsId(text, rate = 0.48, pitch = 1.0) {
  return crypto
    .createHash('sha1')
    .update(`${TTS_VOICE}\u0000${rate.toFixed(2)}\u0000${pitch.toFixed(2)}\u0000${text}`)
    .digest('hex')
    .slice(0, 16);
}

async function synth(text, rate = 0.48, pitch = 1.0) {
  const id = ttsId(text, rate, pitch);
  if (ttsCache.has(id)) return ttsCache.get(id);
  if (ttsInflight.has(id)) return ttsInflight.get(id);
  const job = synthUncached(id, text, rate, pitch).finally(() => ttsInflight.delete(id));
  ttsInflight.set(id, job);
  return job;
}

async function synthUncached(id, text, rate, pitch) {

  const wav = path.join(CACHE_DIR, id + '.wav');
  const metaPath = path.join(CACHE_DIR, id + '.json');

  if (fs.existsSync(wav) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    const rec = { ...meta, id, wav };
    ttsCache.set(id, rec);
    return rec;
  }

  await fs.promises.mkdir(CACHE_DIR, { recursive: true });

  // 常驻进程优先；没有编译 daemon 时退回一次性调用
  let meta;
  if (fs.existsSync(TTSD_BIN)) {
    const r = await daemonSynth(text, wav, rate, pitch);
    if (!r.ok) throw new Error(r.error || 'tts failed');
    meta = { duration: r.duration, chars: r.chars, voice: r.voice, marks: r.marks || [] };
  } else {
    const { stdout } = await execFileP(TTS_BIN, [text, TTS_VOICE, wav, String(rate), String(pitch)], {
      timeout: 25000,
      maxBuffer: 8 << 20,
    });
    meta = JSON.parse(stdout);
  }

  await fs.promises.writeFile(metaPath, JSON.stringify(meta));
  const rec = { ...meta, id, wav };
  ttsCache.set(id, rec);
  return rec;
}

/** 启动预热：把语音加载的固定开销挪到用户看不见的时候 */
async function warmTts() {
  if (!ttsReady()) return;
  try {
    await synth('嗯。');
  } catch {
    /* 预热失败不影响主流程 */
  }
}

// ---------------------------------------------------------------- HTTP

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function readBody(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    return;
  }

  const cfg = await resolveProvider();
  const history = Array.isArray(body.history) ? body.history.slice(-9) : [];

  // 人格 + 此刻状态 + 记忆。静态部分在 CORE_PROMPT 里，动态部分每轮重算：
  // llama.cpp 的 prompt cache 按前缀命中，变化只落在尾部，前面的
  // 人格/协议/示例可以一直吃缓存。
  const facts = Array.isArray(body.facts) ? body.facts.filter((f) => typeof f === 'string').slice(-10) : [];
  const system = buildSystemPrompt({
    mood: body.mood && typeof body.mood === 'object' ? body.mood : null,
    facts,
    // 主动开口：不是"等提问"，而是她自己想说点什么
    extra: body.initiate
      ? '【现在】对方已经有一会儿没说话了，安静得有点尴尬。你想主动说句话——可以提一件你刚想到的事、吐槽手上的活、或者问他刚才在干嘛。不要问"你还有什么想聊的"这种空话。一两句，短。'
      : '',
  });

  const messages = [
    { role: 'system', content: system },
    ...history.filter((m) => m && m.role && m.content).map((m) => ({ role: m.role, content: String(m.content) })),
  ];
  // 主动开口时也必须有一条 user 消息收尾。
  // 只给 system + 历史时，qwen 的 chat template 没有"轮到我说"的锚点，
  // 会稳定地返回空串——沉默不是因为它不想说，是因为它不知道现在该说话。
  // 给一句舞台提示，它就知道"对方安静了，该我了"。
  if (body.initiate) messages.push({ role: 'user', content: '（对方沉默了一会儿，还没说话）' });
  else messages.push({ role: 'user', content: String(body.message || '') });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  req.on('close', () => (closed = true));

  const t0 = Date.now();
  sse(res, { type: 'meta', provider: cfg.name, model: cfg.model });

  const stream =
    cfg.name === 'ollama' ? streamOllama(cfg, messages) : cfg.name === 'openai' ? streamOpenAI(cfg, messages) : streamMock(cfg, messages);

  let chars = 0;
  let firstAt = 0;
  try {
    for await (const delta of stream) {
      if (closed) break;
      if (!firstAt) firstAt = Date.now();
      chars += delta.length;
      sse(res, { type: 'delta', text: delta });
    }
  } catch (e) {
    sse(res, { type: 'error', message: e.message });
    // 让提供方回落到模拟流，避免界面卡死
    try {
      for await (const delta of streamMock(cfg, messages)) {
        if (closed) break;
        sse(res, { type: 'delta', text: delta });
      }
    } catch {
      /* 已尽力 */
    }
  }

  const doneAt = Date.now();
  sse(res, {
    type: 'done',
    chars,
    ttftMs: firstAt ? firstAt - t0 : null,
    totalMs: doneAt - t0,
    cps: chars / Math.max(0.001, (doneAt - t0) / 1000),
  });
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 浏览器端音频诊断回传。
  // 音频问题在服务端看不到——WAV 好好的、HTTP 200，但用户就是听不见。
  // 让前端把 AudioContext 状态、解码错误、播放被拒的原因送回来，落到日志里，
  // 下次「没声音」就不用猜了。
  if (url.pathname === '/api/client' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4000) req.destroy();
    });
    req.on('end', () => {
      const ua = req.headers['user-agent'] || '-';
      const line = `${new Date().toISOString()}  ${ua}\n    ${body.slice(0, 800)}`;
      console.log('client →', line.replace(/\n {4}/, ' '));
      try {
        fs.appendFileSync('/tmp/face-audio.log', line + '\n');
      } catch {
        /* ignore */
      }
      res.writeHead(204).end();
    });
    return;
  }

  if (url.pathname === '/api/status') {
    resolveProvider().then((cfg) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          provider: cfg.name,
          model: cfg.model,
          hint: cfg.hint || '',
          ollamaUrl: OLLAMA_URL,
          tts: ttsReady(),
          voice: TTS_VOICE,
        })
      );
    });
    return;
  }

  if (url.pathname === '/api/tts' && req.method === 'POST') {
    readBody(req).then(async (raw) => {
      const body = JSON.parse(raw) || {};
      const text = String(body.text || '').slice(0, MAX_TTS_CHARS).trim();
      if (!text) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'empty text' }));
        return;
      }
      // 情绪驱动的语速/音高。量化到 0.02：既让缓存可控，又足够听出差别。
      const q = (v, lo, hi, def) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.round(Math.min(hi, Math.max(lo, n)) / 0.02) * 0.02;
      };
      const rate = q(body.rate, 0.3, 0.62, 0.48);
      const pitch = q(body.pitch, 0.75, 1.35, 1.0);
      if (!ttsReady()) {
        res.writeHead(501, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'tts binary missing' }));
        return;
      }
      const rec = await synth(text, rate, pitch);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: rec.id,
          duration: rec.duration,
          chars: rec.chars,
          marks: rec.marks,
          voice: rec.voice,
          rate,
          pitch,
          url: `/api/tts/${rec.id}.wav`,
        })
      );
    }).catch((e) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      } catch {
        /* 已断开 */
      }
    });
    return;
  }

  if (url.pathname.startsWith('/api/tts/') && url.pathname.endsWith('.wav')) {
    const id = path.basename(url.pathname).replace(/\.wav$/, '');
    if (!/^[0-9a-f]{16}$/.test(id)) {
      res.writeHead(400).end('bad id');
      return;
    }
    fs.readFile(path.join(CACHE_DIR, id + '.wav'), (err, buf) => {
      if (err) {
        res.writeHead(404).end('no audio');
        return;
      }
      const body = stripJunk(buf);
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': body.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(body);
    });
    return;
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    handleChat(req, res).catch((e) => {
      try {
        sse(res, { type: 'error', message: e.message });
        res.end();
      } catch {
        /* 已断开 */
      }
    });
    return;
  }

  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + p);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

/**
 * 把本地模型先拉进内存。
 *
 * 7B 冷启动要好几秒（读盘 5GB + 建 KV cache）。如果等用户说完第一句话
 * 才开始加载，首响会被拖到十秒开外，看起来就像坏了。这里在服务起来时
 * 用空提示预热一次，用户点开页面时模型已经热着。
 */
async function warmLlm(cfg) {
  if (!cfg || cfg.name !== 'ollama' || !cfg.model) return false;
  try {
    const t0 = Date.now();
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        keep_alive: '30m',
        options: { num_predict: 1 },
      }),
    });
    await r.text();
    return Date.now() - t0;
  } catch {
    return false;
  }
}

/**
 * 本地模型服务不一定开着。与其让人先去敲一条 `ollama serve` 再回来，
 * 不如自己拉起来——模型服务是这套东西的一部分，不该是前置条件。
 *
 * 拉起来的子进程**不主动回收**：Node 退出后它继续活着，
 * 下次 `npm start` 就能秒连（省掉 4.7GB 重新载入的十秒）。
 * 要彻底停就 `pkill -f "ollama serve"`。
 */
const OLLAMA_BIN = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama'].find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

let ollamaChild = null;

async function ensureOllama() {
  if (await alive(`${OLLAMA_URL}/api/tags`)) return 'running';
  if (!OLLAMA_BIN) return 'missing';
  try {
    ollamaChild = spawn(OLLAMA_BIN, ['serve'], { stdio: 'ignore' });
    ollamaChild.on('error', () => {
      ollamaChild = null;
    });
  } catch {
    return 'spawn-failed';
  }
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await alive(`${OLLAMA_URL}/api/tags`)) return 'spawned';
  }
  return 'timeout';
}

server.listen(port, '127.0.0.1', async () => {
  console.log(`face → http://127.0.0.1:${port}`);
  const up = await ensureOllama();
  if (up === 'missing') console.log('LLM: 没找到 ollama（brew install ollama）');
  else if (up === 'timeout') console.log('LLM: ollama 启动了但 10 秒内没响应');

  const c = await resolveProvider();
  console.log(`LLM: ${c.name}${c.model ? ' · ' + c.model : ''}${c.hint ? '  (' + c.hint + ')' : ''}`);
  if (c.name === 'ollama') warmLlm(c).then((ms) => ms && console.log(`LLM 预热: ${ms}ms`));
  warmTts().then(() => console.log(`TTS: ${ttsReady() ? 'ready' : 'unavailable'} (${TTS_VOICE})`));
});
