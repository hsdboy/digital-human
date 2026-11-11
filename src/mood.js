/**
 * 情绪状态机：让心情有惯性。
 *
 * 现在这张脸每轮对话都从「中性」重新开始——用户讲完好笑的，它笑一下，
 * 下一句就忘了。真人不是这样：笑过之后余温会留几分钟，被冒犯了会端着
 * 一阵子，聊久了会疲。
 *
 * 两个维度，和 Russell 的情绪环模型一致：
 *   valence（愉悦）  负  ←→  正
 *   arousal（唤醒）  低  ←→  高
 *
 * 三条演化规则：
 *   ① 冲击：某句话只把心情推动一点点（w 很小），不会一句话翻盘
 *   ② 惯性：向基线缓慢回归，tau ≈ 2~4 分钟——比你想象的长，这正是"余温"
 *   ③ 迟滞：正面情绪衰减慢，负面情绪衰减快（人对坏心情的自我修复更快一些）
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class MoodEngine {
  constructor(opts = {}) {
    /** 基线：轻微偏正。多数人默认状态不是 0，是"还行" */
    this.baselineValence = opts.baselineValence ?? 0.08;
    this.baselineArousal = opts.baselineArousal ?? 0.0;
    this.valence = opts.valence ?? this.baselineValence;
    this.arousal = opts.arousal ?? this.baselineArousal;
    /** 上一次 tick 的时间（秒），用于按真实时间衰减。null = 还没开始计时 */
    this.lastAt = null;
    /** 最近一次被什么推动，调试用 */
    this.lastPush = null;
    /** 累积的互动轮数：聊久了会累 */
    this.turns = 0;
  }

  get state() {
    return { valence: +this.valence.toFixed(3), arousal: +this.arousal.toFixed(3) };
  }

  /**
   * 外部施加影响。
   * @param v 目标愉悦
   * @param a 目标唤醒
   * @param w 权重，0~1。0.2 左右是"一句话能推动的量"，0.5 是"这件事很重"
   */
  push(v, a, w = 0.25) {
    const weight = clamp(w, 0, 1);
    this.valence = clamp(this.valence + (v - this.valence) * weight, -1, 1);
    this.arousal = clamp(this.arousal + (a - this.arousal) * weight, -1, 1);
    this.lastPush = { v, a, w: weight, at: Date.now() };
    return this.state;
  }

  /** 用户说了一句话：影响是即时的，但分量轻——一句话不该定一整天 */
  hear(r) {
    if (!r) return this.state;
    const w = clamp(0.12 + Math.abs(r.score || 0) * 0.28, 0.12, 0.4);
    return this.push(r.valence ?? 0, r.arousal ?? 0, w);
  }

  /** 自己说了话：表态本身会强化情绪（说完狠话自己也会更激动） */
  speak(v, a, w = 0.2) {
    return this.push(v, a, w);
  }

  /**
   * 按真实时间衰减。每帧可调，开销极小。
   * 正面情绪 tau 更长（余温），负面更短（自我修复）。
   */
  tick(nowSec) {
    // 用 null 而不是 0 当哨兵：ctx.currentTime 在页面刚加载时就是 0，
    // 用 0 判断会连着吃掉两次 tick，衰减直接停摆（测试里就是这么暴露的）
    if (this.lastAt === null) {
      this.lastAt = nowSec;
      return;
    }
    const dt = nowSec - this.lastAt;
    if (dt <= 0) return;
    this.lastAt = nowSec;

    const dv = this.valence - this.baselineValence;
    const tauV = dv >= 0 ? 240 : 110;
    this.valence = clamp(this.baselineValence + dv * Math.exp(-dt / tauV), -1, 1);

    const da = this.arousal - this.baselineArousal;
    const tauA = 90;
    this.arousal = clamp(this.baselineArousal + da * Math.exp(-dt / tauA), -1, 1);
  }

  /** 聊久了会疲：唤醒度基线缓慢下沉，话变少 */
  endTurn() {
    this.turns++;
    if (this.turns > 8) this.baselineArousal = clamp(this.baselineArousal - 0.006, -0.3, 0.4);
  }

  /** 派生行为倾向，给节奏层用 */
  get tendency() {
    const v = this.valence;
    const a = this.arousal;
    return {
      /** 主动开口的意愿 0~1 */
      chatty: clamp(0.3 + v * 0.5 + a * 0.4, 0, 1),
      /** 愿意展开的程度：低落时只说半句 */
      verbose: clamp(0.45 + v * 0.45 + a * 0.3, 0.15, 1),
      /** 耐心：心情差 + 精神差时容易敷衍 */
      patience: clamp(0.6 + v * 0.3 + a * 0.2, 0.2, 1),
    };
  }

  /**
   * 情绪 → 语音参数。
   *
   * 语速跟唤醒度（激动就快、疲惫就慢），音高跟愉悦度（开心声音会扬、低落会沉）。
   * 幅度刻意压得很小：超过 ±8% 就像在演话剧，反而假。
   * 但只要有这一点点变化，脸和声音就站在同一个情绪上了。
   */
  get tone() {
    const v = this.valence;
    const a = this.arousal;
    return {
      rate: +(0.48 + a * 0.055).toFixed(3),
      pitch: +(1.0 + v * 0.075 + a * 0.02).toFixed(3),
    };
  }

  /** 存盘用：只留状态和时间戳 */
  snapshot() {
    return { valence: this.valence, arousal: this.arousal, t: Date.now() };
  }

  /**
   * 从快照恢复，并按离线时长衰减。
   *
   * 这一条很关键：关掉页面再回来，如果心情忽然从"刚吵完架"跳回"心情还行"，
   * 记忆层攒下的连续性会被这一下抹掉。真人不会过一夜就把情绪清空。
   */
  static restore(snap) {
    if (!snap || typeof snap.valence !== 'number') return new MoodEngine();
    const dt = Math.max(0, (Date.now() - (snap.t || 0)) / 1000);
    const base = 0.08;
    const v = base + (snap.valence - base) * Math.exp(-dt / 240);
    const a = (snap.arousal || 0) * Math.exp(-dt / 90);
    return new MoodEngine({ valence: clamp(v, -1, 1), arousal: clamp(a, -1, 1) });
  }
}
