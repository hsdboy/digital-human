/**
 * 演示抓图：模型完全不输出标签，脸的每一次变化都来自读文本。
 * 拍摄同一句话说到不同位置时的三帧，用来肉眼确认"表情跟着内容走"。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn('node', ['server.mjs'], {
  cwd: proj,
  env: { ...process.env, PORT: '5185', FACE_LLM: 'mock', MOCK_BARE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => {
  srv.stdout.on('data', (d) => String(d).includes('face →') && setTimeout(r, 500));
  setTimeout(r, 6000);
});

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
await page.goto('http://127.0.0.1:5185', { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 25000 });
await page.waitForTimeout(1200);

await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
await page.press('#ask', 'Enter');

const shots = [];
let last = null;
const t0 = Date.now();
while (Date.now() - t0 < 12000 && shots.length < 3) {
  await page.waitForTimeout(120);
  const s = await page.evaluate(() => {
    const d = window.__dialogue.stats();
    return {
      preset: d.preset,
      mix: d.mix.join('+'),
      gain: +d.gain.toFixed(2),
      src: d.exprSrc,
      text: document.getElementById('say-text').textContent,
      state: d.state,
    };
  });
  if (s.preset !== last && s.state === 'speaking') {
    last = s.preset;
    await page.waitForTimeout(280);
    const f = `/tmp/bare-${shots.length}.png`;
    await page.screenshot({ path: f, clip: { x: 30, y: 150, width: 620, height: 620 } });
    shots.push({ file: f, ...s });
    console.log(`${s.preset.padEnd(9)} ${s.mix.padEnd(26)} 来源 ${s.src}  「${s.text}」`);
  }
}

await browser.close();
srv.kill();
console.log(shots.length ? `拍了 ${shots.length} 帧` : '没拍到（可能第一句已是终态）');
