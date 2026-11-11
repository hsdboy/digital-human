/**
 * 内联表情标签：协议定义 + 增量解析器。
 *
 * 设计约束来自大模型的真实行为：
 *  1. 标签会被切成 token 边界，`<e:jo` 和 `y:0.8>` 可能落在两个 chunk 里，
 *     所以解析器必须能跨块缓冲，且未闭合的 `<` 绝不能漏给显示层。
 *  2. 小模型会写错：全角冒号、强度写在名字前面、自创名字、忘记闭合。
 *     解析器一律容错，认不出来的整段当普通文本，绝不让一个坏标签吞掉整句话。
 *  3. 标签位置决定时机，所以每个标签都要记下它在句中的字符偏移。
 */

/** 与 anim.js 的 PRESETS 对齐 */
export const EXPRESSIONS = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'fear', 'disgust', 'thinking'];

const EXPR_ALIAS = new Map();
function reg(canon, list) {
  for (const a of list) EXPR_ALIAS.set(a.toLowerCase(), canon);
}
reg('neutral', ['neutral', 'calm', '平静', '中性', '正常']);
reg('joy', ['joy', 'happy', 'happiness', 'smile', 'glad', '开心', '高兴', '快乐', '喜悦', '兴奋', '愉快', '笑']);
reg('sadness', ['sadness', 'sad', 'sorrow', 'upset', '悲伤', '难过', '伤心', '失落', '沮丧']);
reg('anger', ['anger', 'angry', 'mad', '愤怒', '生气', '恼火', '不满']);
reg('surprise', ['surprise', 'surprised', 'shock', '惊讶', '吃惊', '震惊', '意外']);
reg('fear', ['fear', 'afraid', 'scared', 'anxious', '恐惧', '害怕', '紧张', '担心']);
reg('disgust', ['disgust', 'disgusted', '厌恶', '恶心', '反感', '嫌弃']);
reg('thinking', ['thinking', 'think', '思考', '思索', '疑惑', '考虑']);

/** 微表情部件：名字 -> 通道增量。幅度上限压在 0.18 以内，否则像抽搐。 */
export const MICRO_PARTS = {
  brow: [['browInnerUp', 0.15], ['browOuterUpLeft', 0.11], ['browOuterUpRight', 0.1]],
  smileL: [['mouthSmileLeft', 0.13], ['mouthDimpleLeft', 0.1]],
  smileR: [['mouthSmileRight', 0.12], ['mouthDimpleRight', 0.1]],
  nose: [['noseSneerLeft', 0.11], ['noseSneerRight', 0.08]],
  eyeL: [['eyeSquintLeft', 0.17]],
  eyeR: [['eyeSquintRight', 0.16]],
  press: [['mouthPressLeft', 0.11], ['mouthPressRight', 0.1]],
  lip: [['mouthLowerDownLeft', 0.1], ['mouthLowerDownRight', 0.09]],
};

const MICRO_ALIAS = new Map();
function regm(canon, list) {
  for (const a of list) MICRO_ALIAS.set(a.toLowerCase(), canon);
}
regm('brow', ['brow', '眉', '眉毛', 'inner', 'browinner']);
regm('smileL', ['smilel', 'smile_left', '左嘴角', 'leftsmile']);
regm('smileR', ['smiler', 'smile_right', '右嘴角', 'rightsmile']);
regm('nose', ['nose', '鼻', '鼻翼']);
regm('eyeL', ['eyel', 'eye_left', '左眼', 'left']);
regm('eyeR', ['eyer', 'eye_right', '右眼', 'right']);
regm('press', ['press', '唇', '嘴唇', '双唇']);
regm('lip', ['lip', '下唇']);

const GAZE_ALIAS = new Map();
function regg(canon, list) {
  for (const a of list) GAZE_ALIAS.set(a.toLowerCase(), canon);
}
regg('camera', ['camera', 'user', '镜头', '对方', '看我']);
regg('away', ['away', 'off', '移开', '旁边']);
regg('down', ['down', '低', '低头', '向下']);
regg('think', ['think', 'thinking', '思考', '上方']);

/** 解析标签体。返回 null 表示这不是标签，应当原样显示。 */
export function parseTagBody(body) {
  // 全角标点归一化
  const raw = String(body).trim().replace(/：/g, ':').replace(/，/g, ',');
  if (!raw) return null;

  const parts = raw.split(/[:,|;\s]+/).filter((s) => s !== '');
  if (!parts.length) return null;

  let kind = parts[0].toLowerCase();
  let args = parts.slice(1);

  // 允许前缀写法变体
  if (/^(e|em|emo|expr|expression|emotion|表情)$/.test(kind)) kind = 'e';
  else if (/^(m|micro|微表情)$/.test(kind)) kind = 'm';
  else if (/^(g|gaze|look|注视|视线)$/.test(kind)) kind = 'g';
  else if (/^(v|val|valence|mood|情绪)$/.test(kind)) kind = 'v';
  else if (/^(p|pause|停顿|停)$/.test(kind)) kind = 'p';
  else {
    // 漏写前缀。7B 模型会稳定地把它写成 <sadness:0.65>、<camera>、<brow:0.4>。
    // 不认的话这段会原样漏到显示层，还会被 TTS 一个字母一个字母念出来——
    // 比表情失效严重得多。这里把裸名字补回标准形式，往下走同一条路。
    const bare = kind;
    if (EXPR_ALIAS.has(bare)) {
      kind = 'e';
      args = [bare, ...args];
    } else if (MICRO_ALIAS.has(bare)) {
      kind = 'm';
      args = [bare, ...args];
    } else if (GAZE_ALIAS.has(bare)) {
      kind = 'g';
      args = [bare, ...args];
    } else {
      return null;
    }
  }

  const num = (s, def) => {
    if (s === undefined) return def;
    const n = Number.parseFloat(String(s).replace(/[^\d.\-+]/g, ''));
    return Number.isFinite(n) ? n : def;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // 走到这里的都"长得像标签"，但内容不合法时返回 noop —— 静默丢弃，
  // 绝不能把 <e:hungry:0.5> 这种残次标签显示给用户看。
  if (kind === 'e') {
    if (!args.length) return { type: 'noop' };
    let name = args[0];
    let intensity = 0.6;
    // 容错：<e:0.8:joy> 这种把强度写在前面的
    if (/^[\d.]+$/.test(args[0]) && args[1]) {
      intensity = num(args[0], 0.6);
      name = args[1];
    } else if (args[1] !== undefined) {
      intensity = num(args[1], 0.6);
    }
    const canon = EXPR_ALIAS.get(String(name).toLowerCase());
    if (!canon) return { type: 'noop' };
    return { type: 'expr', name: canon, intensity: clamp(intensity, 0.05, 1) };
  }

  if (kind === 'm') {
    if (!args.length) return { type: 'noop' };
    const canon = MICRO_ALIAS.get(String(args[0]).toLowerCase());
    if (!canon) return { type: 'noop' };
    return { type: 'micro', part: canon, intensity: clamp(num(args[1], 0.75), 0.1, 1.6) };
  }

  if (kind === 'g') {
    if (!args.length) return { type: 'noop' };
    const canon = GAZE_ALIAS.get(String(args[0]).toLowerCase());
    if (!canon) return { type: 'noop' };
    return { type: 'gaze', target: canon };
  }

  if (kind === 'v') {
    if (!args.length) return { type: 'noop' };
    const v = clamp(num(args[0], 0), -1, 1);
    const a = clamp(num(args[1], 0), -1, 1);
    return { type: 'emotion', valence: v, arousal: a };
  }

  // p
  const sec = clamp(num(args[0], 0.3), 0.05, 2);
  return { type: 'pause', seconds: sec };
}

/**
 * 增量标签解析器。逐块喂入模型输出，返回「可见文本」+「事件」。
 * 未闭合的 `<...` 会留在内部缓冲里，等下一块补齐。
 */
export class TagParser {
  constructor() {
    this.buf = '';
    /** 本回合已吐出的可见字符数，事件的 charOffset 基于它 */
    this.chars = 0;
    this.tagCount = 0;
    this.dropped = 0;
  }

  push(chunk) {
    if (!chunk) return { text: '', events: [] };
    this.buf += chunk;
    let out = '';
    const events = [];

    while (this.buf.length) {
      const lt = this.buf.indexOf('<');
      if (lt < 0) {
        out += this.buf;
        this.buf = '';
        break;
      }
      if (lt > 0) {
        out += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
        continue;
      }
      // 此时 buf 以 '<' 开头
      const gt = this.buf.indexOf('>');
      if (gt < 0) break; // 不完整，等下一块
      const body = this.buf.slice(1, gt);
      // 过长的“标签”几乎肯定不是标签，按文本处理，避免吞掉大段内容
      if (gt > 48) {
        out += '<';
        this.buf = this.buf.slice(1);
        continue;
      }
      const ev = parseTagBody(body);
      if (ev && ev.type !== 'noop') {
        events.push({ charOffset: this.chars + out.length, ev });
        this.tagCount++;
      } else if (!ev) {
        // 不像标签，原样输出
        out += '<' + body + '>';
      } else {
        // 像标签但内容无效：丢掉，不显示
        this.dropped++;
      }
      this.buf = this.buf.slice(gt + 1);
    }

    this.chars += out.length;
    return { text: out, events };
  }

  /** 流结束时调用：丢弃未闭合的残片（显示出来才是真的难看） */
  flush() {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return { text: '', events: [] };
    if (rest.startsWith('<')) {
      this.dropped += rest.length;
      return { text: '', events: [] };
    }
    this.chars += rest.length;
    return { text: rest, events: [] };
  }
}

/** 去掉文本里的所有标签，用于日志与历史 */
export function stripTags(text) {
  return String(text).replace(/<[^>]{0,48}>/g, '');
}

/**
 * 系统提示词。写得短、给例子、明确禁止自创名字——
 * 4B 级别的模型照着例子写比照着规则写可靠得多。
 */
export const SYSTEM_PROMPT = `你是一个有真实表情的数字人，正在和用户面对面聊天。

【说话方式】
中文口语，1~3 句，简短自然。像真人聊天，不要解释、不要列点、不要客服腔。

【表情标记】
说话的同时必须插入表情标记。标记不会被朗读、不会显示给用户，只用来驱动你的脸。
标记写在"触发它的那个词"后面，紧贴标点之前。

可用标记（只有这五种，不许自创）：
<e:表情:强度>   强度 0~1。表情：joy 喜悦 / sadness 悲伤 / anger 愤怒 / surprise 惊讶 / fear 恐惧 / disgust 厌恶 / thinking 思考 / neutral 中性
<g:方向>        视线：camera 看镜头 / away 移开 / down 低头 / think 向上思考
<v:愉悦,唤醒>   两个 -1~1 的数，缓慢改变整体情绪底色，整段对话最多用一次
<p:秒数>        停顿，0.1~0.8，少用

【规则】
1. 有情绪起伏才打标记，平铺直叙的句子不要硬打——系统会自动读懂文本给表情，你打的标记只是让它更准。
2. 每句最多 2 个标记，不要堆在句尾。
3. 强度：日常 0.4~0.6，有情绪 0.7~0.9。不要总用 1。
4. 名字只能从上面选，拼错会导致表情失效。
5. 除了标记，不要输出任何括号说明、旁白、动作描写。

【示例】
用户：今天被老板当众骂了一顿
助手：啊……那也太难受了<e:sadness:0.65><g:away>。是因为什么事啊<e:thinking:0.45>？

用户：我升职了！
助手：真的假的<e:surprise:0.85>？恭喜你<e:joy:0.9>！这得好好庆祝一下。

用户：你觉得我该不该辞职
助手：嗯……<p:0.35>得看你现在最在意什么<e:thinking:0.6>。是钱、成长，还是心情？`;
