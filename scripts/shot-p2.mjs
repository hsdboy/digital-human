import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 20000 });
await page.waitForTimeout(1500);

async function shotFor(msg, want, file, settle = 900) {
  await page.fill('#ask', msg);
  await page.press('#ask', 'Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const s = await page.evaluate(() => window.__dialogue.stats());
    if (s.preset === want && s.state === 'speaking') break;
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(settle);
  const s = await page.evaluate(() => window.__dialogue.stats());
  await page.screenshot({ path: file });
  console.log(file, '→', s.preset, s.state, 'backlog', s.backlog);
  await page.evaluate(() => window.__dialogue.stop());
  await page.waitForTimeout(600);
}

await shotFor('我今天被老板当着所有人骂了一顿', 'sadness', '/tmp/p2-sad.png');
await shotFor('我刚刚中彩票了！', 'joy', '/tmp/p2-happy.png');
await shotFor('你觉得我该不该辞职', 'thinking', '/tmp/p2-think.png');

// 打断后应回中性
await page.fill('#ask', '讲个长一点的故事');
await page.press('#ask', 'Enter');
await page.waitForTimeout(1400);
await page.evaluate(() => window.__dialogue.stop());
await page.waitForTimeout(700);
const st = await page.evaluate(() => ({ ...window.__dialogue.stats(), smile: window.__rig.get('mouthSmileLeft') }));
await page.screenshot({ path: '/tmp/p2-stopped.png' });
console.log('after stop:', st.state, st.preset, 'smile', st.smile.toFixed(3));
await browser.close();
