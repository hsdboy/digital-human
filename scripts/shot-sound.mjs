/** 抓「说话中 + 音频状态灯」的界面，人眼确认状态是否可读 */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1240, height: 820 } });
await p.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await p.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await p.waitForTimeout(800);
await p.fill('#ask', '你好');
await p.click('#send');
await p.waitForFunction(() => {
  const pl = window.__dialogue.player();
  return pl && pl.cur && pl.cur.started;
}, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(700);
const info = await p.evaluate(() => ({
  snd: document.getElementById('snd').textContent,
  sndState: document.getElementById('snd').dataset.s,
  mute: document.getElementById('mute').textContent,
  lat: document.getElementById('lat').textContent,
  level: +window.__dialogue.voice.level.toFixed(3),
  mode: window.__dialogue.voice.mode,
}));
await p.screenshot({ path: '/tmp/sound-ui.png', clip: { x: 0, y: 640, width: 1240, height: 180 } });
console.log(JSON.stringify(info, null, 1));
await b.close();
