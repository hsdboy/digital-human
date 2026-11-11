/**
 * 节奏层：人不是「问—答」的机器。
 *
 * 三个最容易被忽略、但最能暴露"这是程序"的地方：
 *   ① 响应太快。0.2 秒接话不是敏捷，是没有在听。真人至少要愣一下。
 *   ② 不会主动。永远等你说完才开口的对话，本质是一个输入框。
 *   ③ 被打断没反应。真人被截话会停、会看过来、会有点不爽。
 *
 * 这里管这三件事。所有判断都基于"心情倾向"（mood.tendency），
 * 低落时她不想主动搭话，这本身就是真实感的一部分。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Rhythm {
  constructor(opts = {}) {
    /** 主动开口的冷却与阈值 */
    this.idleStart = opts.idleStart ?? 42000; // 42 秒没人说话，开始考虑
    this.idleMax = opts.idleMax ?? 150000; // 2.5 分钟后基本就沉默了
    this.initiateGap = opts.initiateGap ?? 90000; // 两次主动开口至少隔 90 秒
    this.minThinkMs = opts.minThinkMs ?? 320; // 首字前的"愣一下"下限

    this.lastActive = 0;
    this.lastInitiate = 0;
    this.initiated = 0;
    this.atLimit = false;
    /** 下一次打算开口的时刻；null = 还没排期 */
    this.dueAt = null;
  }

  /** 任何交互都重置空闲计时，并解除"这一轮已经主动过"的封印 */
  poke(nowSec) {
    this.lastActive = nowSec;
    this.atLimit = false;
  }

  /** 首字前的最短思考时间。模型回得快时补一点，回得慢就顺势当思考 */
  thinkGate(ttftMs) {
    const need = this.minThinkMs - ttftMs;
    return need > 0 ? need : 0;
  }

  /**
   * 每帧问一次：现在该主动开口吗。
   *
   * 不用「每帧掷一次骰子」：那样触发时刻会散得很开，而且概率一调就不受控。
   * 改成先定一个到期时刻（`dueAt`），到点就说——沉默的时长因此是可预期的：
   * 心情好等得短，心情差等得久，低落时干脆不开口。
   */
  tick(nowSec, ctx = {}) {
    if (!this.lastActive) this.lastActive = nowSec;
    if (ctx.busy || ctx.visible === false || !ctx.hasHistory) return false;
    if (this.atLimit) return false;
    if (nowSec - this.lastInitiate < this.initiateGap / 1000) return false;

    const idleMs = (nowSec - this.lastActive) * 1000;
    if (idleMs < this.idleStart) {
      // 还没安静够：把到期时刻作废，下次安静重新计时
      this.dueAt = null;
      return false;
    }

    const chatty = ctx.chatty ?? 0.5;
    // 心情太差就不主动——一个低落的人不会自己找话说
    if (chatty < 0.18) return false;

    if (this.dueAt === null) {
      const span = 16 + (1 - chatty) * 42;
      this.dueAt = nowSec + Math.random() * span;
      return false;
    }
    if (nowSec < this.dueAt) return false;

    this.dueAt = null;
    this.lastInitiate = nowSec;
    this.initiated++;
    this.atLimit = true;
    return true;
  }
}
