/**
 * WebKit(Safari 引擎) 音频链路诊断
 *
 * 用户默认浏览器是 Safari，Chromium 上通过的测试对它没有意义：
 * Safari 的自动播放策略、decodeAudioData 的 WAV 兼容性、
 * AudioContext 的解锁条件都和 Chrome 不同。
 */
import { webkit } from 'playwright';

const b = await webkit.launch();
const p = await b.newPage({ viewport: { width: 1240, height: 820 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await p.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await p.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await p.waitForTimeout(600);

const ua = await p.evaluate(() => navigator.userAgent);

// 在真实手势里点一下，让页面自己的 unlock 跑起来
await p.click('#stage');
await p.waitForTimeout(500);

const afterClick = await p.evaluate(() => {
  const v = window.__dialogue.voice;
  return { mode: v.mode, state: v.ctx ? v.ctx.state : null, diag: v.diag.state, sr: v.ctx ? v.ctx.sampleRate : null };
});

const ping = await p.evaluate(() => window.__dialogue.voice.ping());

// 单独验 decodeAudioData：拿同一段 TTS
const decode = await p.evaluate(async () => {
  const v = window.__dialogue.voice;
  const meta = await (
    await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '解一下这段音频' }),
    })
  ).json();
  const ab = await (await fetch(meta.url)).arrayBuffer();
  const out = { bytes: ab.byteLength, url: meta.url };
  try {
    const buf = await v.ctx.decodeAudioData(ab.slice(0));
    out.ok = true;
    out.dur = +buf.duration.toFixed(2);
  } catch (e) {
    out.ok = false;
    out.err = e.name + ': ' + e.message;
  }
  return out;
});

// 对话链路
await p.fill('#ask', '你好');
await p.click('#send');
const samples = [];
for (let i = 0; i < 50; i++) {
  await p.waitForTimeout(120);
  const s = await p.evaluate(() => {
    const v = window.__dialogue.voice;
    const pl = window.__dialogue.player();
    return {
      lvl: +v.level.toFixed(3),
      cur: pl && pl.cur ? pl.cur.text.slice(0, 6) : null,
      started: pl && pl.cur ? pl.cur.started : null,
      silent: pl && pl.cur ? pl.cur.silent : null,
      pos: pl && pl.cur && pl.cur.started ? +(v.now - pl.cur.startAt).toFixed(2) : null,
    };
  });
  samples.push(s);
  if (i > 8 && !s.cur) break;
}

const final = await p.evaluate(() => {
  const v = window.__dialogue.voice;
  const sndEl = document.getElementById('sndtest');
  return {
    mode: v.mode,
    state: v.ctx ? v.ctx.state : null,
    decodeErr: v.diag.decodeErr,
    drop: v.diag.drop,
    diag: v.diag.state,
    plays: v.diag.plays,
    sndText: sndEl ? sndEl.textContent : null,
    lat: (document.getElementById('lat') || {}).textContent,
  };
});

console.log('UA:', ua);
console.log('点击后:', JSON.stringify(afterClick));
console.log('ping:', JSON.stringify(ping));
console.log('decode:', JSON.stringify(decode));
console.log('采样(', samples.length, '帧):');
console.log(samples.filter((_, i) => i % 4 === 0).map((s) => JSON.stringify(s)).join('\n'));
console.log('final:', JSON.stringify(final, null, 1));
if (logs.length) console.log('console:\n' + logs.slice(-15).join('\n'));
await b.close();
