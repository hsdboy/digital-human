/**
 * 语义推断层单测。
 *
 * 重点不是"认得对"，而是"不会认错"——否定、程度、句末语气是三个主要翻车点。
 * 每条都断言主表情，少数断言强度区间（程度副词必须真的改变幅度）。
 */

import { analyzeText, scoreClause } from '../src/semantics.js';

let pass = 0;
let fail = 0;
const fails = [];

function check(text, want, opts = {}) {
  const r = analyzeText(text);
  const okName = Array.isArray(want) ? want.includes(r.name) : r.name === want;
  const okMin = opts.min === undefined || r.score >= opts.min;
  const okMax = opts.max === undefined || r.score <= opts.max;
  const ok = okName && okMin && okMax;
  if (ok) pass++;
  else {
    fail++;
    fails.push(
      `「${text}」 → ${r.name}(${r.score.toFixed(2)})  期望 ${Array.isArray(want) ? want.join('|') : want}` +
        (opts.min !== undefined ? ` ≥${opts.min}` : '') +
        (opts.max !== undefined ? ` ≤${opts.max}` : '')
    );
  }
  return r;
}

console.log('— 基础情绪 —');
check('太好了！我终于升职了', 'joy');
check('我今天特别不开心', 'sadness');
check('真是难过的一天', 'sadness');
check('气死我了，他们又甩锅给我', 'anger');
check('真的假的？你中奖了？', 'surprise');
check('我有点担心这个方案的风险', 'fear');
check('这家店的东西太恶心了', 'disgust');
check('为什么会这样呢？', 'thinking');
check('嗯……让我想想', 'thinking');

console.log('— 否定 / 程度 —');
check('我不觉得开心', 'sadness');
check('这没什么好高兴的', ['sadness', 'neutral', 'thinking']);
check('我一点都不难过', ['joy', 'neutral', 'thinking']);
check('非常非常开心', 'joy', { min: 0.85 });
check('有点难过', 'sadness', { max: 0.6 });
check('挺开心的', 'joy');
check('我不是很高兴', ['sadness', 'neutral']);

console.log('— 句末语气 —');
check('你明天来吗？', 'thinking');
check('好吧…', 'thinking');
check('这也太离谱了吧！', 'anger');

console.log('— 社交姿态 —');
check('抱歉，我来晚了', 'sadness');
check('没关系，别担心，会好的', 'joy');
check('辛苦你了，真的不容易', 'sadness');
check('你说得对，确实是这样', 'joy');
check('让我想想…可能是时间问题', 'thinking');

console.log('— 中性不误报 —');
check('我在听你说', 'neutral');
check('今天星期三', 'neutral');
check('把文件放在桌子上', 'neutral');
check('水温是六十度', 'neutral');

console.log('— 混合表情 —');
const mix = analyzeText('太好了，不过我也有点担心后面会出问题');
console.log('   混合句 →', mix.name, mix.score.toFixed(2));

console.log('— 强度单调性 —');
const weak = analyzeText('有点开心');
const mid = analyzeText('开心');
const strong = analyzeText('非常开心');
console.log(`   有点开心 ${weak.score.toFixed(2)} < 开心 ${mid.score.toFixed(2)} < 非常开心 ${strong.score.toFixed(2)}`);
if (!(weak.score < mid.score && mid.score < strong.score)) {
  fail++;
  fails.push('强度未随程度副词单调递增');
} else pass++;

console.log('— 增量重扫不会重复计分 —');
const a = analyzeText('我今天真的很开心');
const b = analyzeText('我今天真的很开心');
if (Math.abs(a.score - b.score) < 1e-9) pass++;
else {
  fail++;
  fails.push('重扫结果不稳定');
}

console.log('\n— 逐块流式（模拟 token 切断）—');
{
  const t = '太好了！我终于升职了。不过也有点担心新岗位压力太大。';
  const { SemanticAnalyzer } = await import('../src/semantics.js');
  const an = new SemanticAnalyzer();
  const evs = [];
  for (let i = 0; i < t.length; i += 2) evs.push(...an.feed(t.slice(i, i + 2)));
  evs.push(...an.end());
  const kinds = evs.map((e) => `${e.ev.type}:${e.ev.name || e.ev.target || e.ev.part}:${e.charOffset}`);
  console.log('   ' + kinds.join('  '));
  const hasJoy = evs.some((e) => e.ev.type === 'expr' && (e.ev.name === 'joy' || (e.ev.mix || []).some((m) => m.name === 'joy')));
  const hasFear = evs.some((e) => e.ev.type === 'expr' && (e.ev.name === 'fear' || (e.ev.mix || []).some((m) => m.name === 'fear')));
  const offsetsOk = evs.every((e) => e.charOffset >= 0 && e.charOffset <= t.length);
  if (hasJoy && hasFear && offsetsOk) pass++;
  else {
    fail++;
    fails.push(`流式：joy=${hasJoy} fear=${hasFear} offsets=${offsetsOk}`);
  }
}

console.log('\n— 分句打分 —');
for (const s of ['我真的特别开心', '这有什么好开心的', '一点都不好笑']) {
  const r = scoreClause(s);
  console.log('   ' + s + ' → ' + JSON.stringify(Object.fromEntries(Object.entries(r.scores).map(([k, v]) => [k, +v.toFixed(2)]))));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
