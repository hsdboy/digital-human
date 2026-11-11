/**
 * ARKit 52 通道定义。
 * id 统一使用 ARKit 官方命名（Left / Right 全拼），
 * 模型里的实际 target 名（browDown_L 等）由 rig.js 做模糊匹配，
 * 这样将来换成 VRM / MetaHuman / 自研资产时不用改这里。
 */

export const CHANNEL_GROUPS = [
  {
    key: 'brow',
    label: '眉',
    hint: '情绪最主要的泄漏口，幅度要小',
    channels: [
      ['browInnerUp', '内眉上提'],
      ['browDownLeft', '左眉下压'],
      ['browDownRight', '右眉下压'],
      ['browOuterUpLeft', '左眉外侧上提'],
      ['browOuterUpRight', '右眉外侧上提'],
    ],
  },
  {
    key: 'eye',
    label: '眼',
    hint: '注视、扫视、眨眼、睁闭',
    channels: [
      ['eyeBlinkLeft', '左眼闭合'],
      ['eyeBlinkRight', '右眼闭合'],
      ['eyeSquintLeft', '左眼下压'],
      ['eyeSquintRight', '右眼下压'],
      ['eyeWideLeft', '左眼放大'],
      ['eyeWideRight', '右眼放大'],
      ['eyeLookUpLeft', '左眼上看'],
      ['eyeLookUpRight', '右眼上看'],
      ['eyeLookDownLeft', '左眼下看'],
      ['eyeLookDownRight', '右眼下看'],
      ['eyeLookInLeft', '左眼内转'],
      ['eyeLookInRight', '右眼内转'],
      ['eyeLookOutLeft', '左眼外转'],
      ['eyeLookOutRight', '右眼外转'],
    ],
  },
  {
    key: 'cheek',
    label: '颊 / 鼻',
    hint: '笑眼与厌恶的关键联动',
    channels: [
      ['cheekPuff', '鼓颊'],
      ['cheekSquintLeft', '左颊上提'],
      ['cheekSquintRight', '右颊上提'],
      ['noseSneerLeft', '左鼻翼上提'],
      ['noseSneerRight', '右鼻翼上提'],
    ],
  },
  {
    key: 'jaw',
    label: '下颌',
    hint: '开合与左右偏移',
    channels: [
      ['jawOpen', '张嘴'],
      ['jawForward', '下颌前伸'],
      ['jawLeft', '下颌左移'],
      ['jawRight', '下颌右移'],
    ],
  },
  {
    key: 'mouth',
    label: '嘴',
    hint: '语义表情与唇形的主力区',
    channels: [
      ['mouthClose', '闭嘴'],
      ['mouthFunnel', '嘴呈漏斗'],
      ['mouthPucker', '噘嘴'],
      ['mouthLeft', '嘴左移'],
      ['mouthRight', '嘴右移'],
      ['mouthRollUpper', '上唇内卷'],
      ['mouthRollLower', '下唇内卷'],
      ['mouthShrugUpper', '上唇上耸'],
      ['mouthShrugLower', '下唇下耸'],
      ['mouthSmileLeft', '左嘴角上扬'],
      ['mouthSmileRight', '右嘴角上扬'],
      ['mouthFrownLeft', '左嘴角下垂'],
      ['mouthFrownRight', '右嘴角下垂'],
      ['mouthDimpleLeft', '左酒窝'],
      ['mouthDimpleRight', '右酒窝'],
      ['mouthUpperUpLeft', '左上唇上提'],
      ['mouthUpperUpRight', '右上唇上提'],
      ['mouthLowerDownLeft', '左下唇下压'],
      ['mouthLowerDownRight', '右下唇下压'],
      ['mouthPressLeft', '左唇压紧'],
      ['mouthPressRight', '右唇压紧'],
      ['mouthStretchLeft', '左嘴角横拉'],
      ['mouthStretchRight', '右嘴角横拉'],
    ],
  },
  {
    key: 'tongue',
    label: '舌',
    hint: '该模型此通道无数据',
    channels: [['tongueOut', '伸舌']],
  },
];

export const ALL_CHANNELS = CHANNEL_GROUPS.flatMap((g) =>
  g.channels.map(([id, label]) => ({ id, label, group: g.key }))
);

export const CHANNEL_IDS = ALL_CHANNELS.map((c) => c.id);

/**
 * ARKit 52 的标准排列顺序。
 * 有些导出的 GLB 不带 targetNames，只能按顺序认；这里作为兜底。
 */
export const ARKIT_ORDER = [
  'browInnerUp',
  'browDownLeft', 'browDownRight',
  'browOuterUpLeft', 'browOuterUpRight',
  'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'cheekPuff',
  'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight',
  'jawOpen', 'jawForward', 'jawLeft', 'jawRight',
  'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthRollUpper', 'mouthRollLower',
  'mouthShrugUpper', 'mouthShrugLower',
  'mouthClose',
  'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight',
  'mouthStretchLeft', 'mouthStretchRight',
  'tongueOut',
];

/**
 * 把任意命名风格拆成「词根 | 侧别」，用于跨资产匹配。
 * browDown_L / browDownLeft / blendShape1.browDownLeft 都会得到 browdown|Left
 */
export function nameKey(name) {
  let raw = String(name).replace(/^blendShape\d*\./i, '');
  let side = '';
  if (/left$/i.test(raw)) {
    side = 'Left';
    raw = raw.replace(/left$/i, '');
  } else if (/right$/i.test(raw)) {
    side = 'Right';
    raw = raw.replace(/right$/i, '');
  } else if (/_l$/i.test(raw)) {
    side = 'Left';
    raw = raw.replace(/_l$/i, '');
  } else if (/_r$/i.test(raw)) {
    side = 'Right';
    raw = raw.replace(/_r$/i, '');
  }
  const stem = raw.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return side ? `${stem}|${side}` : stem;
}
