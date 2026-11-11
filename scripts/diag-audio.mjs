/**
 * 真浏览器音频链路诊断（不开 autoplay 豁免，尽量接近用户实际环境）
 *
 * 要回答的问题只有三个：
 *   1. decodeAudioData 成不成功（失败会静默退化到 element 路径）
 *   2. playAudio 实际走了哪条分支（webaudio / element / null）
 *   3. 信号有没有真的到达 destination 输入端（analyser 电平）
 * 以及旁路验证：<audio> 元素能不能推进 currentTime。
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage({ viewport: { width: 1240, height: 820 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await p.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await p.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await p.waitForTimeout(600);

// 给 playAudio 打点：记录每次调用走了哪条分支
await p.evaluate(() => {
  const v = window.__dialogue.voice;
  window.__pa = [];
  const orig = v.playAudio.bind(v);
  v.playAudio = (audio, at) => {
    const r = orig(audio, at);
    window.__pa.push({
      hasBuffer: !!audio.buffer,
      bufDur: audio.buffer ? +audio.buffer.duration.toFixed(2) : null,
      url: audio.url || null,
      at: +at.toFixed(2),
      now: +v.now.toFixed(2),
      mode: v.mode,
      ctxState: v.ctx ? v.ctx.state : null,
      branch: r ? (v.mode === 'webaudio' && audio.buffer ? 'webaudio' : 'element') : 'null',
    });
    return r;
  };
});

// 真手势：点击页面上任意位置解锁 + 点试听
await p.click('#stage');
await p.waitForTimeout(400);

const ping = await p.evaluate(() => window.__dialogue.voice.ping());

// 然后走一轮真实对话
await p.fill('#ask', '你好');
await p.click('#send');

// 采样电平
const samples = [];
for (let i = 0; i < 60; i++) {
  await p.waitForTimeout(120);
  const s = await p.evaluate(() => {
    const v = window.__dialogue.voice;
    const pl = window.__dialogue.player();
    return {
      lvl: +v.level.toFixed(3),
      mode: v.mode,
      st: v.ctx ? v.ctx.state : null,
      cur: pl && pl.cur ? pl.cur.text.slice(0, 6) : null,
      started: pl && pl.cur ? pl.cur.started : null,
      silent: pl && pl.cur ? pl.cur.silent : null,
      pos: pl && pl.cur && pl.cur.started ? +(v.now - pl.cur.startAt).toFixed(2) : null,
    };
  });
  samples.push(s);
  if (i > 12 && !s.cur) break;
}

// 旁路：<audio> 元素能不能真的播
const el = await p.evaluate(async () => {
  const meta = await (
    await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '测试一下元素播放' }),
    })
  ).json();
  const a = new Audio(meta.url);
  a.preload = 'auto';
  const err = await a.play().then(() => null).catch((e) => e.name + ': ' + e.message);
  await new Promise((r) => setTimeout(r, 600));
  const out = { err, paused: a.paused, currentTime: +a.currentTime.toFixed(3), dur: +a.duration.toFixed(2), muted: a.muted, volume: a.volume };
  a.pause();
  return out;
});

const diag = await p.evaluate(() => {
  const v = window.__dialogue.voice;
  return {
    mode: v.mode,
    ctxState: v.ctx ? v.ctx.state : null,
    sampleRate: v.ctx ? v.ctx.sampleRate : null,
    destCh: v.ctx ? v.ctx.destination.channelCount : null,
    state: v.diag.state,
    decodeErr: v.diag.decodeErr,
    drop: v.diag.drop,
    plays: window.__pa,
    stats: window.__dialogue.stats(),
  };
});

const peak = Math.max(...samples.map((s) => s.lvl));
const active = samples.filter((s) => s.lvl > 0.02).length;

console.log('=== ping ===');
console.log(JSON.stringify(ping));
console.log('=== 对话采样 ===');
console.log('samples', samples.length, '有电平帧', active, '峰值', peak);
console.log(samples.filter((_, i) => i % 4 === 0).map((s) => JSON.stringify(s)).join('\n'));
console.log('=== playAudio 调用 ===');
console.log(JSON.stringify(diag.plays, null, 1));
console.log('=== <audio> 旁路 ===');
console.log(JSON.stringify(el));
console.log('=== 环境 ===');
console.log(JSON.stringify({ mode: diag.mode, ctxState: diag.ctxState, sampleRate: diag.sampleRate, destCh: diag.destCh, state: diag.state, decodeErr: diag.decodeErr, drop: diag.drop }, null, 1));
if (logs.length) {
  console.log('=== console ===');
  console.log(logs.slice(-25).join('\n'));
}
await b.close();
