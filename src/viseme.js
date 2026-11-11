/**
 * 音素级唇形（L4）。
 *
 * 上一版的口型是「音量包络 + 随机圆唇/扁唇轮换」——声音大就张嘴，
 * 嘴型靠掷骰子。结果是「吧」和「铺」的嘴长得一样，看久了像含着东西说话。
 *
 * 这一版把每个汉字拆成「声母段 + 韵母段」，查表得到 viseme，再按 TTS 的
 * 字符级时间戳排成一条随时间推进的口型轨道。三件事因此成立：
 *   1. 双唇音 b/p/m 真的会先闭嘴（声母段给 PP）；
 *   2. 「啊」「衣」「乌」的开口度和圆扁完全不同（韵母段查表）；
 *   3. 相邻口型会互相渗透（协同发音），不会一个字一张脸地硬切。
 *
 * 精度上限说明：这是**字符级**音素，不是音素级。一个汉字只切成两段，
 * 拿不到声调的曲线，也拿不到「儿化」「轻声」的细节。要做到真正的 viseme
 * 序列得走 forced alignment（sherpa-onnx / Montreal Forced Aligner）。
 * 但字符级已经把「嘴型在变且变得对」这件事做到了，成本只有一张查表。
 */

import { pinyin } from 'pinyin-pro';

/**
 * 口型姿态表。数值是 ARKit 通道的 0~1 目标值，不是最终值——
 * 下游还要乘音量调制 m，并用表情通道（嘴角）做叠加。
 *
 * 记法：jaw 下颌张 / close 闭唇 / funnel 唇收成漏斗 / pucker 撅嘴 /
 *       stretch 嘴角横拉 / upper 上唇上提 / lower 下唇下压 / roll 下唇内卷（齿音）
 */
export const VISEME = {
  sil: { jaw: 0.0, close: 0.0, funnel: 0.0, pucker: 0.0, stretch: 0.0, upper: 0.0, lower: 0.0, roll: 0.0 },
  // 双唇音的 close 不能给满：facecap 这套 blendshape 的 mouthClose 会连带
  // 把下颌往下拽，压到 1 就是一张「撇嘴包子脸」。闭嘴主要靠 jaw 归零，
  // close 只负责让上下唇贴合，0.55 已经足够，给满反而是负作用。
  PP:  { jaw: 0.0, close: 0.55, funnel: 0.0, pucker: 0.06, stretch: 0.03, upper: 0.0, lower: 0.0, roll: 0.0 },
  FF:  { jaw: 0.1, close: 0.18, funnel: 0.06, pucker: 0.0, stretch: 0.12, upper: 0.04, lower: 0.05, roll: 0.55 },
  aa:  { jaw: 0.78, close: 0.0, funnel: 0.1, pucker: 0.0, stretch: 0.06, upper: 0.26, lower: 0.44, roll: 0.0 },
  E:   { jaw: 0.36, close: 0.0, funnel: 0.0, pucker: 0.0, stretch: 0.44, upper: 0.1, lower: 0.2, roll: 0.0 },
  ih:  { jaw: 0.22, close: 0.0, funnel: 0.0, pucker: 0.0, stretch: 0.52, upper: 0.08, lower: 0.12, roll: 0.0 },
  oh:  { jaw: 0.5, close: 0.0, funnel: 0.6, pucker: 0.16, stretch: 0.0, upper: 0.16, lower: 0.3, roll: 0.0 },
  ou:  { jaw: 0.18, close: 0.05, funnel: 0.3, pucker: 0.76, stretch: 0.0, upper: 0.06, lower: 0.1, roll: 0.0 },
};

/** 韵母 → viseme。按**主元音**归类，介音（i/u/ü）不单独成段。 */
const FINAL_VISEME = {
  // a：下颌最开
  a: 'aa', ia: 'aa', ua: 'aa',
  ai: 'aa', uai: 'aa',
  ao: 'aa', iao: 'aa',
  an: 'aa', ian: 'aa', uan: 'aa', üan: 'aa', van: 'aa',
  ang: 'aa', iang: 'aa', uang: 'aa',
  // o：圆而半开
  o: 'oh', uo: 'oh', ou: 'oh', iou: 'oh', iu: 'oh',
  ong: 'oh', iong: 'oh',
  ue: 'oh', üe: 'oh',
  // e：半开偏扁
  e: 'E', ei: 'E', uei: 'E', ui: 'E',
  en: 'E', eng: 'E', ueng: 'E', er: 'E', ng: 'E',
  // i：扁唇
  i: 'ih', ie: 'ih', in: 'ih', ing: 'ih',
  // u / ü：圆小撮
  u: 'ou', ü: 'ou', un: 'ou', ün: 'ou',
};

/**
 * 声母 → 前置口型段。
 *
 * 只收「唇部有硬动作」的四个：b/p/m 是双唇塞音，起音必须真的闭上；
 * f 是唇齿，下唇要内卷。其余声母（含 w/y 这两个半元音）对唇形的贡献
 * 与后面韵母的起点一致，硬切一段只会让嘴在几十毫秒里抽一下，
 * 看起来像痉挛而不是说话。
 */
const INITIAL_VISEME = {
  b: 'PP', p: 'PP', m: 'PP',
  f: 'FF',
};

/** 声母段占整个字时长的比例。塞音很短，0.22 已经够看出来。 */
const INITIAL_SPLIT = 0.22;

/**
 * 声母段最小时长。语速快时一个字只有 0.16s，22% 就是 35ms——
 * 60fps 下不足三帧，闭唇会一闪而过甚至被跳过。给个地板值，
 * 宁可让「爸」的闭唇稍微长一点，也好过看不见。
 */
const MIN_INITIAL_SEC = 0.048;

/** 整字太短就不切段了（否则两段都短于混合窗口，纯粹是噪声） */
const MIN_SPLIT_SEC = 0.07;

const VALID_FINAL = /^[a-zü]+$/;

/**
 * 把一段文本解析成逐字的口型描述。
 *
 * 返回长度恒等于 text.length，每项：
 *   { a, b, split }  a = 声母段 viseme（无则 null），b = 韵母段，
 *                    split = 声母段占比（0 表示整字只用 b）
 * 标点、空格、英文数字都返回 b='sil' 或弱口型，保证下标与文本对齐——
 * 下游的时间戳数组是按字符下标索引的，这里一旦错位，整句口型都会串。
 */
export function buildVisemes(text) {
  const src = String(text || '');
  const n = src.length;
  const out = new Array(n);
  if (!n) return out;

  let initials = [];
  let finals = [];
  try {
    initials = pinyin(src, { pattern: 'initial', type: 'array', toneType: 'none' }) || [];
    finals = pinyin(src, { pattern: 'final', type: 'array', toneType: 'none' }) || [];
  } catch {
    /* 词典异常也不能让整句失声，下面按逐字兜底 */
  }

  for (let i = 0; i < n; i++) {
    const ch = src[i];
    const fin = (finals[i] || '').toLowerCase();
    let ini = (initials[i] || '').toLowerCase();

    if (fin && VALID_FINAL.test(fin)) {
      // 拼音拼写规则：y/w 后面的 u/i 其实不是它自己。雨 yǔ / 云 yún / 月 yuè
      // 的韵母在手写上是 ü，在 pinyin-pro 里给的是 u / un / ue，
      // 直接查表会得到「乌」的口型，得先还原。
      if (ini === 'y' && fin[0] === 'u') {
        ini = '';
        const v = `ü${fin.slice(1)}`; // u → ü, un → ün, ue → üe
        const vv = FINAL_VISEME[v] ? v : fin;
        out[i] = {
          a: null,
          b: FINAL_VISEME[vv] || 'ou',
          split: 0,
        };
        continue;
      }

      const b = FINAL_VISEME[fin] || 'E';
      const a = INITIAL_VISEME[ini] || null;
      out[i] = { a, b, split: a ? INITIAL_SPLIT : 0 };
      continue;
    }

    // 非汉字：字母数字给一个弱开口，标点/空格闭嘴
    out[i] = {
      a: null,
      b: /[0-9a-zA-Z]/.test(ch) ? 'E' : 'sil',
      split: 0,
    };
  }

  return out;
}

/** 把逐字描述按时间戳展开成「口型段」序列 */
export function buildSegments(track, times, duration) {
  const segs = [];
  const n = track.length;
  if (!n || !times || !times.length) return segs;

  for (let i = 0; i < n; i++) {
    const t0 = times[i];
    const t1 = i + 1 < n ? times[i + 1] : duration;
    const span = t1 - t0;
    if (!(span > 0)) continue;

    const it = track[i];
    if (it.a && it.split > 0 && span > MIN_SPLIT_SEC) {
      // 声母段既不能短到看不见，也不能长到吃掉整个韵母
      const hold = Math.min(span * 0.46, Math.max(MIN_INITIAL_SEC, span * it.split));
      const cut = t0 + hold;
      segs.push({ t0, t1: cut, v: it.a });
      segs.push({ t0: cut, t1, v: it.b });
    } else {
      segs.push({ t0, t1, v: it.b });
    }
  }
  return segs;
}

const SILENCE = VISEME.sil;

const smooth = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** 进入下一口型前，提前多久开始渗透进来（占段长比例） */
const BLEND_IN = 0.3;
/** 离开当前口型前，提前多久让下一个渗入 */
const BLEND_OUT = 0.32;

/**
 * 采样某一时刻的口型。
 *
 * 边界处做双段线性混合而不是硬切：真人说话不会一个字一张脸，
 * 第二个音的口型在第一个音还没说完时就已经开始形成了（协同发音）。
 * 没有这层混合，语速一快就看得出是拼贴的。
 */
export function sampleViseme(segs, pos) {
  if (!segs || !segs.length) return SILENCE;
  if (pos < segs[0].t0) return SILENCE;
  const last = segs[segs.length - 1];
  if (pos > last.t1 + 0.03) return SILENCE;

  // 二分找 pos 落在哪一段
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].t0 <= pos) lo = mid;
    else hi = mid - 1;
  }
  const k = lo;
  const s = segs[k];
  const span = s.t1 - s.t0;
  const p = span > 1e-4 ? (pos - s.t0) / span : 0;

  const cur = VISEME[s.v] || SILENCE;

  let wp = 0;
  let wn = 0;
  if (k > 0 && p < BLEND_IN && segs[k - 1].v !== s.v) {
    wp = 1 - smooth(p / BLEND_IN);
  }
  if (k < segs.length - 1 && p > 1 - BLEND_OUT && segs[k + 1].v !== s.v) {
    wn = smooth((p - (1 - BLEND_OUT)) / BLEND_OUT);
  }

  if (wp <= 0 && wn <= 0) return cur;

  const prev = wp > 0 ? VISEME[segs[k - 1].v] || SILENCE : null;
  const next = wn > 0 ? VISEME[segs[k + 1].v] || SILENCE : null;
  const wc = Math.max(0, 1 - wp - wn);

  const mix = (key) =>
    cur[key] * wc + (prev ? prev[key] * wp : 0) + (next ? next[key] * wn : 0);

  return {
    jaw: mix('jaw'),
    // 闭唇与齿音是「硬」动作：爆破音的成阻不会因为过渡而变软，一旦参与
    // 混合就会被两侧的开口段削平，b/m/p 全部糊过去。这两条取本段原值，
    // 硬切换下来的毛刺由下游的 15ms 一阶平滑吸收。
    close: cur.close,
    roll: cur.roll,
    funnel: mix('funnel'),
    pucker: mix('pucker'),
    stretch: mix('stretch'),
    upper: mix('upper'),
    lower: mix('lower'),
  };
}

/** 这条轨道里是否真有发音（全是标点就没必要驱动口型） */
export function hasSpeech(segs) {
  return !!segs && segs.some((s) => s.v !== 'sil');
}
