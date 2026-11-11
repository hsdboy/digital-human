import * as THREE from 'three';

/**
 * 静态造型：把扫描模型捏成更接近真人的脸型。
 *
 * 为什么要单独一层？
 * facecap.glb 是一份人头扫描：它保留了「头壳」的完整体积，但面部特征
 * 相对头壳偏小、偏扁。正面看起来的结果是「一张大饼上贴了五小件」，
 * 侧面看是个鸡蛋 —— 额头几乎没有，后脑却占了一大半。
 * 这不是贴图能救的，只能动几何。
 *
 * 这一层只做**低频形变**：横向收窄、纵深调整、面部相对放大。
 * 高频细节（毛孔、唇纹、眉毛）全部归 skin.js，两者不要混在一起。
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, t) => {
  const k = clamp01((t - a) / (b - a || 1e-6));
  return k * k * (3 - 2 * k);
};

/**
 * 分段平滑曲线。控制点必须按 t 升序。
 * 每段用 smoothstep 插值，所以各控制点处导数为 0 —— 曲线不会有折角，
 * 形变后不会在控制点高度上出现一圈「棱」。
 */
function curveAt(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  const n = pts.length;
  if (t >= pts[n - 1][0]) return pts[n - 1][1];
  for (let i = 0; i < n - 1; i++) {
    const [t0, v0] = pts[i];
    const [t1, v1] = pts[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * smoothstep(t0, t1, t);
  }
  return pts[n - 1][1];
}

/**
 * 横向收窄曲线：输入 ny（以「眼到嘴 = 1」为单位），输出 x 方向的缩放系数。
 *
 * 这组数是从实测宽度反推的。原模型在 ny = -0.2 处半宽 1.47u，
 * 而真人在同一高度（颧骨下）约 1.0u —— 宽了将近一半。
 * 曲线形状对应「太阳穴到颧骨少收、腮与下颌多收、头顶完全不收」：
 * 收头顶会把头削尖，收颧骨会显得没肉，都是负优化。
 */
const WIDTH = [
  [-2.40, 0.70],
  [-1.86, 0.72], // 圆润的小下巴，不削成锥子
  [-1.50, 0.74], // 下颌收窄
  [-1.00, 0.80],
  [-0.50, 0.90], // 保留苹果肌的饱满度（少女感靠它）
  [0.00, 0.88],
  [0.40, 0.88],
  [0.80, 0.92],
  [1.20, 0.96],
  [1.70, 0.99],
  [2.10, 1.00],
];

/** 日系少女的眼裂明显大于写实人头；但仍保留完整眼睑，不做夸张替换。 */
const EYE_UP = 0.140;
const EYE_DOWN = 0.055;

/** 后脑收束：z 为负（脑后）时压扁，把「圆球后脑」压成正常颅型。 */
function backK(zRel) {
  // zRel = z / u。脑后在负方向，越负收得越多，但别收破（0.82 是极限）
  return 1 - 0.20 * smoothstep(0.10, -1.05, zRel);
}

/**
 * 面部相对放大：把额头和下巴往中间压一点，让五官区域在整张脸上占比更大。
 * 这是「丑」的第二个来源 —— 脸窄了以后如果额头还很高，会变成「大额头小五官」。
 * 做法是对 y 做局部压缩：上庭和下庭各压一点，中庭不动。
 */
const FACE_Y = [
  // 下庭（鼻底到下巴）原本是 1.35u，比中庭多出四成 —— 这是「马脸」的来源。
  // 少女脸三庭接近 1:0.9:0.9，下庭要更短、下巴更圆。
  [-2.40, -1.90],
  [-2.00, -1.66],
  [-1.70, -1.42],
  [-1.40, -1.18],
  [-1.15, -1.02],
  [-1.00, -0.94],
  [-0.50, -0.50],
  [0.00, 0.00],
  [0.40, 0.40],
  // 上庭（发际线到眉）只有 0.61u，压一压让额头别那么大
  [0.80, 0.76],
  [1.20, 1.06],
  [1.70, 1.40],
  [2.10, 1.70],
];

/**
 * 把量化存储的顶点属性提成独立的 Float32。
 *
 * 两个坑叠在一起，任何一个踩到都会让整张脸炸成碎三角形：
 *
 * 1. **量化**。facecap.glb 被 gltfpack 压过，position 存成 Uint16Array，
 *    局部坐标只能是 0~65535 的非负整数。造型形变转回局部空间后必然出负值，
 *    `setXYZ(-5527, ...)` 写进 Uint16 会被当成 60009 —— 顶点飞到另一个象限。
 *    现象看起来像「UV 坏了 / 贴图错位」，其实是几何烂了。
 *
 * 2. **interleaved**。position 和 uv 可能共用一块 InterleavedBuffer，
 *    按 `array[i * itemSize + c]` 顺序直读会把 uv 当成坐标读进来。
 *    必须走 `getComponent()`，它认得交错布局。
 */
function attrToFloat(attr) {
  if (!attr) return attr;
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array) return attr;
  const n = attr.count * attr.itemSize;
  const arr = new Float32Array(n);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < attr.itemSize; c++) arr[i * attr.itemSize + c] = attr.getComponent(i, c);
  }
  const next = new THREE.BufferAttribute(arr, attr.itemSize);
  next.normalized = false;
  return next;
}

function toFloatAttr(geo, name) {
  const attr = geo.attributes[name];
  const next = attrToFloat(attr);
  if (next !== attr) geo.setAttribute(name, next);
  return next;
}

/**
 * 世界空间的变形场。head 和眼球必须共用同一个场，
 * 否则眼球不会跟着眼窝走 —— 脸收窄了眼球还在原地，就会从眼裂两侧凸出来。
 */
function makeField(anchors) {
  const mid = anchors.eyeL.clone().add(anchors.eyeR).multiplyScalar(0.5);
  const u = Math.max(1e-6, anchors.mouth.distanceTo(mid));
  const midY = mid.y;
  return {
    u,
    midY,
    kx: (ny) => curveAt(WIDTH, ny),
    mapPoint(v) {
      const ny = (v.y - midY) / u;
      v.x *= curveAt(WIDTH, ny);
      v.z *= backK(v.z / u);
      v.y = midY + curveAt(FACE_Y, ny) * u;
      // 下巴前推。压了下庭之后，如果不补 z，侧面会变成「没有下巴」——
      // 整个下颌往后退，比长下巴还难看。真实的下巴是往前翘的。
      const chin = smoothstep(-1.06, -1.60, ny) * smoothstep(0.60, 0.26, Math.abs(v.x) / u);
      v.z += 0.070 * u * chin;

      // 眼睛内移：少女脸的眼距较窄（约等于一只眼的宽度）。
      // 把眼周顶点向脸中线拉近，两眼自然靠近，脸显得更幼态。
      // 眼睛在 |x|/u ≈ 0.42~0.48 处，内移量在这一带最大。
      const ey = (v.y - midY) / u;
      const eyeGather = Math.exp(-((ey / 0.20) ** 2));
      if (eyeGather > 0.05) {
        const ax = Math.abs(v.x) / u;
        const sign = v.x >= 0 ? 1 : -1;
        // 高斯钟形：中心在 |x|/u=0.45（眼睛位置），宽度 0.18
        const gatherAmt = 0.11 * u * eyeGather * Math.exp(-(((ax - 0.45) / 0.18) ** 2));
        v.x -= sign * gatherAmt;
      }

      // 小鼻：扫描模型最成熟、最男性化的特征就是鼻体过大。
      // 只把鼻尖和鼻翼向后收，鼻梁仍保留连续体积；不能用贴图把鼻子涂没。
      const nx = v.x / u;
      const front = smoothstep(0.75, 1.35, v.z / u);
      const noseTip = Math.exp(-((nx / 0.22) ** 2) - (((ny + 0.48) / 0.30) ** 2));
      v.z -= 0.115 * u * noseTip * front;
    },
  };
}

/**
 * 撑开眼裂。
 *
 * 这个模型的眼裂天生很窄，上眼睑盖住了大半虹膜 —— 这是「没精神 / 不好看」
 * 最主要的来源，而且贴图完全救不了（ARkit 的 eyeWide 通道在这个模型上
 * 效果微弱，给了 0.22 几乎看不出变化）。
 *
 * 做法是把眼洞上下缘的顶点各自往外推一点点：上睑往上、下睑往下。
 * 只沿 y 推、只推一条窄带（眼睑位置），所以不会把整个眼周拉变形。
 */
function openEyes(v, anchors, u, up, down) {
  const dz = (v.z - anchors.eyeL.z) / u;
  if (dz < -0.12) return; // 只处理脸正面
  for (const ec of [anchors.eyeL, anchors.eyeR]) {
    const dx = (v.x - ec.x) / u;
    const dy = (v.y - ec.y) / u;
    const lat = Math.exp(-((dx / 0.22) ** 2));
    if (lat < 0.02) continue;
    // 上睑在眼睛中心上方约 0.06u，下睑在下方约 0.05u
    const upper = Math.exp(-(((dy - 0.058) / 0.042) ** 2));
    const lower = Math.exp(-(((dy + 0.050) / 0.038) ** 2));
    v.y += (up * upper - down * lower) * lat * u;
  }
}

export function reshape(head, anchors) {
  const field = makeField(anchors);
  const u = field.u;
  const midY = field.midY;

  const geo = head.geometry;
  const pos = toFloatAttr(geo, 'position');
  const count = pos.count;

  head.updateMatrixWorld(true);
  const mw = head.matrixWorld.clone();
  const inv = mw.clone().invert();
  // 位移向量的变换只吃线性部分，不能带平移
  const lin = mw.clone().setPosition(0, 0, 0);
  const linInv = lin.clone().invert();
  const identity =
    Math.abs(mw.elements[0] - 1) < 1e-9 &&
    Math.abs(mw.elements[5] - 1) < 1e-9 &&
    Math.abs(mw.elements[10] - 1) < 1e-9 &&
    mw.elements[12] === 0 && mw.elements[13] === 0 && mw.elements[14] === 0;

  // 先把「世界坐标下的 ny / x / z」缓存下来，morph target 变换时直接复用
  const wx = new Float32Array(count);
  const wy = new Float32Array(count);
  const v = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(pos, i);
    if (!identity) v.applyMatrix4(mw);
    wx[i] = v.x;
    wy[i] = v.y;

    field.mapPoint(v);
    openEyes(v, anchors, u, EYE_UP, EYE_DOWN);

    if (!identity) v.applyMatrix4(inv);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  // ---- morph target 同步 ----
  // 这是最关键的一步：morph target 存的是「相对位移」。
  // 只改 position 不改 morph，表情一动整个脸就会撕裂 —— 
  // 位移还是按原来的旧坐标体系算的，和新的几何对不上。
  //
  // 对 p' = (k(y)·x, y, z) 这样的变换，位移 d 的正确映射是雅可比：
  //   dx' = k·dx + k'(y)·x·dy
  //   dy' = dy,  dz' = dz
  // 第二项不能省：眉毛/嘴角的位移往往是 y 方向为主的，
  // 而 k'≠0 时 x 会被「连带」拉走一点，恰好是皮肤褶皱需要的横向补偿。
  const rels = geo.morphAttributes?.position;
  const H = 0.004;
  if (rels) {
    const d = new THREE.Vector3();
    for (let r = 0; r < rels.length; r++) {
      const old = rels[r];
      // morph target 一样可能是量化 + 交错的，同样先提成独立浮点
      const rel = attrToFloat(old);
      if (rel !== old) rels[r] = rel;
      if (rel.count !== count) continue;
      for (let i = 0; i < count; i++) {
        d.fromBufferAttribute(rel, i);
        if (!identity) d.applyMatrix4(lin);

        const relY = (wy[i] - midY) / u;
        const k = curveAt(WIDTH, relY);
        const kp = (curveAt(WIDTH, relY + H) - curveAt(WIDTH, relY - H)) / (2 * H);
        d.x = k * d.x + (kp * wx[i] * d.y) / u;

        if (!identity) d.applyMatrix4(linInv);
        rel.setXYZ(i, d.x, d.y, d.z);
      }
      rel.needsUpdate = true;
    }
  }

  return field;
}

/**
 * 眼球跟随：把球心搬到变形后的位置，并整体等比缩小。
 *
 * 不能直接把眼球顶点丢进 mapPoint：那是各向异性压缩，
 * 虹膜会被压成竖椭圆，一眼就假。真人虹膜永远是正圆。
 * 所以只搬球心、只等比缩半径 —— 眼球该被眼睑挡住的部分本来就挡着。
 */
/**
 * 通用网格跟随：把顶点整个丢进变形场。
 * 牙齿必须走这条 —— FACE_Y 压了下巴，牙齿如果留在原地，
 * 张嘴时牙床就会顶到上颚或者掉进喉咙。
 */
export function reshapeMesh(mesh, field) {
  const geo = mesh.geometry;
  const pos = toFloatAttr(geo, 'position');
  mesh.updateMatrixWorld(true);
  const mw = mesh.matrixWorld.clone();
  const inv = mw.clone().invert();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    field.mapPoint(v);
    v.applyMatrix4(inv);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
}

export function reshapeEye(mesh, field, shrink = 0.94, offset = null) {
  const geo = mesh.geometry;
  const pos = toFloatAttr(geo, 'position');
  mesh.updateMatrixWorld(true);
  const mw = mesh.matrixWorld.clone();

  const lb = new THREE.Box3().setFromBufferAttribute(pos);
  const cLocal = lb.getCenter(new THREE.Vector3());
  const target = cLocal.clone().applyMatrix4(mw);
  field.mapPoint(target);
  if (offset) target.add(offset);

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(cLocal).multiplyScalar(shrink).add(cLocal);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const parent = mesh.parent;
  if (!parent) return null;
  mesh.updateMatrixWorld(true);
  const nowWorld = cLocal.clone().applyMatrix4(mesh.matrixWorld);
  const delta = target.sub(nowWorld);
  // 父级带旋转，世界位移不能直接加到 position 上
  const pLin = new THREE.Matrix4().copy(parent.matrixWorld).invert().setPosition(0, 0, 0);
  mesh.position.add(delta.applyMatrix4(pLin));
  mesh.updateMatrixWorld(true);
  // 返回的是**球心**的世界坐标，不是 mesh 原点。
  // 这个模型的眼球几何不以原点为心，返回原点会让 anchors 整体偏移，
  // 于是眉毛跑到额头、唇扩散成一大片 —— 症状看起来像贴图坏了，其实是锚点错了。
  return cLocal.clone().applyMatrix4(mesh.matrixWorld);
}
