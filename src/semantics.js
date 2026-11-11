/**
 * 文本语义 → 表情推断层。
 *
 * 问题：靠模型主动打 `<e:joy:0.8>` 只能覆盖"听话的大模型"。
 * 一旦接本地小模型、或者模型这句忘了打标签，脸立刻变木头。
 * 用户看到的是"念稿的假人"，而不是"听得懂话的人"。
 *
 * 所以这里做一件模型不做的事：**读文本本身**。
 *   · 词级情感词表（中文，按 8 类情绪分强度档）
 *   · 程度副词放大/缩小（"非常开心" vs "有点开心"）
 *   · 否定翻转（"不开心" 绝不能识别成开心——这是最典型的翻车点）
 *   · 句末语气（！加重、？转思考、……转迟疑）
 *   · 句式语义（疑问/不确定/共情/道歉/鼓励 → 不只是情绪，还有社交姿态）
 *
 * 时序：表情必须挂在话语时钟上，不能跟 token 走。所以输出的是「带字符偏移
 * 的事件」，交给 Segmenter 与标签事件一起排进同一句话。
 *
 * 与标签的关系：标签优先。同一句里模型打过 expr，就丢掉这层的 expr（保留
 * 眼神/微表情/底色）。这样"模型可控"和"没标签也有表情"两件事同时成立。
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const MAXW = 5;

// ---------------------------------------------------------------- 词表

/** 词 -> { e: 表情, s: 基础强度, neg: 否定后改用的表情（缺省=不产出） } */
const LEX = new Map();

function add(words, e, s, neg) {
  for (const w of words.split(' ')) if (w) LEX.set(w, { e, s, neg });
}

// 喜悦
add('太好了 太棒了 好极了 棒极了 简直完美 爱死了 无敌 超赞 笑死 完美 太爽', 'joy', 0.92, 'sadness');
add(
  '开心 高兴 快乐 喜悦 兴奋 幸福 满足 满意 期待 惊喜 顺利 成功 通过 搞定 赢了 升职 加薪 中了 中奖 好棒 真棒 太赞 厉害 了不起 恭喜 赞 棒 不错 喜欢 爱了 舒服 好吃 好看 好玩 轻松 放心 哈哈 嘿嘿 嘻嘻 谢谢 感谢 爱你 好耶 走运 幸运 划算 赚了',
  'joy',
  0.72,
  'sadness'
);
add('还行 挺好 有意思 有趣 靠谱 同意 支持 可以 笑', 'joy', 0.48, 'sadness');

// 悲伤 / 低落
add('崩溃 绝望 痛不欲生 太难了 想哭 大哭 心碎 撑不住 熬不住', 'sadness', 0.9);
add(
  '难过 伤心 悲伤 失落 沮丧 委屈 痛苦 难受 郁闷 无奈 孤独 遗憾 后悔 哭 眼泪 累 心累 心疼 可怜 失败 被骂 挨骂 批评 分手 离婚 去世 生病 加班 走了 失去 灰心 丧 哭了 掉眼泪',
  'sadness',
  0.7
);
add('辛苦 不容易 我理解 我懂 抱抱 遗憾 可惜 心疼 担心你 糟糕', 'sadness', 0.5, 'sadness');

// 愤怒
add('气死 火大 愤怒 太过分 忍不了 混蛋 欺人太甚 离谱 凭什么', 'anger', 0.88);
add('生气 恼火 气愤 烦躁 烦死 可恶 不公平 欺负 甩锅 破公司 忍无可忍 窝火 憋屈 投诉', 'anger', 0.68);
add('不满 抱怨 烦 烦人 吵', 'anger', 0.45);

// 惊讶
add('天哪 天啊 我的天 真的假的 不可能 不敢相信 没想到 居然 竟然 震惊 吓了一跳 绝了', 'surprise', 0.88);
add('惊讶 吃惊 意外 突然 原来如此 哇 神奇 厉害啊 这也行', 'surprise', 0.66);

// 恐惧 / 担忧
add('害怕 恐惧 吓死 恐怖 可怕 慌了 心惊 毛骨悚然', 'fear', 0.85);
add('担心 紧张 焦虑 不安 怕 忐忑 压力 危险 风险 万一 失眠 慌 头疼 棘手 麻烦', 'fear', 0.62);

// 厌恶
add('恶心 变态 恶臭 恶心死了 糟心', 'disgust', 0.82);
add('厌恶 反感 嫌弃 讨厌 无语 受不了 油腻 敷衍 糊弄 做作', 'disgust', 0.62);

// 思考 / 疑惑 / 迟疑（含"社交姿态"而不只是情绪）
add('为什么 怎么办 怎么弄 是不是 要不要 该不该 能不能 会不会 什么意思 不太懂 不明白 想不通 搞不懂', 'thinking', 0.64);
add(
  '纠结 犹豫 考虑 分析 取决于 看情况 可能 也许 大概 或许 说不定 让我想想 换句话说 本质上 其实 说白了 总的来说',
  'thinking',
  0.44
);
add('嗯 唔 呃 诶', 'thinking', 0.3);

// 社交姿态：这些不是"情绪"，但人说话时脸上一定有对应的东西
add('抱歉 对不起 不好意思 失礼 我的错 唐突', 'sadness', 0.56);
add('加油 你可以的 试试看 没问题 别担心 没关系 会好的 慢慢来 稳住 别急', 'joy', 0.52);
add('确实 是的 没错 当然 对的 就是这样 我同意', 'joy', 0.4);
add('必须 千万 绝对 一定 真的 简直 竟然 偏偏 难道 说到底', 'thinking', 0.3);

/**
 * 句式模式：中文的情绪常常不落在某个词上，而落在结构里。
 * "被老板当着所有人骂了一顿" 没有任何一个词叫"难过"，但它就是难过的句子。
 * 词表补不了这种，正则能。
 */
const PATTERNS = [
  [/被[^，。！？；\n]{1,6}(骂|批|怼|吼|凶|裁|开除|辞退|投诉|针对|孤立|骗|坑|甩锅)/, 'sadness', 0.74],
  [/(骂|怼|吼|凶|说)了?我(一顿|一通|几句)?/, 'sadness', 0.62],
  [/(升职|加薪|涨薪|转正|拿到offer|录取|上岸|过面)/i, 'joy', 0.82],
  [/(中奖|中彩票|彩票|发奖金|涨工资)/, 'joy', 0.84],
  [/(分手|离婚|失恋|离世|去世|走了|过世)/, 'sadness', 0.86],
  [/(裁员|被裁|失业|下岗|降薪)/, 'fear', 0.72],
  [/(加班|熬夜|通宵|996)/, 'sadness', 0.6],
  [/(看病|住院|手术|发烧|感冒|生病)/, 'sadness', 0.55],
  [/(吵架|吵了一架|闹翻|翻脸)/, 'anger', 0.72],
  [/(表白|求婚|在一起)/, 'joy', 0.7],
  [/(迟到|堵车|错过|忘了|搞砸|弄错)/, 'fear', 0.55],
];

/** 强调词：只触发一个眉部微表情，不给整体表情 */
const EMPHASIS = ['真的', '一定', '千万', '绝对', '必须', '居然', '竟然', '简直', '偏偏', '难道', '说到底'];

/**
 * 单字词。中文单字情绪词信息量高但误报率也高（"哪怕""积累""麻烦"），
 * 所以单独一张小表，权重压低，并且看前一个字是不是构词成分。
 */
const SINGLE = new Map([
  ['嗯', ['thinking', 0.3]],
  ['唔', ['thinking', 0.3]],
  ['呃', ['thinking', 0.32]],
  ['诶', ['thinking', 0.3]],
  ['哇', ['surprise', 0.55]],
  ['怕', ['fear', 0.55]],
  ['慌', ['fear', 0.5]],
  ['烦', ['anger', 0.45]],
  ['怒', ['anger', 0.6]],
  ['累', ['sadness', 0.5]],
  ['哭', ['sadness', 0.55]],
  ['惨', ['sadness', 0.55]],
  ['糟', ['sadness', 0.45]],
  ['骂', ['sadness', 0.55]],
  ['怼', ['anger', 0.5]],
  ['笑', ['joy', 0.4]],
  ['赞', ['joy', 0.5]],
  ['棒', ['joy', 0.6]],
]);

/** 这些字在单字前面时，说明它只是构词部件（哪怕 / 积累 / 连累 …） */
const SINGLE_SKIP = new Set(['哪', '积', '连', '牵', '生', '玩', '搞', '取', '见', '嘲', '冷', '苦', '劳', '疲', '麻', '干', '拔', '比', '一', '即', '压', '劳']);

// ---------------------------------------------------------------- 修饰语

const NEGATORS = ['不', '没', '无', '未', '勿', '甭', '莫'];
const NEG_MULTI = ['并不', '不太', '不怎么', '没有', '毫无', '绝不', '从不', '从未', '不会', '不想', '不敢', '不能', '不是'];
/** "不" 开头的连词/副词，不表达否定 */
const NEG_EXEMPT = ['不但', '不仅', '不过', '不然', '不断', '不少', '不禁', '不由得', '不管', '不论', '不得不', '不得了', '无比', '无论', '无数'];

/**
 * 反问句：字面是肯定，意思是否定。
 * "这有什么好开心的" 如果按字面打上 joy，是整个系统最难解释的 bug。
 */
const REBUTTAL = [/有什么好.{0,8}的/, /哪有那?么/, /怎么可能/, /才不.{0,3}呢/, /想得美/, /未必/, /不见得/, /说什么也/];
const REBUTTAL_EXEMPT = /有什么关系|没什么关系|有什么大不了|有什么好怕/;

const INTENS = [
  ['非常', 1.35], ['特别', 1.35], ['超级', 1.38], ['极其', 1.45], ['十分', 1.3],
  ['格外', 1.3], ['相当', 1.24], ['真的', 1.28], ['真是', 1.22], ['简直', 1.4],
  ['完全', 1.28], ['太', 1.34], ['好', 1.2], ['很', 1.2], ['最', 1.36], ['更', 1.14],
  ['巨', 1.34], ['超', 1.28], ['贼', 1.34], ['老', 1.16], ['可', 1.14], ['挺', 1.14], ['蛮', 1.05],
];
const WEAK = [
  ['有点', 0.62], ['有些', 0.66], ['稍微', 0.6], ['一点', 0.64], ['略', 0.6],
  ['还算', 0.72], ['比较', 0.82], ['不太', 0.5], ['稍微有点', 0.58],
];

/** 允许混合的表情对（"惊喜""苦笑""鄙视"——混对了才像人，混错了像抽筋） */
const MIX_OK = new Set([
  'joy|surprise',
  'joy|sadness',
  'anger|disgust',
  'anger|sadness',
  'fear|sadness',
  'sadness|surprise',
  'sadness|thinking',
  'joy|thinking',
  'surprise|thinking',
  'anger|thinking',
]);

/** 情绪 -> 效价/唤醒，用于 L0 底色 */
const VA = {
  joy: [0.7, 0.35],
  sadness: [-0.62, -0.28],
  anger: [-0.68, 0.62],
  surprise: [0.12, 0.82],
  fear: [-0.58, 0.7],
  disgust: [-0.66, 0.24],
  thinking: [0.02, 0.14],
  neutral: [0, 0],
};

const GAZE = {
  sadness: 'away',
  thinking: 'think',
  fear: 'camera',
  anger: 'camera',
  disgust: 'away',
  surprise: 'camera',
  joy: 'camera',
};

/** 强情绪配一个微表情，让"啪一下变脸"变成"眉梢先动" */
const MICRO_FOR = {
  joy: ['smileL', 'smileR'],
  sadness: ['lip', 'press'],
  anger: ['press', 'nose'],
  surprise: ['brow', 'brow'],
  fear: ['eyeL', 'eyeR'],
  disgust: ['nose'],
  thinking: ['brow'],
};

// ---------------------------------------------------------------- 工具

/** 取词前 4 字的窗口，遇标点截断（程度副词/否定只在同一小句内生效） */
function windowBefore(buf, i, span = 4) {
  const start = Math.max(0, i - span);
  let w = buf.slice(start, i);
  const p = w.search(/[，。！？、；,.!?;…\s]/);
  if (p >= 0) w = w.slice(p + 1);
  return w;
}

function degreeOf(w) {
  let strong = 1;
  for (const [k, v] of INTENS) if (w.includes(k) && v > strong) strong = v;
  let weak = 1;
  for (const [k, v] of WEAK) if (w.includes(k) && v < weak) weak = v;
  return Math.min(strong, weak === 1 ? strong : weak);
}

/**
 * "别" 是最容易误伤的一个字：它是否定词，但也是"特别/区别/告别/别人"的构词部件。
 * "我真的特别开心" 被判成悲伤，就是被"特别"里的"别"吃掉了——所以要看前一个字。
 */
const BIE_COMPOUND = new Set(['特', '区', '告', '人', '性', '分', '级', '类', '识', '鉴', '离', '诀', '作', '派', '各', '差', '干', '个']);

function hasNegBie(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '别') continue;
    if (s[i + 1] === '人') continue;
    if (i > 0 && BIE_COMPOUND.has(s[i - 1])) continue;
    return true;
  }
  return false;
}

function isNegated(w) {
  if (!w) return false;
  let s = w;
  for (const ex of NEG_EXEMPT) s = s.split(ex).join('');
  for (const k of NEG_MULTI) if (s.includes(k)) return true;
  for (const c of NEGATORS) if (s.includes(c)) return true;
  return hasNegBie(s);
}

const mixKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------- 单句打分

/**
 * 对一句文本打分。
 * 返回 { scores, first, emph, hits }：
 *   scores 各情绪 0~1；first 该情绪首次出现的位置（用于把表情提前到词头）
 */
export function scoreClause(text) {
  const scores = {};
  const first = {};
  const hits = [];
  let emphAt = -1;

  const put = (e, s, at) => {
    scores[e] = 1 - (1 - (scores[e] || 0)) * (1 - clamp01(s));
    if (!(e in first)) first[e] = at;
    hits.push({ e, s: clamp01(s), at });
  };

  // 先跑句式模式：结构性的情绪比单个词更可靠
  const ranges = [];
  for (const [re, e, s] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const before = windowBefore(text, m.index, 5);
    if (isNegated(before)) continue;
    put(e, s, m.index);
    ranges.push([m.index, m.index + m[0].length]);
  }

  let i = 0;
  while (i < text.length) {
    // 强调词（不影响整体表情，只挑一下眉）
    if (emphAt < 0) {
      for (const w of EMPHASIS) {
        if (text.startsWith(w, i)) {
          emphAt = i;
          break;
        }
      }
    }

    let hit = null;
    for (let L = Math.min(MAXW, text.length - i); L >= 2; L--) {
      const w = text.slice(i, i + L);
      const e = LEX.get(w);
      if (e) {
        hit = { w, e, L };
        break;
      }
    }
    if (!hit) {
      // 单字兜底：先排除"哪怕""积累"这类构词
      const ch = text[i];
      const single = SINGLE.get(ch);
      if (single && !(i > 0 && SINGLE_SKIP.has(text[i - 1]))) {
        hit = { w: ch, e: { e: single[0], s: single[1] }, L: 1 };
      }
    }
    if (!hit) {
      i++;
      continue;
    }

    // 已被句式模式覆盖的片段不再按词重复计分（"中奖" 会被 LEX 和 PATTERN 各加一次）
    if (ranges.some(([a, b]) => i >= a && i < b)) {
      i += hit.L;
      continue;
    }

    const before = windowBefore(text, i);
    const deg = degreeOf(before);
    let expr = hit.e.e;
    let strength = hit.e.s * deg;

    if (isNegated(before)) {
      // 区分两种"否定"：
      //   "别难过"  祈使 → 说话人在安慰，脸上应该是关切（低强度悲伤）
      //   "不难过"  陈述 → 只是否认了这个情绪，不该反过来长出一张悲伤的脸
      const comforting = hasNegBie(before) && (hit.e.e === 'sadness' || hit.e.e === 'fear');
      if (comforting) {
        expr = 'sadness';
        strength *= 0.45;
      } else if (!hit.e.neg) {
        i += hit.L;
        continue;
      } else {
        // "不开心" → 悲伤：正向被否定，翻成反向
        expr = hit.e.neg;
        strength *= 0.72;
      }
    }

    // 概率式合并：多个同向词叠加趋于饱和，而不是越加越爆
    put(expr, strength, i);
    hits[hits.length - 1].w = hit.w;

    i += hit.L;
  }

  // 反问句：整句极性翻转。"这有什么好开心的" 按字面打上 joy，是整个系统最难解释的 bug
  if (!REBUTTAL_EXEMPT.test(text) && REBUTTAL.some((re) => re.test(text))) {
    for (const k of Object.keys(scores)) scores[k] *= 0.18;
    scores.disgust = Math.max(scores.disgust || 0, 0.52);
    if (!('disgust' in first)) first.disgust = 0;
  }

  return { scores, first, emphAt, hits };
}

/** 句末语气修正 */
function applyPunct(scores, punct, len) {  if (punct === '！' || punct === '!') {
    for (const k of Object.keys(scores)) scores[k] = clamp01(scores[k] * 1.22 + 0.04);
  } else if (punct === '？' || punct === '?') {
    const top = Math.max(0, ...Object.values(scores));
    if (top < 0.3) {
      scores.thinking = Math.max(scores.thinking || 0, 0.46);
    } else if (top < 0.65) {
      // 问句里的情绪通常是轻的，主导权给"在想"这件事
      for (const k of Object.keys(scores)) scores[k] *= 0.6;
      scores.thinking = Math.max(scores.thinking || 0, 0.54);
    } else {
      for (const k of Object.keys(scores)) scores[k] *= 0.9;
      scores.thinking = Math.max(scores.thinking || 0, 0.22);
    }
  } else if (punct === '…' || punct === '⋯') {
    const top = Math.max(0, ...Object.values(scores));
    if (top < 0.5) scores.thinking = Math.max(scores.thinking || 0, 0.42);
    else for (const k of Object.keys(scores)) scores[k] *= 0.9;
  } else if (punct === '，' || punct === ',') {
    // 逗号不算句末，不打折——但长句被硬切时要避免把小句情绪当成整句
    if (len > 30) for (const k of Object.keys(scores)) scores[k] *= 0.94;
  }
  return scores;
}

// ---------------------------------------------------------------- 增量分析器

const CLAUSE_END = '。！？!?…⋯\n；;';
const SOFT_END = '，,、';

/**
 * 流式分析器。每块可见文本喂进来，立刻返回带**绝对字符偏移**的事件。
 *
 * 关键点：同一子句内是「重扫」而不是「续算」。子句长度 <40 字，重扫成本可忽略，
 * 但换来两个好处——跨 chunk 被切断的词（"太" | "好了"）能被正确匹配；
 * 提前触发不会重复计分（幂等）。
 */
export class SemanticAnalyzer {
  constructor(opts = {}) {
    /** 整段对话的情绪底色，缓慢累积 */
    this.mood = { v: 0, a: 0 };
    this.consumed = 0;
    this.clause = '';
    this.clauseStart = 0;
    /** 本子句已提前发出的 expr（避免一句话反复变脸） */
    this.emitted = null;
    this.emphDone = false;
    this.microDone = false;
    this.enabled = opts.enabled !== false;
    this.clauses = 0;
    this.lastResult = null;
    /** 整段累积分数：一次性分析要用它，而不是"最后一句" */
    this.agg = {};
    /** 跨句"脸上现在挂着的表情"，用来决定什么时候该回中性 */
    this.lastExpr = null;
  }

  reset() {
    this.clause = '';
    this.clauseStart = this.consumed;
    this.emitted = null;
    this.emphDone = false;
    this.microDone = false;
  }

  /** 整段重置（新一轮对话） */
  resetAll() {
    this.consumed = 0;
    this.reset();
    this.clauses = 0;
    this.agg = {};
    this.lastExpr = null;
  }

  /**
   * 喂入一块可见文本。
   * @returns {{charOffset:number, ev:object}[]}
   */
  feed(text) {
    if (!text) return [];
    const out = [];
    for (const ch of text) {
      this.clause += ch;
      this.consumed++;
      if (CLAUSE_END.includes(ch)) {
        this._submit(out, ch);
      } else if (SOFT_END.includes(ch) && this.clause.length >= 30) {
        this._submit(out, ch);
      }
    }
    // 子句还没结束：允许"提前起势"，长句子才不会前半截是木头
    if (this.enabled) this._early(out);
    return out;
  }

  /** 流结束，把残留子句结算掉 */
  end() {
    const out = [];
    if (this.clause.trim()) this._submit(out, '。');
    return out;
  }

  /** 尚未说完时，若情绪已经足够明确就提前给表情 */
  _early(out) {
    if (this.clause.length < 5) return;
    const r = scoreClause(this.clause);
    const best = topTwo(r.scores);
    if (!best.a || best.va < 0.52) return;
    if (this.emitted && this.emitted.name === best.na) {
      // 同一情绪后续更强 → 允许加码一次
      if (best.va <= this.emitted.score * 1.3) return;
    }
    const off = this.clauseStart + Math.max(0, r.first[best.na] - 2);
    const name = this._pickMix(best.na, best.nb, best.va, best.vb);
    const ev = {
      type: 'expr',
      name,
      mix: this._mixList(best.na, best.nb, best.va, best.vb),
      intensity: clamp01(best.va * 0.85 + 0.1),
      src: 'sem',
      hold: 2.2,
    };
    this.emitted = { name: best.na, score: best.va };
    this.lastExpr = best.na;
    out.push({ charOffset: off, ev });
    this._pushGaze(out, best.na, best.va, off, true);
  }

  /** 结算一个子句 */
  _submit(out, punct) {
    const raw = this.clause;
    const start = this.clauseStart;
    this.clause = '';
    this.clauseStart = this.consumed;
    this.clauses++;

    if (!raw.trim()) {
      this.emitted = null;
      return;
    }

    let r = scoreClause(raw);
    r.scores = applyPunct(r.scores, punct, raw.length);

    for (const [k, v] of Object.entries(r.scores)) this.agg[k] = 1 - (1 - (this.agg[k] || 0)) * (1 - v);

    const best = topTwo(r.scores);
    const at = normalizeAt(raw.length, start);

    if (!best.a) {
      // 整句没有任何情绪：明确回到中性，否则上一句的表情会一直挂着
      if (this.lastExpr && this.lastExpr !== 'neutral') {
        out.push({ charOffset: at(0), ev: { type: 'expr', name: 'neutral', intensity: 0.5, src: 'sem' } });
        this.lastExpr = 'neutral';
      }
      this.lastResult = { name: 'neutral', score: 0, valence: 0, arousal: 0 };
    } else {
      const score = best.va;
      const name = this._pickMix(best.na, best.nb, best.va, best.vb);
      const mix = this._mixList(best.na, best.nb, best.va, best.vb);
      // 已提前发过同一情绪就不再重复触发，避免一句话里两次跳变
      const same = this.emitted && this.emitted.name === best.na;
      if (!same || score > this.emitted.score * 1.18) {
        // 句末语气（？…！）注入的情绪没有"触发词"，回落到句中偏后，
        // 不能挂在句首——否则句子刚开口脸就已经做出"这是问句"的判断
        const firstAt = r.first[best.na];
        const off = at(firstAt === undefined ? Math.floor(raw.length * 0.55) : Math.max(0, firstAt - 2));
        out.push({
          charOffset: off,
          ev: { type: 'expr', name, mix, intensity: clamp01(score * 0.94 + 0.06), src: 'sem' },
        });
        this.lastExpr = best.na;
        this._pushGaze(out, best.na, score, off, false);
        this._pushMicro(out, best.na, score, r, at);
      }
      this.lastResult = { name, score: clamp01(score), valence: VA[best.na]?.[0] || 0, arousal: VA[best.na]?.[1] || 0 };
    }

    // L0 底色：按 26% 权重把本句情绪融进整段心情，一句一变脸是不可能的
    const va = VA[best.a] || [0, 0];
    this.mood.v = this.mood.v * 0.74 + va[0] * (best.va || 0) * 0.26;
    this.mood.a = this.mood.a * 0.74 + va[1] * (best.va || 0) * 0.26;
    out.push({
      charOffset: at(0),
      ev: {
        type: 'emotion',
        valence: clamp(this.mood.v * 1.6, -1, 1),
        arousal: clamp(this.mood.a * 1.6, -1, 1),
        src: 'sem',
      },
    });

    this.emitted = null;
    this.emphDone = false;
    this.microDone = false;
  }

  _pickMix(a, b, sa, sb) {
    const list = this._mixList(a, b, sa, sb);
    return list.length > 1 ? list[0].name : a;
  }

  _mixList(a, b, sa, sb) {
    if (!b) return [{ name: a, w: 1 }];
    if (!MIX_OK.has(mixKey(a, b))) return [{ name: a, w: 1 }];
    if (sb < sa * 0.36) return [{ name: a, w: 1 }];
    const main = 0.68;
    return [{ name: a, w: main }, { name: b, w: 1 - main }];
  }

  _pushGaze(out, name, score, off, early) {
    const target = GAZE[name];
    if (!target) return;
    if (score < 0.5) return;
    if (name === 'joy' && !early) return; // 开心不必每次都盯镜头
    out.push({ charOffset: off, ev: { type: 'gaze', target, src: 'sem' } });
  }

  _pushMicro(out, name, score, r, at) {
    // 强调词 → 眉梢一挑（比整体表情更早、更快，像真人说话的手势）
    if (r.emphAt >= 0 && score >= 0.35) {
      out.push({
        charOffset: at(r.emphAt),
        ev: { type: 'micro', part: 'brow', intensity: 0.5 + score * 0.3, src: 'sem' },
      });
    }
    if (score < 0.78) return;
    const parts = MICRO_FOR[name];
    if (!parts) return;
    const part = parts[(Math.random() * parts.length) | 0];
    out.push({ charOffset: at(0), ev: { type: 'micro', part, intensity: 0.55 + score * 0.3, src: 'sem' } });
  }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 偏移工具：把句内下标换成整段对话的绝对字符偏移（下游 Segmenter 按绝对偏移分句） */
function normalizeAt(len, start) {
  const last = Math.max(0, len - 1);
  return (i) => start + Math.max(0, Math.min(last, i));
}

function topTwo(scores) {
  const arr = Object.entries(scores)
    .filter(([k, v]) => k !== 'neutral' && v > 0.02)
    .sort((a, b) => b[1] - a[1]);
  return {
    a: arr[0] ? arr[0][0] : null,
    va: arr[0] ? arr[0][1] : 0,
    b: arr[1] ? arr[1][0] : null,
    vb: arr[1] ? arr[1][1] : 0,
    na: arr[0] ? arr[0][0] : null,
    nb: arr[1] ? arr[1][0] : null,
  };
}

// ---------------------------------------------------------------- 一次性分析

/**
 * 对一段完整文本做分析，返回整段的主导情绪与混合方案。
 * 用于"听到用户说话时的即时反应"——用户的话已经说完，不必挂在话语时钟上。
 *
 * 注意取的是**整段累积**而不是最后一句：用户说"真的假的？你中奖了？"，
 * 反应该是惊讶，不是最后一问的思索。
 */
export function analyzeText(text) {
  const a = new SemanticAnalyzer();
  const src = String(text || '');
  a.feed(src);
  a.end();
  const best = topTwo(a.agg);
  if (!best.a) return { name: 'neutral', mix: [{ name: 'neutral', w: 1 }], score: 0, valence: 0, arousal: 0, mood: { ...a.mood } };
  const mix = a._mixList(best.na, best.nb, best.va, best.vb);
  const va = VA[best.a] || [0, 0];
  return {
    name: mix.length > 1 ? mix[0].name : best.a,
    mix,
    score: clamp01(best.va),
    valence: va[0],
    arousal: va[1],
    mood: { ...a.mood },
  };
}
