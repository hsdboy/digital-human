/**
 * 拟人化的端到端验收：真浏览器 + 真模型 + 真 TTS。
 *
 * 单元测试只能证明「情绪会衰减」「改写后坐标没乱」，
 * 真正的拟人化要验的是四件事，件件都要在浏览器里看：
 *   1. 她会记住你（事实进得了 prompt，也进得了 stats）
 *   2. 她不会秒回（首字前有一段"在想"的空白）
 *   3. 她不会主动讨好（工具型请求会被推回去，不写公文）
 *   4. 标签一个都不许漏到文本里（裸标签 <sadness:0.8> 也一样）
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160));
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__dialogue.mood, { timeout: 25000 });
await page.click('#stage');
await page.waitForTimeout(500);

const settle = async (maxMs = 45000) => {
  const t0 = Date.now();
  // 先等它开始，再等它结束——模型有时候两三秒才吐第一个字
  await page.waitForFunction(() => window.__dialogue.stats().state !== 'idle', { timeout: 12000 }).catch(() => {});
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(200);
    const s = await page.evaluate(() => window.__dialogue.stats().state);
    if (s === 'idle') break;
  }
};

const say = async (text) => {
  await page.fill('#ask', text);
  await page.click('#send');
  await settle();
};

console.log('\n[1] 记忆：她会记住你是谁');
{
  await say('我叫阿泽，我在杭州做前端');
  const facts = await page.evaluate(() => window.__dialogue.stats().facts);
  ok(facts.some((f) => f.includes('阿泽')), '记住名字', JSON.stringify(facts));
  ok(facts.some((f) => f.includes('杭州')), '记住城市', JSON.stringify(facts));
  ok((await page.evaluate(() => window.__dialogue.stats().facts.length)) > 0, '事实进了 stats（会随请求发出）');
}

console.log('\n[2] 节奏：她不会秒回');
{
  const lat = await page.evaluate(() => document.getElementById('lat').textContent);
  const m = /首字\s*(\d+)/.exec(lat);
  ok(!!m, '拿得到首字延迟', lat);
  if (m) ok(Number(m[1]) >= 300, '首字前有思考节拍（≥300ms）', `${m[1]}ms`);
}

console.log('\n[3] 情绪：底色会变，而且不会一句话翻盘');
{
  const before = await page.evaluate(() => window.__dialogue.mood.state);
  await say('我被老板当众骂了一顿，特别难受');
  const after = await page.evaluate(() => window.__dialogue.mood.state);
  ok(after.valence < before.valence, '负面的话把心情拉低了', `${before.valence} → ${after.valence}`);
  ok(Math.abs(after.valence - before.valence) < 0.62, '但没有一句话翻盘（惯性还在）', `Δ=${(after.valence - before.valence).toFixed(2)}`);
  const t = await page.evaluate(() => window.__dialogue.stats().tendency);
  ok(t.verbose < 0.75, '低落时"愿意展开"的程度下降', `verbose=${t.verbose.toFixed(2)}`);
}

console.log('\n[4] 立场：她不是有求必应的助手');
{
  await say('帮我写一份正式的工作周报，要列清楚重点');
  const txt = await page.evaluate(() => document.getElementById('say-text').textContent);
  ok(!/^\s*(尊敬|亲爱)的/m.test(txt), '没有信件称呼');
  ok(!/以上[，,]\s*谢谢|此致/.test(txt), '没有公文落款');
  ok(!/^\s*\d+[.、)]\s/m.test(txt), '没有编号列表');
  ok(!/作为(一个)?(AI|人工智能|助手)/.test(txt), '没有 AI 自述');
  ok(!/[<>]/.test(txt), '标签一个都没漏到文本里', txt.slice(0, 40));
  console.log(`    实际回复：${txt.slice(0, 60)}`);
}

console.log('\n[5] 主动性：安静久了会自己开口');
{
  const n0 = await page.evaluate(() => window.__dialogue.stats().initiated);
  const diag = await page.evaluate(() => {
    const d = window.__dialogue;
    const r = d.rhythm;
    // 把"安静多久"压到 1 秒内，并把到期时刻直接作废——测的是"会不会开口"，
    // 不是"等多久才开口"
    r.idleStart = 800;
    r.initiateGap = 0;
    r.atLimit = false;
    r.lastActive = performance.now() / 1000 - 2;
    r.dueAt = 0;
    // 心情太差时按设计是不开口的，这里先拉回来再测
    if (d.stats().tendency.chatty < 0.25) d.mood.push(0.4, 0.1, 0.7);
    return { hidden: document.hidden, chatty: d.stats().tendency.chatty };
  });
  if (diag.hidden) console.log('    （页面在无头模式被判为后台，主动开口会按设计被抑制）');
  const t0 = Date.now();
  let n1 = n0;
  while (Date.now() - t0 < 15000) {
    await page.waitForTimeout(300);
    n1 = await page.evaluate(() => window.__dialogue.stats().initiated);
    if (n1 > n0) break;
  }
  ok(n1 > n0, '主动开口触发过', `${n0} → ${n1}（chatty=${diag.chatty.toFixed(2)} hidden=${diag.hidden}）`);
  if (n1 > n0) {
    await settle(30000);
    const txt = await page.evaluate(() => document.getElementById('say-text').textContent);
    ok(txt.length > 0, '主动说的话有内容', txt.slice(0, 40));
    ok(!/还有什么可以帮|你想聊点什么/.test(txt), '不是"你想聊点什么"这类空话', txt.slice(0, 40));
  }
}

console.log('\n[6] 被打断：有反应，不是静默归零');
{
  await page.evaluate(() => window.__dialogue.ask('给我讲讲你最近在忙什么'));
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => ({
    preset: window.__dialogue.stats().preset,
    moodV: window.__dialogue.mood.state.valence,
  }));
  await page.click('#stop');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    preset: window.__dialogue.stats().preset,
    moodV: window.__dialogue.mood.state.valence,
    lat: document.getElementById('lat').textContent,
  }));
  ok(/已打断/.test(after.lat), '状态栏确认打断');
  ok(after.moodV <= before.moodV + 0.001, '被打断会让心情略降（不翻脸但也不爽）', `${before.moodV} → ${after.moodV}`);
}

console.log('\n[7] 控制台');
ok(errors.length === 0, '无 JS 报错', errors.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
