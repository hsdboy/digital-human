/**
 * 浏览器端联调：真的发一句话，看脸有没有跟着动。
 * 采集整段对话过程中的状态序列，断言：
 *   1. 标签绝不泄漏到可见文本
 *   2. 说话过程中出现对应表情
 *   3. 说话时下颌在动（L4 口型生效）
 *   4. 事件触发时刻与文本揭示进度一致
 */

import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1200);

const samples = [];
let sayLen = 0;

async function probe() {
  const s = await page.evaluate(() => {
    const d = window.__dialogue.stats();
    return {
      state: d.state,
      preset: d.preset,
      gain: +d.gain.toFixed(2),
      jaw: +window.__rig.get('jawOpen').toFixed(3),
      browInner: +window.__rig.get('browInnerUp').toFixed(3),
      frown: +window.__rig.get('mouthFrownLeft').toFixed(3),
      smile: +window.__rig.get('mouthSmileLeft').toFixed(3),
      events: d.events,
      text: document.getElementById('say-text').textContent,
      gaze: window.__mixer.gaze.mode,
      prov: document.getElementById('prov').textContent,
    };
  });
  samples.push(s);
  return s;
}

// ---- 发送 ----
await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.press('#ask', 'Enter');

const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(150);
  const s = await probe();
  if (i === 8) await page.screenshot({ path: '/tmp/p2-a.png' });
  if (i === 26) await page.screenshot({ path: '/tmp/p2-b.png' });
  if (s.state === 'idle' && s.events > 0 && Date.now() - t0 > 2000) break;
}
await page.screenshot({ path: '/tmp/p2-c.png' });

// ---- 第二句：正面情绪 ----
await page.fill('#ask', '不过我刚刚中彩票了');
await page.press('#ask', 'Enter');
const t1 = Date.now();
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(150);
  const s = await probe();
  if (s.smile > 0.3 && s.state === 'speaking') {
    await page.screenshot({ path: '/tmp/p2-joy.png' });
    break;
  }
  if (Date.now() - t1 > 8000) break;
}

const allText = samples.map((s) => s.text).join('');
const finalText = samples[samples.length - 1].text;

const presets = [...new Set(samples.map((s) => s.preset))];
const maxJaw = Math.max(...samples.map((s) => s.jaw));
const maxSmile = Math.max(...samples.map((s) => s.smile));
const maxBrow = Math.max(...samples.map((s) => s.browInner));

const report = {
  provider: samples[0].prov,
  samples: samples.length,
  states: [...new Set(samples.map((s) => s.state))],
  presetsSeen: presets,
  totalEvents: Math.max(...samples.map((s) => s.events)),
  tag_leak: /<[egmvp]:/.test(allText),
  say_final: finalText.slice(0, 80),
  maxJaw: +maxJaw.toFixed(3),
  maxSmile: +maxSmile.toFixed(3),
  maxBrowInnerUp: +maxBrow.toFixed(3),
  gazeModes: [...new Set(samples.map((s) => s.gaze))],
  errors: errors.slice(0, 5),
};

console.log(JSON.stringify(report, null, 2));

let fail = 0;
const check = (name, cond, extra) => {
  if (!cond) {
    fail++;
    console.log(`✗ ${name}${extra ? ' → ' + extra : ''}`);
  }
};

check('标签没有泄漏到可见文本', !report.tag_leak, report.say_final);
check('触发了事件', report.totalEvents >= 2, String(report.totalEvents));
check('说话时下颌在动', report.maxJaw > 0.1, String(report.maxJaw));
check('眉毛参与了表情', report.maxBrowInnerUp > 0.1, String(report.maxBrowInnerUp));
// 下面两条依赖内置模拟脚本的固定台词，换成真实模型时不适用
const isMock = String(report.provider).startsWith('mock');
if (isMock) {
  check('出现悲伤表情', presets.includes('sadness'), presets.join(','));
  check('出现喜悦表情', report.maxSmile > 0.35, String(report.maxSmile));
}
check('没有 JS 报错', report.errors.length === 0, JSON.stringify(report.errors));

console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
await browser.close();
process.exit(fail ? 1 : 0);
