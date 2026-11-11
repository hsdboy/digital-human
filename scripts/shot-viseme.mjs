/**
 * 视觉验证：音素口型到底长什么样。
 *
 * 冻结对话层（否则每帧都会被 tick 覆盖），手动把 mixer 的口型钉在某个 viseme 上，
 * 逐张截图再拼成一张对照图。这里要检查的是"渲染出来的嘴"，不是数值。
 *
 * 判定标准很朴素：aa（啊）要真张，ou（乌）要真撅，PP（妈）要真闭，
 * ih（衣）要横咧。四张放一起，一眼看不出区别就说明这层没做对。
 */

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const CLIP = { x: 110, y: 292, width: 380, height: 380 };

const CASES = [
  { key: 'PP', label: 'PP 妈/不（闭唇）' },
  { key: 'aa', label: 'aa 啊/爸（大开口）' },
  { key: 'oh', label: 'oh 我/红（圆半开）' },
  { key: 'ou', label: 'ou 乌/鱼（圆小撮）' },
  { key: 'ih', label: 'ih 衣/明（扁唇）' },
  { key: 'E', label: 'E 的/很（半开）' },
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__viseme && window.__mixer, { timeout: 25000 });
await page.waitForTimeout(1500);

// 冻结对话推进，否则 speech.vis 每帧被重置成 null
await page.evaluate(() => {
  window.__dialogue.tick = () => {};
  const m = window.__mixer;
  m.enabled.micro = false;
  m.enabled.blink = false;
  m.setPreset('neutral');
  m.presetGain = 1;
});

const shots = [];
for (const c of CASES) {
  const applied = await page.evaluate((key) => {
    const v = {
      sil: { jaw: 0, close: 0, funnel: 0, pucker: 0, stretch: 0, upper: 0, lower: 0, roll: 0 },
      PP: { jaw: 0, close: 0.55, funnel: 0, pucker: 0.06, stretch: 0.03, upper: 0, lower: 0, roll: 0 },
      aa: { jaw: 0.9, close: 0, funnel: 0.1, pucker: 0, stretch: 0.06, upper: 0.3, lower: 0.5, roll: 0 },
      oh: { jaw: 0.56, close: 0, funnel: 0.7, pucker: 0.18, stretch: 0, upper: 0.18, lower: 0.34, roll: 0 },
      ou: { jaw: 0.2, close: 0.05, funnel: 0.34, pucker: 0.95, stretch: 0, upper: 0.07, lower: 0.11, roll: 0 },
      ih: { jaw: 0.24, close: 0, funnel: 0, pucker: 0, stretch: 0.85, upper: 0.1, lower: 0.14, roll: 0 },
      E: { jaw: 0.4, close: 0, funnel: 0, pucker: 0, stretch: 0.5, upper: 0.11, lower: 0.22, roll: 0 },
    }[key];
    window.__mixer.speech.setViseme(v);
    window.__mixer.speech.setExternal(-1); // 关掉音量调制，避免 headless 静音把幅度压掉
    return v;
  }, c.key);

  await page.waitForTimeout(420);
  const file = `/tmp/vm-${c.key}.png`;
  await page.screenshot({ path: file, clip: CLIP });
  shots.push({ ...c, file });
  console.log(c.key.padEnd(4), JSON.stringify(applied));
}

// 拼成 3×2 对照图，一次就能看完
const IMG = 320;
const COLS = 3;
const rows = Math.ceil(shots.length / COLS);
const out = new PNG({ width: IMG * COLS, height: IMG * rows });
for (let i = 0; i < shots.length; i++) {
  const src = PNG.sync.read(fs.readFileSync(shots[i].file));
  const ox = (i % COLS) * IMG;
  const oy = Math.floor(i / COLS) * IMG;
  const sx = src.width / IMG;
  const sy = src.height / IMG;
  for (let y = 0; y < IMG; y++) {
    for (let x = 0; x < IMG; x++) {
      const si = ((Math.floor(y * sy) * src.width) + Math.floor(x * sx)) * 4;
      const di = ((oy + y) * out.width + ox + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
}
fs.writeFileSync('/tmp/viseme-grid.png', PNG.sync.write(out));
console.log('\n对照图：/tmp/viseme-grid.png（顺序 ' + CASES.map((c) => c.key).join(' / ') + '）');

await browser.close();
