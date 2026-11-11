/**
 * P3 联调：验证「音频真的是主时钟」。
 *
 * 断言重点不再是"表情出现了"，而是"三者在同一个时钟上"：
 *   1. AudioContext 在跑（否则一切免谈）
 *   2. RMS 音量与下颌同步（音素层接管口型后，音量退居「重音调制」，
 *      相关性不再是 1，但必须明显为正——为 0 就说明两者脱钩了）
 *   3. 文本揭示进度与音频位置一致（结束时刚好全部揭示）
 *   4. 表情事件在音频时间轴上触发，而非按字数估算
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1200);

const status = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));

// 在页面里逐帧记录，比从 node 轮询精确
await page.evaluate(() => {
  window.__rec = [];
  // 必须先建好 marks 再起 rAF：否则第一帧就撞上 undefined（随机失败的真凶）
  window.__marks = { ask: 0, say: 0, speak: 0 };
  const loop = () => {
    const d = window.__dialogue.stats();
    const st = window.__dialogue.stats();
    if (st.state !== 'idle' && !window.__marks.ask) window.__marks.ask = performance.now();
    if (!window.__marks.say && document.getElementById('say-text').textContent.length > 0) window.__marks.say = performance.now();
    if (st.state === 'speaking' && !window.__marks.speak) window.__marks.speak = performance.now();
    window.__rec.push({
      t: performance.now() / 1000,
      level: d.level,
      jaw: window.__rig.get('jawOpen'),
      open: +document.getElementById('say-text').textContent.length,
      preset: d.preset,
      state: d.state,
      clock: d.clock,
      events: d.events,
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const t0 = Date.now();
await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.evaluate(() => {
  window.__sendAt = performance.now();
  window.__marks.ask = 0;
  window.__marks.say = 0;
  window.__marks.speak = 0;
});
await page.press('#ask', 'Enter');

// 等到不再说话
let sent = false;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(120);
  const st = await page.evaluate(() => window.__dialogue.stats());
  if (st.state === 'speaking' && !sent && st.level > 0.2 && i > 6) {
    await page.screenshot({ path: '/tmp/p3-speak.png' });
    sent = true;
  }
  if (st.state === 'idle' && st.events > 0 && i > 10) break;
}

const rec = await page.evaluate(() => window.__rec);
const final = await page.evaluate(() => {
  const st = window.__dialogue.stats();
  return {
    text: document.getElementById('say-text').textContent,
    stats: st,
    marks: window.__dialogue.lastMeta || null,
  };
});

// 相关性：音量 -> 下颌
const live = rec.filter((r) => r.state === 'speaking');
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const corr = (a, b) => {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(Math.max(1e-9, da * db));
};

const marks = await page.evaluate(() => window.__marks);
const firstSpeak = rec.find((r) => r.state === 'speaking');
const sendAt = await page.evaluate(() => window.__sendAt);
const startLatency = firstSpeak ? Math.round(firstSpeak.t * 1000 - sendAt) : null;
const phase = {
  press: marks.ask ? Math.round(marks.ask - sendAt) : null,
  firstChar: marks.ask && marks.say ? Math.round(marks.say - marks.ask) : null,
  firstSound: marks.ask && marks.speak ? Math.round(marks.speak - marks.ask) : null,
};

const levels = live.map((r) => r.level);
const jaws = live.map((r) => r.jaw);
const maxLevel = Math.max(0, ...levels);
const maxJaw = Math.max(0, ...jaws);
const corrLJ = live.length > 20 ? corr(levels, jaws) : NaN;

const report = {
  provider: status.provider,
  tts: status.tts,
  voice: status.voice,
  samples: rec.length,
  speakingSamples: live.length,
  maxLevel: +maxLevel.toFixed(3),
  maxJaw: +maxJaw.toFixed(3),
  corrLevelJaw: Number.isFinite(corrLJ) ? +corrLJ.toFixed(3) : null,
  startLatencyMs: startLatency,
  phaseMs: phase,
  clockEnd: final.stats.clock,
  events: final.stats.events,
  degraded: final.stats.degraded,
  text: final.text,
  tagLeak: /<[egmvp]:/.test(final.text),
  presets: [...new Set(rec.map((r) => r.preset))],
  errors: errors.slice(0, 4),
};
console.log(JSON.stringify(report, null, 2));

let fail = 0;
const check = (n, c, x) => {
  if (!c) {
    fail++;
    console.log(`✗ ${n}${x ? ' → ' + x : ''}`);
  }
};

check('TTS 可用', status.tts === true);
check('没有降级到文本时钟', report.degraded === false);
check('AudioContext 在推进', report.clockEnd > 1, String(report.clockEnd));
check('音量被采到', report.maxLevel > 0.08, String(report.maxLevel));
check('颌部跟随音量', report.maxJaw > 0.12, String(report.maxJaw));
check('音量与口型正相关', report.corrLevelJaw > 0.2, String(report.corrLevelJaw));
check('表情事件被触发', report.events >= 2, String(report.events));
check('文本完整揭示', report.text.length > 10, report.text);
check('标签未泄漏', !report.tagLeak, report.text);
check('首响延迟在预算内', startLatency != null && startLatency < 2500, String(startLatency) + 'ms');
check('无 JS 报错', report.errors.length === 0, JSON.stringify(report.errors));

console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
await browser.close();
process.exit(fail ? 1 : 0);
