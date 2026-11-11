/** 真模型下抓一帧"正在说话"的画面：用于人眼确认表情+口型对得上 */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1180, height: 800 } });
await p.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await p.waitForFunction(() => window.__dialogue, { timeout: 25000 });
await p.waitForTimeout(900);
const SENT = process.env.SENT || '我今天被老板当着所有人骂了一顿';
await p.evaluate((s) => window.__dialogue.ask(s), SENT);
// 等到表情离开中性且嘴张开，这才是"正在说话"的那一刻
await p.waitForFunction(() => {
  const st = window.__dialogue.stats();
  return st.state === 'speaking' && (window.__rig.get('jawOpen') || 0) > 0.12;
}, { timeout: 30000 }).catch(() => {});
const info = await p.evaluate(() => ({
  preset: window.__mixer.preset,
  mix: window.__mixer.presetMix.map(m => m.name),
  jaw: +(window.__rig.get('jawOpen')||0).toFixed(2),
  text: document.getElementById('say-text').textContent,
  prov: document.getElementById('prov').textContent,
  lat: document.getElementById('lat').textContent,
}));
await p.screenshot({ path: '/tmp/live-7b.png', clip: { x: 0, y: 0, width: 780, height: 800 } });
console.log(JSON.stringify(info, null, 1));
await b.close();
