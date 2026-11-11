/**
 * 浏览器端验证：文本语义推断 → 表情。
 *
 * 核心要证明的一件事：**模型不打标签时，脸依然跟着内容变**。
 * 所以起两个服务，同一句输入，两种模型行为：
 *   A. MOCK_BARE=1  模型不输出任何标签 → 表情必须来自语义推断（exprSrc=sem）
 *   B. 默认         模型输出标签       → 表情必须来自标签（exprSrc=tag），语义让位
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const proj = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startServer(port, extraEnv = {}) {
  const p = spawn('node', ['server.mjs'], {
    cwd: proj,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve(p);
      }
    };
    p.stdout.on('data', (d) => {
      if (String(d).includes('face →')) setTimeout(fin, 400);
    });
    p.stderr.on('data', () => {});
    setTimeout(fin, 6000);
  });
}

const A = await startServer(5181, { FACE_LLM: 'mock', MOCK_BARE: '1' });
const B = await startServer(5182, { FACE_LLM: 'mock', MOCK_BARE: '0' });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

let fail = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + extra : ''}`);
  }
};

async function openPage(port) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 25000 });
  await page.waitForTimeout(900);
  return { page, errors };
}

const probe = (page) =>
  page.evaluate(() => {
    const d = window.__dialogue.stats();
    const g = (id) => +window.__rig.get(id).toFixed(3);
    return {
      state: d.state,
      preset: d.preset,
      mix: d.mix,
      src: d.exprSrc,
      gain: +d.gain.toFixed(2),
      brow: g('browInnerUp'),
      frown: g('mouthFrownLeft'),
      smile: g('mouthSmileLeft'),
      wide: g('eyeWideLeft'),
      jaw: g('jawOpen'),
      text: document.getElementById('say-text').textContent,
      events: d.events,
      mood: d.mood,
    };
  });

/** 发一句话并采样整段过程 */
async function run(page, text, samples = 70, gap = 130) {
  await page.fill('#ask', text);
  await page.press('#ask', 'Enter');
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < samples; i++) {
    await page.waitForTimeout(gap);
    const s = await probe(page);
    out.push(s);
    if (s.state === 'idle' && s.events > 0 && Date.now() - t0 > 1500) break;
  }
  return out;
}

// ---------------------------------------------------------------- A：不吐标签
console.log('\n【A】模型不输出标签（MOCK_BARE=1）');
{
  const { page, errors } = await openPage(5181);

  // ① 用户说被骂 → 听者反应必须先于助手开口
  await page.fill('#ask', '我今天被老板当着所有人骂了一顿');
  await page.press('#ask', 'Enter');
  await page.waitForTimeout(90);
  const first = await probe(page);
  check('听者反应：用户话音未落就有表情', first.preset !== 'neutral' || first.src === 'hear', `${first.preset}/${first.src}`);

  const sad = [first];
  for (let i = 0; i < 55; i++) {
    await page.waitForTimeout(130);
    const s = await probe(page);
    sad.push(s);
    if (s.state === 'idle' && s.events > 0 && i > 8) break;
  }
  const presets = [...new Set(sad.map((s) => s.preset))];
  const srcs = [...new Set(sad.map((s) => s.src))];
  const maxBrow = Math.max(...sad.map((s) => s.brow));
  const maxFrown = Math.max(...sad.map((s) => s.frown));
  const allText = sad.map((s) => s.text).join('');

  check('表情来自语义推断而非标签', srcs.includes('sem'), srcs.join(','));
  check('出现负面表情（悲伤/思考）', presets.some((p) => ['sadness', 'thinking', 'fear'].includes(p)), presets.join(','));
  check('悲伤时内眉抬起（真实驱动到通道）', maxBrow > 0.12, String(maxBrow));
  check('悲伤时嘴角下沉', maxFrown > 0.08, String(maxFrown));
  check('情感底色变负', Math.min(...sad.map((s) => s.mood.v)) < -0.02, String(Math.min(...sad.map((s) => s.mood.v))));
  check('无标签泄漏', !/<[egmvp]:/.test(allText), allText.slice(0, 40));
  check('说出来了（有可见文本）', allText.length > 8, allText.slice(0, 30));

  // ② 好消息 → 正面表情
  const joy = await run(page, '不过我刚刚中彩票了');
  const joyPresets = [...new Set(joy.map((s) => s.preset))];
  const maxSmile = Math.max(...joy.map((s) => s.smile));
  const maxWide = Math.max(...joy.map((s) => s.wide));
  check('正面内容 → 喜悦/惊讶', joyPresets.some((p) => ['joy', 'surprise'].includes(p)), joyPresets.join(','));
  check('喜悦时嘴角上扬', maxSmile > 0.2, String(maxSmile));

  // ③ 表情确实随时间变化，不是一句话一张脸
  const seq = sad.map((s) => s.preset).filter((p, i, a) => i === 0 || p !== a[i - 1]);
  check('一句话内有表情切换', seq.length >= 2, seq.join('→'));
  console.log('   表情序列：' + seq.join(' → '));
  console.log('   混合：' + [...new Set(sad.concat(joy).map((s) => s.mix.join('+')))].join(' | '));

  // ④ 中性句不该挂表情
  await page.waitForTimeout(2600);
  const idle = await probe(page);
  check('静默后回中性', idle.preset === 'neutral' || idle.gain < 0.6, `${idle.preset}/${idle.gain}`);

  check('A 无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.screenshot({ path: '/tmp/p4-sem.png' });
  await page.close();
}

// ---------------------------------------------------------------- B：有标签 → 标签优先
console.log('\n【B】模型输出标签（默认）');
{
  const { page, errors } = await openPage(5182);
  const s1 = await run(page, '我今天被老板当着所有人骂了一顿');
  const srcs = [...new Set(s1.map((s) => s.src))];
  const presets = [...new Set(s1.map((s) => s.preset))];
  check('表情来源是标签', srcs.includes('tag'), srcs.join(','));
  check('标签生效（出现悲伤）', presets.includes('sadness'), presets.join(','));
  check('B 无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

await browser.close();
A.kill();
B.kill();

console.log(fail ? `\n❌ ${fail} 项未通过` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
