/**
 * 视觉验证：混合表情到底长什么样。
 *
 * 直接驱动混合器（不走对话链路），因为这里要检查的是"渲染出来是什么脸"，
 * 不是"推断对了没有"。每张图对应一种语义组合，人眼一看就知道区别。
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__mixer && window.__rig, { timeout: 25000 });
await page.waitForTimeout(1500);

const CASES = [
  { file: 'joy', mix: [{ name: 'joy', w: 1 }], gain: 0.95, mode: 'camera' },
  { file: 'surprise-joy', mix: [{ name: 'surprise', w: 0.66 }, { name: 'joy', w: 0.34 }], gain: 0.9, mode: 'camera' },
  { file: 'sadness', mix: [{ name: 'sadness', w: 1 }], gain: 0.9, mode: 'away' },
  { file: 'sadness-joy', mix: [{ name: 'sadness', w: 0.68 }, { name: 'joy', w: 0.32 }], gain: 0.85, mode: 'away' },
  { file: 'thinking-surprise', mix: [{ name: 'thinking', w: 0.68 }, { name: 'surprise', w: 0.32 }], gain: 0.9, mode: 'think' },
  { file: 'anger', mix: [{ name: 'anger', w: 1 }], gain: 0.95, mode: 'camera' },
  { file: 'anger-disgust', mix: [{ name: 'anger', w: 0.68 }, { name: 'disgust', w: 0.32 }], gain: 0.9, mode: 'camera' },
];

for (const c of CASES) {
  await page.evaluate((cfg) => {
    const m = window.__mixer;
    m.enabled.micro = false; // 关掉随机微表情，避免截图时机抖动
    m.setPresetMix(cfg.mix.map((x) => ({ ...x })));
    m.presetGain = cfg.gain;
    m.setMode(cfg.mode);
  }, c);
  await page.waitForTimeout(900);
  const settled = await page.evaluate(() => ({
    preset: window.__mixer.preset,
    mix: window.__mixer.presetMix.map((m) => `${m.name}:${m.w.toFixed(2)}`),
    active: window.__mixer.activeCount,
  }));
  await page.screenshot({ path: `/tmp/mix-${c.file}.png`, clip: { x: 20, y: 60, width: 700, height: 700 } });
  console.log(c.file.padEnd(18), JSON.stringify(settled));
}

await browser.close();
