/**
 * 真模型联调：换掉 mock 之后，整条管线还站得住吗。
 *
 * 这一份不是在测"模型好不好"，而是测**模型换人了，管线有没有被带崩**：
 *
 *   1. provider 真的切到了 ollama（不是悄悄退回 mock）
 *   2. 标签协议守住了 —— 真模型很容易把 `<e:joy:0.8>` 写成别的花样，
 *      或者干脆用 markdown 加粗来表达情绪
 *   3. 标签解析成功率 —— 模型吐了标签但解析器看不懂，等于白吐
 *   4. 可见文本干净 —— 不许漏 `<e:...>`，也不许漏 `**` `##` `（微笑）`
 *   5. 脸真的在动，且首响在能忍的范围内
 *
 * 用法：
 *   node scripts/test-ollama.mjs
 *   SENT="我今天被老板骂了" node scripts/test-ollama.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const SENTS = (process.env.SENT || '我今天被老板当着所有人骂了一顿|我升职了，工资涨了三成').split('|');

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

const status = await fetch(`${BASE}/api/status`).then((r) => r.json()).catch(() => ({}));
console.log('\n[1] 后端');
console.log(`  provider=${status.provider}  model=${status.model || '-'}  tts=${status.tts}`);
ok(status.provider === 'ollama', '已切到真模型（ollama）', status.provider);
ok(!!status.model, '选中了具体模型', status.model || '');
ok(!/mock/i.test(String(status.hint || '')), '没有退回 mock', String(status.hint || '').slice(0, 60));

if (status.provider !== 'ollama') {
  console.log('\n未接真模型，跳过后续断言。');
  process.exit(1);
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__dialogue && window.__rig, { timeout: 25000 });
await page.waitForTimeout(1000);

const provText = await page.evaluate(() => document.getElementById('prov').textContent);
console.log(`  页面显示：${provText}`);
ok(/qwen|llama|mistral|gemma|deepseek/i.test(provText), '页面标注了真实模型名', provText);

console.log('\n[2] 模型是否遵守标签协议（直读原始流，不经前端解析）');

for (const sent of SENTS) {
  const raw = await page.evaluate(async (s) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 服务端只认 message + history（不是 OpenAI 那套 messages 数组），
      // 传错字段的后果是模型收到一句空提问，回一堆无关的话——
      // 表现出来像是模型不行，其实是请求没进去。
      body: JSON.stringify({ message: s, history: [] }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    const t0 = performance.now();
    let ttft = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(blk);
        if (!m) continue;
        try {
          const j = JSON.parse(m[1]);
          if (j.type === 'delta' && j.text) {
            if (!ttft) ttft = performance.now() - t0;
            text += j.text;
          }
        } catch {
          /* 半行 */
        }
      }
    }
    return { text, ttft: Math.round(ttft), ms: Math.round(performance.now() - t0) };
  }, sent);

  const tags = raw.text.match(/<[a-z]:[^>]*>/g) || [];
  const bad = raw.text.match(/<[a-z]:[^>]*?$/g) || [];
  console.log(`  「${sent.slice(0, 16)}」`);
  console.log(`    原始：${raw.text.replace(/\n/g, ' ').slice(0, 110)}`);
  console.log(`    标签 ${tags.length} 个 / TTFT ${raw.ttft}ms / 用时 ${raw.ms}ms`);
  if (tags.length) console.log(`    ${tags.join(' ')}`);

  ok(tags.length >= 1, '模型主动打了表情标签', `${tags.length} 个`);
  ok(!bad.length, '标签都是闭合的（没有半截被截断）');
  ok(!/\*\*|__/.test(raw.text), '没混进 markdown 粗体');
}

console.log('\n[3] 端到端逐句实测');

for (const sent of SENTS) {
  console.log(`\n  「${sent}」`);

  const r = await page.evaluate(async (s) => {
    const t0 = performance.now();
    const ev0 = window.__dialogue.stats().events; // stats 是累计值，要取差值
    const meta = { ttft: 0, done: 0, tags: 0, raw: '' };
    window.__dialogue.ask(s);

    const start = performance.now();
    let lastText = '';
    let sawSpeaking = false;
    let maxJaw = 0;
    const presets = new Set();
    while (performance.now() - start < 90000) {
      const st = window.__dialogue.stats();
      const txt = document.getElementById('say-text').textContent;
      if (txt !== lastText) {
        if (!meta.ttft) meta.ttft = performance.now() - t0;
        lastText = txt;
      }
      maxJaw = Math.max(maxJaw, window.__rig.get('jawOpen') || 0);
      presets.add(st.preset);
      if (st.state === 'speaking') sawSpeaking = true;
      if (sawSpeaking && st.state === 'idle') break;
      await new Promise((res) => setTimeout(res, 60));
    }
    meta.done = performance.now() - t0;
    meta.text = lastText;
    meta.maxJaw = maxJaw;
    meta.presets = [...presets];
    meta.tags = window.__dialogue.stats().events - ev0;
    return meta;
  }, sent);

  const text = r.text || '';
  console.log(`    文本：${text.slice(0, 70)}${text.length > 70 ? '…' : ''}`);
  console.log(`    首字 ${Math.round(r.ttft)}ms / 整轮 ${Math.round(r.done)}ms / 表情事件 ${r.tags} / 表情序列 ${r.presets.join('→')}`);

  ok(text.length > 4, '模型确实回了话', `${text.length} 字`);
  ok(!/<[a-z]:[^>]*>/i.test(text), '标签没有泄漏到可见文本');
  ok(!/[\u4e00-\u9fff][?!,;:]/.test(text), '中文后的半角标点已规范化', (text.match(/[\u4e00-\u9fff][?!,;:]/g) || []).join(' '));
  ok(!/\*\*|^#{1,3}\s|（[^）]{0,10}(笑|叹气|停顿)[^）]{0,10}）/m.test(text), '没有漏出 markdown 或括号旁白', /\*\*/.test(text) ? '含 **' : '');
  ok(r.tags >= 1, '至少解析出一个表情事件', `${r.tags} 个`);
  ok(r.maxJaw > 0.1, '说话时下颌在动（音素层正常）', `max=${r.maxJaw.toFixed(2)}`);
  ok(r.presets.some((p) => p !== 'neutral'), '表情真的切换过', r.presets.join('→'));
  ok(r.ttft < 12000, '首字延迟可接受', `${Math.round(r.ttft)}ms`);
}

console.log('\n[4] 控制台');
ok(errors.length === 0, '无 JS 报错', errors.slice(0, 2).join(' | '));

await page.screenshot({ path: '/tmp/ollama-live.png' });
await browser.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
