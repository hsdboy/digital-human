/**
 * 打断与静音。
 * 打断是最容易被忽略、但用户一定会用到的功能：不说话时按下去，
 * 声音要立刻停、嘴要立刻闭、表情要回中性——任何一项慢半拍都很出戏。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1200);

const waitSpeaking = async (minChars = 6) => {
  for (let i = 0; i < 100; i++) {
    const s = await page.evaluate(() => ({
      state: window.__dialogue.stats().state,
      chars: document.getElementById('say-text').textContent.length,
      level: window.__dialogue.stats().level,
    }));
    if (s.state === 'speaking' && s.chars >= minChars && s.level > 0.1) return true;
    await page.waitForTimeout(80);
  }
  return false;
};

// ---- 1. 打断 ----
await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.press('#ask', 'Enter');
const started = await waitSpeaking();
// 等到"确实正在出声"的那一帧再打断——否则会撞上句间停顿，测出来的是假阴性
let before = { level: 0, jaw: 0 };
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => ({ level: window.__dialogue.stats().level, jaw: window.__rig.get('jawOpen') }));
  if (s.level > 0.15) { before = s; break; }
  await page.waitForTimeout(40);
}
await page.click('#stop');
await page.waitForTimeout(450);
const after = await page.evaluate(() => ({
  state: window.__dialogue.stats().state,
  level: window.__dialogue.stats().level,
  jaw: window.__rig.get('jawOpen'),
  preset: window.__rig ? window.__mixer.preset : null,
  lat: document.getElementById('lat').textContent,
}));
await page.screenshot({ path: '/tmp/p3-barge.png' });

// ---- 2. 静音下仍应正常推进文本与表情 ----
await page.click('#mute');
await page.waitForTimeout(150);
await page.fill('#ask', '我刚刚中彩票了');
await page.press('#ask', 'Enter');
let mutedSawText = 0;
let mutedMaxLevel = 0;
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(100);
  const s = await page.evaluate(() => ({
    chars: document.getElementById('say-text').textContent.length,
    level: window.__dialogue.stats().level,
    state: window.__dialogue.stats().state,
  }));
  mutedSawText = Math.max(mutedSawText, s.chars);
  mutedMaxLevel = Math.max(mutedMaxLevel, s.level);
  if (s.state === 'idle' && s.chars > 8) break;
}
const muted = await page.evaluate(() => ({ state: window.__dialogue.stats().state, events: window.__dialogue.stats().events }));

const report = {
  started,
  beforeBarge: { level: +before.level.toFixed(3), jaw: +before.jaw.toFixed(3) },
  afterBarge: { state: after.state, level: +after.level.toFixed(3), jaw: +after.jaw.toFixed(3), preset: after.preset, lat: after.lat },
  mutedTextChars: mutedSawText,
  mutedMaxLevel: +mutedMaxLevel.toFixed(3),
  mutedFinalState: muted.state,
  errors,
};
console.log(JSON.stringify(report, null, 2));

let fail = 0;
const check = (n, c, x) => { if (!c) { fail++; console.log(`✗ ${n}${x ? ' → ' + x : ''}`); } };
check('打断前确实在出声', started && before.level > 0.1, String(before.level));
check('打断后立刻静音', after.level < 0.02, String(after.level));
check('打断后嘴闭上', after.jaw < 0.08, String(after.jaw));
check('打断后回中性表情', after.preset === 'neutral', String(after.preset));
check('打断后状态为待机', after.state === 'idle', after.state);
check('静音时文本仍推进', mutedSawText > 8, String(mutedSawText));
check('静音时确实无声', mutedMaxLevel < 0.05, String(mutedMaxLevel));
check('无 JS 报错', errors.length === 0, JSON.stringify(errors));
console.log(fail ? `\n${fail} 项未通过` : '\n全部通过');
await browser.close();
process.exit(fail ? 1 : 0);
