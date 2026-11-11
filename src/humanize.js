/**
 * 口语化后处理：把模型的「书面 AI 腔」掰回人话。
 *
 * 为什么必须有这一层：7B 模型即使被明确要求"不要列点、不要总结"，
 * 仍然会以相当高的概率冒出「首先……其次……」「总之」「希望对你有所帮助」。
 * prompt 是概率约束，后处理是确定性约束。真人感这种东西不能交给概率。
 *
 * 改文本有个硬约束：表情事件的 charOffset 挂在字符坐标上。
 * 所以这里只做三类操作，每一类都能精确算出偏移怎么变：
 *   ① 等长替换（首先→其实）          偏移不变
 *   ② 段首/段尾删除（客服套话）        段首删除要整体左移，段尾不影响
 *   ③ 段首插入（口癖）                整体右移
 * 绝不在句子中间做长度变化，一旦做了，表情就会提前或滞后。
 */

/** 等长替换表。两个词长度必须一致，否则偏移会错 */
const SWAP = [
  ['首先', '其实'],
  ['其次', '然后'],
  ['再者', '还有'],
  ['最后', '还有'],
  ['总之', '反正'],
  ['综上', '反正'],
  ['因此', '所以'],
  ['然而', '可是'],
  ['并且', '而且'],
  ['此外', '另外'],
  ['非常', '特别'],
  ['十分', '挺'],
  ['较为', '比较'],
  ['是否', '是不是'.slice(0, 2)],
  ['以及', '还有'],
  ['从而', '这样'],
  ['使得', '让'],
  ['进行', '做'],
  ['此外', '另外'],
  ['例如', '比如'],
  ['即', '就'],
].filter(([a, b]) => a.length === b.length);

/** 句首客服腔：整段删掉 */
const PREFIX = [
  /^作为(一个)?(AI|人工智能|语言模型|数字人|助手)[^，,。！!]{0,12}[，,。：:]\s*/,
  /^(当然(可以|没问题|啦))[！!。，,]?\s*/,
  /^(好的|好呀|行)[，,。！!]\s*/,
  /^(没问题)[，,。！!]\s*/,
  /^(我(很)?(高兴|荣幸)(为你|为您)?(解答|回答|介绍))[^，,。！!]{0,10}[，,。：:]\s*/,
  /^嗯[，,]\s*好的[，,]\s*/,
  // 信件格式：模型偶尔会突然切换成公文，一句"阿泽，你好："就把人设毁了
  /^(尊敬|亲爱)的[^，,。！!：:]{1,8}[，,：:]\s*/,
  /^[^\s，,。！!]{1,6}[，,]\s*你好[：:，,]\s*/,
  /^你好[：:，,]\s*/,
];

/** 句尾客服腔：整段删掉 */
const SUFFIX = [
  /[，,]?\s*希望(这|以上)?(对你|能对你|对你)(有所)?帮助[。！!]?$/,
  /[，,]?\s*如果(你)?还有(其他|别的)?(问题|疑问)[^。！!]{0,12}[。！!？?]?$/,
  /[，,]?\s*还有(什么)?(可以|需要)(帮|为)(到)?你的?[^。！!]{0,8}[。！!？?]?$/,
  /[，,]?\s*祝(你)?(生活)?(愉快|顺利)[。！!]?$/,
  /[，,]?\s*(总之|综上)[^。！!]{0,6}[。！!]?$/,
  // 公文尾巴
  /[，,]?\s*以上[，,]?(谢谢|请知悉|供参考)?[。！!]?$/,
  /[，,]?\s*谢谢[。！!]?$/,
  /[，,]?\s*请(你)?(过目|查阅|参考)[。！!]?$/,
];

/**
 * 入口清洗：流式文本进 TagParser 之前先过一遍。
 * 这一步是安全的——TagParser 的字符计数基于「清洗后的文本」，
 * 位置自洽，不会影响任何偏移。
 */
export function cleanStream(s) {
  return String(s)
    .replace(/\*\*|__|`{1,3}/g, '')   // markdown 强调会念出"星号"
    .replace(/^#{1,6}\s+/gm, '')      // 标题
    .replace(/^[-*•]\s+/gm, '')       // 列表符号
    .replace(/^\d+[.、)]\s+/gm, '')   // 序号
    // 连打省略号/句号：模型常写「啊这…………」或「好。。。」，
    // TTS 会真的拖长，听起来像卡带
    .replace(/…{3,}/g, '……')
    .replace(/。{2,}/g, '。')
    .replace(/！{2,}/g, '！')
    .replace(/[\u200b-\u200f\ufeff]/g, ''); // 零宽字符
}

/**
 * 段级人化。就地改 seg.text，并同步修正 seg.events 的 charOffset。
 * @param seg  { text, events: [{charOffset, ev}] }
 * @param opts { habits, chatty, chance }
 */
export function humanizeSeg(seg, opts = {}) {
  if (!seg || !seg.text) return seg;
  let text = seg.text;
  const shift = (delta) => {
    if (!delta || !seg.events) return;
    for (const e of seg.events) e.charOffset = Math.max(0, e.charOffset + delta);
  };

  // ① 等长替换
  for (const [a, b] of SWAP) {
    if (text.includes(a)) text = text.split(a).join(b);
  }

  // ② 段首套话：删掉多少，所有偏移就左移多少
  for (const re of PREFIX) {
    const m = text.match(re);
    if (m) {
      const cut = m[0].length;
      // 别把整句删空
      if (text.length - cut >= 2) {
        text = text.slice(cut);
        shift(-cut);
      }
      break;
    }
  }

  // ③ 段尾套话：删尾巴不影响前面任何字符的位置
  for (const re of SUFFIX) {
    const m = text.match(re);
    if (m && text.length - m[0].length >= 2) {
      text = text.slice(0, text.length - m[0].length);
      break;
    }
  }

  // ④ 口癖。低频、只在长句前、且整轮最多一次（由调用方控）
  const habits = opts.habits || [];
  if (habits.length && opts.allowHabit && text.length >= 8) {
    const h = habits[Math.floor(Math.random() * habits.length)];
    // 口癖后面总是跟一个逗号：它本质是个停顿标记，
    // 直接怼出内容会变成"其实吧我觉得"这种一口气说完的怪腔
    const ins = h + '，';
    text = ins + text;
    shift(ins.length);
    if (opts.onHabit) opts.onHabit(h);
  }

  seg.text = text.replace(/\s+$/g, '');
  // 删干净了就别播了，留个标点给调度
  if (!seg.text.trim()) seg.text = '嗯。';
  return seg;
}
