import * as THREE from 'three';

/**
 * 皮肤贴图烘焙。
 *
 * 为什么要走这条路：
 * 这个 GLB 带的 1024² 贴图是空的（alpha 只有 8% 有内容，颜色还集中在法线图那种
 * 蓝紫区间），等于没有 albedo。而顶点色只有 2694 个采样点，嘴唇只有几个顶点，
 * 根本画不出唇线；鼻翼、眼周这些最需要细节的地方全靠插值，所以整张脸看着像
 * 石膏。
 *
 * 但模型有完整 UV。于是把「顶点 → 世界坐标」和「顶点 → UV」两条对应关系，
 * 在 UV 空间里做一次光栅化：每个像素用重心坐标反插值出它在脸上的真实 3D 位置，
 * 再按位置算颜色。等于用 2694 个点给 1024² 个像素做了一次有几何意义的填充。
 *
 * 产出三张图：
 *   albedo    肤色 + 唇色 + 眼周 + 鼻头 + 颊红 + 毛孔色斑
 *   roughness 唇/额头 T 区/眼周的不同光泽
 *   normal    由高度场（毛孔、唇纹）求梯度得到的切线空间法线
 */

/**
 * 把量化 UV（0~4095）换成一个 0~1 的 Float32 属性。
 *
 * 注意不能就地 setXY：这个属性底层是 Uint16Array（glTF 的 TEXCOORD 用
 * UNSIGNED_SHORT 存），写 0.99 进去会被截断成 0 —— UV 全部归零，
 * 整张脸都采样同一个像素，看起来就是「一块均匀的颜色」，
 * 而且不管怎么调 flipY 都一样，极难从表象反推。
 */
function normalizeUV(geometry) {
  const attr = geometry.attributes.uv;
  if (!attr) return false;
  let mx = 0;
  for (let i = 0; i < attr.count; i++) {
    const u = attr.getX(i);
    const v = attr.getY(i);
    if (u > mx) mx = u;
    if (v > mx) mx = v;
  }
  // 已经是 0~1 就别动。判据取 1.5 而不是 1：正常 UV 会贴着 1.0 附近。
  if (mx <= 1.5) return false;
  const k = 1 / 4096;
  const arr = new Float32Array(attr.count * 2);
  for (let i = 0; i < attr.count; i++) {
    arr[i * 2] = attr.getX(i) * k;
    arr[i * 2 + 1] = attr.getY(i) * k;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(arr, 2));
  return true;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** sRGB -> linear，贴图数据在 sRGB，最终传给 three 的是线性 */
function s2l(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/* ---------------- 噪声 ---------------- */

function hash3(ix, iy, iz) {
  let h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

/** 三线性 value noise，返回 0~1 */
function noise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = mix(c000, c100, ux);
  const x10 = mix(c010, c110, ux);
  const x01 = mix(c001, c101, ux);
  const x11 = mix(c011, c111, ux);
  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz);
}

function fbm3(x, y, z, oct = 3) {
  let a = 0.5;
  let s = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x, y, z);
    norm += a;
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    a *= 0.5;
  }
  return s / norm;
}

/* ---------------- 主流程 ---------------- */

/**
 * @param head   头部 mesh（matrixWorld 必须已更新）
 * @param anchors { eyeL, eyeR, mouth, teeth, browY }  世界坐标下的关键点
 * @param opts   { size, span }
 */
export function bakeSkin(head, anchors, opts = {}) {
  const size = opts.size || 1024;
  const t0 = performance.now();

  const idx = head.geometry.index;
  if (!head.geometry.attributes.position || !head.geometry.attributes.uv || !idx) {
    throw new Error('头部网格缺少 position/uv/index，无法烘焙');
  }

  // gltfpack 把 UV 量化成 0~4095 的整数，靠 KHR_texture_transform 的 scale
  // 缩回 0~1。我们自建的贴图没有那个变换，所以必须把 UV 本身归一化。
  normalizeUV(head.geometry);
  const posAttr = head.geometry.attributes.position;
  const uvAttr = head.geometry.attributes.uv;

  const vCount = posAttr.count;
  const triCount = idx.count / 3;

  // 顶点世界坐标（此时 root 的缩放已含在内，坐标大致落在 ±0.5）
  const wx = new Float32Array(vCount);
  const wy = new Float32Array(vCount);
  const wz = new Float32Array(vCount);
  const v = new THREE.Vector3();
  for (let i = 0; i < vCount; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(head.matrixWorld);
    wx[i] = v.x;
    wy[i] = v.y;
    wz[i] = v.z;
  }

  const us = new Float32Array(vCount);
  const vs = new Float32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    us[i] = uvAttr.getX(i);
    vs[i] = uvAttr.getY(i);
  }

  const { eyeL, eyeR, mouth } = anchors;
  const mid = eyeL.clone().add(eyeR).multiplyScalar(0.5);
  // 眼到嘴的距离当作脸长基准：每个人比例不同，但用几何算出来的值当尺子，
  // 比硬编码坐标稳，换了模型也不会全错位。
  const u = Math.max(mouth.distanceTo(mid), 1e-4);

  // 唇的尺度按「眼到嘴」换算：真人嘴宽约 5cm、上下唇总高约 2.5cm，
  // 而眼到嘴约 11cm。给得比解剖值略大一点，因为唇缘是渐变的，视觉上会缩水。
    const lipHalfW = 0.325 * u;
  const lipHalfH = 0.140 * u;
  const eyeR2 = 0.19 * u;
  const browDy = (anchors.browY ?? mid.y + 0.09 * u) - mid.y;

  const albedo = new Float32Array(size * size * 3);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const mask = new Uint8Array(size * size);
  /**
   * 深度缓冲。
   * 这个模型的 UV 是重叠的：唇面和口腔内壁、左右脸颊的展开区都压在一起。
   * 光栅化按三角形顺序写，后写的会盖掉先写的 —— 结果就是唇被内壁盖成肤色，
   * 只在唇缝那条线上留下痕迹。加 z 测试，让真正靠前的表面赢。
   */
  const zbuf = new Float32Array(size * size).fill(-1e9);

  const cx = size / 2;
  const cy = size / 2;

  // 逐三角形光栅化：把 3D 位置插值到 UV 像素上
  for (let t = 0; t < triCount; t++) {
    const i0 = idx.getX(t * 3);
    const i1 = idx.getX(t * 3 + 1);
    const i2 = idx.getX(t * 3 + 2);

    // three 上传 canvas 时默认 flipY=true：纹理坐标 v=0 取到图像最后一行。
    // 所以绘制时 v 越大越靠上，行号用 (1-v)*size。
    const x0 = us[i0] * size;
    const y0 = vs[i0] * size;
    const x1 = us[i1] * size;
    const y1 = vs[i1] * size;
    const x2 = us[i2] * size;
    const y2 = vs[i2] * size;

    let minX = Math.floor(Math.min(x0, x1, x2));
    let maxX = Math.ceil(Math.max(x0, x1, x2));
    let minY = Math.floor(Math.min(y0, y1, y2));
    let maxY = Math.ceil(Math.max(y0, y1, y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > size - 1) maxX = size - 1;
    if (maxY > size - 1) maxY = size - 1;
    if (maxX < minX || maxY < minY) continue;

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const invArea = 1 / area;

    for (let py = minY; py <= maxY; py++) {
      const sy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;
        // 边函数
        const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) * invArea;
        const w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;

        const pxc = wx[i0] * w0 + wx[i1] * w1 + wx[i2] * w2;
        const pyc = wy[i0] * w0 + wy[i1] * w1 + wy[i2] * w2;
        const pzc = wz[i0] * w0 + wz[i1] * w1 + wz[i2] * w2;

        const o = py * size + px;
        if (pzc <= zbuf[o]) continue; // 前面已经画过更靠前的面
        zbuf[o] = pzc;
        paint(o, pxc, pyc, pzc);
        mask[o] = 1;
      }
    }
  }

  /* --------- 单像素着色规则 --------- */
  function paint(o, px, py, pz) {
    // 以「眼到嘴」为尺度重新表达位置，规则就与绝对坐标无关了
    const nx = (px - mid.x) / u;
    const ny = (py - mid.y) / u;

    // ---- 基础肤色：清透白皙带暖粉的日系少女肤色 ----
    // 目标「清纯萝莉美少女」：白、透、粉，但不要惨白。
    // r 略高于 g/b，保留暖调；b 不低于 g 太多，避免发黄。
    let r = 0.965;
    let g = 0.875;
    let b = 0.858;

    // 纵向坐标的真实取值（实测，单位 u = 眼到嘴距离）：
    //   头顶 +1.69 / 眉 +0.386 / 眼 0 / 鼻尖 -0.476 / 嘴 -0.984 / 下颌 -1.89
    // 之前这些阈值全是拍脑袋写的（把 0.16~0.42 当额头、把鼻子放在眼睛高度），
    // 结果所有纵向特征整体错位，鼻梁上糊出一颗亮球。

    // 额头：发际线以下、眉以上。少女额头应透亮，去掉偏黄的暖调。
    const forehead = smoothstep(0.52, 0.98, ny) * smoothstep(0.68, 0.32, Math.abs(nx));
    r += 0.010 * forehead;
    g += 0.008 * forehead;
    b += 0.006 * forehead;

    // 苹果肌：颧骨前下方那一小块。少女感的核心是饱满透亮的苹果肌。
    {
      const aL = Math.hypot((nx + 0.29) / 0.20, (ny + 0.40) / 0.16);
      const aR = Math.hypot((nx - 0.29) / 0.20, (ny + 0.40) / 0.16);
      const apple = Math.max(smoothstep(1.10, 0.18, aL), smoothstep(1.10, 0.18, aR));
      r += 0.045 * apple;
      g += 0.030 * apple;
      b += 0.028 * apple;
    }

    // 下颌与脖颈：向下渐暗，这是最容易被忽略却最影响「立体」的一块
    const jaw = smoothstep(-1.02, -1.58, ny);
    r -= 0.018 * jaw;
    g -= 0.016 * jaw;
    b -= 0.014 * jaw;

    // 颊红：日系腮红是「气色」的核心，位置在眼下颧骨上方，粉色明显。
    const cheekL = Math.hypot((nx + 0.300) / 0.180, (ny + 0.170) / 0.145);
    const cheekR = Math.hypot((nx - 0.300) / 0.180, (ny + 0.170) / 0.145);
    const cheek = Math.max(smoothstep(1.15, 0.10, cheekL), smoothstep(1.15, 0.10, cheekR));
    r += 0.150 * cheek;
    g -= 0.018 * cheek;
    b += 0.055 * cheek;

    // 鼻头：整张脸第二红的区域。中心必须落在鼻尖（实测 ny = -0.476）。
    const nose = Math.hypot(nx / 0.085, (ny + 0.476) / 0.105);
    const noseK = smoothstep(1.10, 0.15, nose);
    r += 0.018 * noseK;
    g += 0.006 * noseK;
    // 鼻翼：两个独立的暗点，不是一个环绕鼻子的暗环。
    // 用环状 darkening 会在鼻子上画出一圈描边，看着像贴了张椭圆贴纸。
    let alar = 0;
    for (let s = -1; s <= 1; s += 2) {
      const ad = Math.hypot((nx - s * 0.082) / 0.036, (ny + 0.545) / 0.042);
      const k = smoothstep(1.12, 0.18, ad);
      if (k > alar) alar = k;
    }
    r -= 0.018 * alar;
    g -= 0.016 * alar;
    b -= 0.014 * alar;
    // 鼻梁：沿中线一条窄的冷影，把鼻子的走向连起来（不加亮，只收蓝）
    const bridge =
      smoothstep(0.105, 0.045, Math.abs(nx)) *
      smoothstep(-0.40, -0.48, ny) *
      smoothstep(0.02, -0.10, ny);
    b -= 0.014 * bridge;

    // 耳朵：耳廓是薄软骨，透光所以明显偏红。这是侧脸真实感的锚点。
    const earX = Math.abs(px - mid.x) / u;
    const earK = smoothstep(1.50, 1.78, earX) * smoothstep(0.50, 0.22, Math.abs(ny - 0.02));
    if (earK > 0.001) {
      r += 0.070 * earK;
      g -= 0.008 * earK;
      b -= 0.014 * earK;
    }

    // ---- 头发（寸头）----
    // 这个模型只有面部、没有头发几何，留白就是一颗秃头 —— 真实感最大的缺口。
    // 做法是在头皮区域画极短的寸头：深色 + 高频发丝 + 柔化的发际线。
    // 没有几何轮廓是硬伤，但「剃得很短的头」比「全秃」自然一个量级。
    let hairK = 0;
    let hairStrand = 0.5;
    {
      // 发际线：中线最高，向两侧（鬓角）迅速下移，做出后退的额角。
      // 必须叠一层低频起伏 —— 真人发际线没有一条几何弧线那么整齐，
      // 平滑的边界是「戴了顶帽子」最直接的来源。
      // 少女发际线：更低的齐刘海式，中线最高但不后退成 M 形，
      // 两侧只是轻微下移（鬓角），避免「M 形后退」的显老感。
      const hairline =
        0.62 -
        0.10 * smoothstep(0.30, 0.95, Math.abs(nx)) -
        0.06 * smoothstep(0.95, 1.45, Math.abs(nx)) +
        0.050 * (noise3(px * 24, py * 24, pz * 24) - 0.5);
      // 边缘再抖一次：发际线是毛茬长出来的，边界必须呈锯齿状而不是渐变带
      const jag = 0.035 * (noise3(px * 130, py * 80, pz * 130) - 0.5);
      const hdy = ny - hairline + jag;
      if (hdy > -0.16) {
        const edge = smoothstep(-0.16, 0.10, hdy);
        const ax = nx;
        const ay = ny - 1.62;
        const ang = Math.atan2(ax, ay);
        const radial = noise3(Math.cos(ang) * 17, Math.sin(ang) * 17, ay * 52);
        hairStrand = 0.62 * radial + 0.38 * noise3(px * 165, py * 165, pz * 180);
        const clump = fbm3(px * 42, py * 42, pz * 42, 2);
        // 提高基础密度：少女头发应浓密、少露头皮。把明暗波动压小。
        hairK = edge * (0.82 + 0.18 * hairStrand) * (0.85 + 0.15 * clump);
        const v = hairStrand;
        // 深栗色（不是纯黑），更柔和
        r += (0.22 + 0.10 * v - r) * hairK;
        g += (0.16 + 0.08 * v - g) * hairK;
        b += (0.15 + 0.08 * v - b) * hairK;
      }
    }

    // 眼周：清纯日系几乎不做眼窝阴影，只保留极淡的上睑线，避免「黑眼圈」。
    for (const ec of [eyeL, eyeR]) {
      const ex = (px - ec.x) / u;
      const ey = (py - ec.y) / u;
      const dist = Math.hypot(ex, ey);
      const ring = smoothstep(eyeR2 / u * 1.35, eyeR2 / u * 1.04, dist);
      if (ring > 0) {
        const up = smoothstep(-0.15, 0.30, ey);
        const k = ring * (0.015 + up * 0.06);
        r -= 0.004 * k;
        g -= 0.004 * k;
        b -= 0.003 * k;
      }
    }

    // ---- 上眼睑边缘 / 睫毛 ----
    // 清纯风格：睫毛只做极淡的一条柔和线，不给「眼线」的重度。
    for (const ec of [eyeL, eyeR]) {
      const rx = (px - ec.x) / u;
      const ryl = (py - ec.y) / u;
      const lidY = 0.072 - 0.30 * rx * rx;
      const span = smoothstep(0.25, 0.15, Math.abs(rx));
      if (span <= 0.002) continue;
      const dd = (ryl - lidY) / 0.011;
      if (Math.abs(dd) > 1.7) continue;
      const core = smoothstep(0.95, 0.28, Math.abs(dd));
      const k = core * 0.35 * span;
      if (k > 0.002) {
        r -= 0.10 * k;
        g -= 0.082 * k;
        b -= 0.075 * k;
      }
    }
    // 下睫毛：清纯风几乎不做下睫毛，去掉，避免下睑脏。

    // ---- 眉毛 ----
    // 用贴图画眉毛，而不是几何贴片：眉毛是长在皮肤上的，morph 让眉头动的时候
    // 贴图会跟着皮肤一起变形；独立 mesh 必须手动追坐标，一不留神就和眉骨脱节。
    //
    // 关键是「核心实心 + 边缘成毛」。上一版整条眉都用噪声打散，结果渲染出来
    // 是一带盐粒点；而整条都实心又像马克笔画的。所以核心区给满，只在最外侧
    // 那圈厚度上用「沿毛流方向拉伸」的高频噪声把边缘撕开。
    const browBase = browDy / u;
    // 眉毛以**脸中线**为镜像基准，而不是各自眼球的 x。
    // 用各自眼球的话，两眼相差 2mm 就足以让左右眉毛画出完全不同的形状
    // （一边带峰、一边是斜直线）—— 人眼对左右不对称极度敏感，一眼就看出「假」。
    const halfEye = Math.abs(eyeR.x - eyeL.x) / 2 / u;
    const rym = (py - mid.y) / u;
    let browK = 0;
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? -1 : 1;
      // 相对同侧眼球的水平偏移，左右严格镜像
      const rx = (Math.abs(px - mid.x) - halfEye * u) / u;
      const s = (rx + 0.280) / 0.700; // 0 = 眉头（靠鼻），1 = 眉尾
      if (s < -0.03 || s > 1.06) continue;
      const sc = clamp01(s);
      // 眉形：眉头略低 → 眉峰在外 2/3 处 → 眉尾下压
      const yc =
        browBase + 0.022 + 0.030 * Math.sin(Math.PI * Math.pow(sc, 0.90)) - 0.022 * sc * sc;
      // 厚度：眉头粗、眉尾细。真人眉毛纵向约 6mm，换算过来半宽 0.042。
      // 之前给 0.030 在 1024 贴图上只有 10px，再被边缘羽化吃掉一半，
      // 渲染出来是一条细线 —— 眉毛的「存在感」全靠厚度。
      const th =
        0.024 * (0.76 + 0.24 * Math.sin(Math.PI * clamp01((sc + 0.10) / 1.10))) * (1 - 0.52 * sc);
      if (th < 1e-4) continue;
      const d = Math.abs(rym - yc) / th;
      if (d > 1.7) continue;
      // 清纯风：眉毛要柔和完整，不要被高频噪声切成虚线。
      // 主体给满，只做极轻的毛流明暗调制，边缘羽化收尾。
      const strand = noise3(px * 40 + py * 8, py * 12, pz * 40);
      const core = smoothstep(1.10, 0.30, d);
      const grain = 0.90 + 0.10 * strand;
      const dens = 0.62 + 0.38 * Math.sin(Math.PI * clamp01((sc + 0.08) / 1.16));
      const fringe = smoothstep(1.55, 1.00, d) * 0.30;
      const k = Math.min(1, core * dens * grain + fringe * dens);
      if (k > browK) browK = k;
    }
    if (browK > 0.003) {
      // 眉毛颜色：柔和的深灰棕，不要纯黑、不要过重。
      const bk = browK * 0.62;
      r += (0.520 - r) * bk;
      g += (0.410 - g) * bk;
      b += (0.400 - b) * bk;
    }

    // 眉弓骨影：眉下方那一道，让眉骨鼓起来。
    // 别给重 —— 压深了会变成「皱眉」，整张脸立刻凶起来。
    const shade = smoothstep(browBase - 0.02, browBase - 0.11, ny) * smoothstep(0.34, 0.15, Math.abs(nx)) * (1 - browK);
    r -= 0.014 * shade;
    g -= 0.014 * shade;
    b -= 0.013 * shade;

    // ---- 唇 ----
    // 唇不是椭圆。辨识度全在三件事上：
    //   1. 上唇有唇峰（中央 V 形凹陷 + 两侧两个峰）和唇珠
    //   2. 下唇比上唇厚，且中央最饱满
    //   3. 嘴角快速收窄并微微上扬
    // 少任何一条，读起来就是「一个深色椭圆」而不是一张嘴。
    //
    // 纵向尺寸不是估的，是沿中线的 z 剖面量出来的（ly 单位 = u）：
    //   上唇红区  ly  +0.02 … +0.20
    //   口裂      ly  -0.05 … +0.01   （该段 z 明显后缩，是唇缝）
    //   下唇红区  ly  -0.10 … -0.30
    // 所以唇缝中心在 ly = -0.05，而不是 0 —— 锚点是牙齿包围盒中心，
    // 比真正的口裂高一点点。差这 0.05 就够让上唇占满整张嘴。
    const lx = (px - mouth.x) / u;
    const ly = (py - mouth.y) / u;
    const lipW = lipHalfW / u;
    const lipH = lipHalfH / u;
    const SEAM_Y = -0.052;
    const LIP_UP = 0.074; // 少女唇：上唇只留一小片柔粉
    const LIP_DN = 0.132; // 下唇饱满但不外扩
    let lipK = 0;
    let seamK = 0;
    let lipUp = 0; // 1 = 上唇，0 = 下唇
    // 嘴角收窄：真实唇在中段几乎等厚，只在最外侧收住。
    const lipProfile = (e) => Math.pow(Math.max(0, 1 - Math.pow(e, 2.0)), 0.50);
    if (Math.abs(lx) < lipW && Math.abs(ly - SEAM_Y) < 0.42) {
      const e = Math.abs(lx) / lipW;
      const w = lipProfile(e);
      // 唇峰：中央 e≈0 处下凹，e≈0.22 处是峰
      const peak = 1 - 0.40 * Math.exp(-((e / 0.16) ** 2));
      // 嘴角微微上扬
      const corner = 0.030 * e * e;
      const upH = w * LIP_UP * peak;
      const dnH = w * LIP_DN * (1 - 0.08 * e * e);
      const rel = ly - SEAM_Y - corner;
      if (rel >= 0) {
        lipK = smoothstep(upH, upH * 0.78, rel);
        lipUp = 1;
      } else {
        lipK = smoothstep(dnH, dnH * 0.80, -rel);
        lipUp = 0;
      }
      // 唇缘羽化：真实唇线不是一条几何曲线，用低频噪声让它轻微不规则。
      // 但幅度不能大：0.55 会在唇外糊出一圈暗红晕，像口红没抹开。
      const wob = fbm3(px * 90, py * 90, pz * 90, 2) - 0.5;
      lipK = clamp01(lipK * (1 + wob * 0.28)) * smoothstep(0, 0.030, w);
      // 唇缝：上下唇交界处一条暗线。这条线一有，嘴立刻「合得上」。
      // 不能太黑：闭嘴时唇缝只是阴影，画成黑线就成了「涂了唇线笔」。
      seamK = smoothstep(0.030, 0.0, Math.abs(rel)) * smoothstep(0, 0.14, w);
    }
    if (lipK > 0.002) {
      // 唇色是暗玫瑰，不是深红。
      // 之前给 0.615*inner+0.10（inner 低到 0.55 → 目标 0.44）在 ACES 之后
      // 直接压成近黑；现在整体提亮，并让下唇中央的唇珠再亮一档。
      const bulb = lipUp === 0 ? smoothstep(0.60, 0.05, Math.abs(lx) / lipW) : 0;
      // 唇纹：沿唇走向的纵向细纹，真人唇上有 15~20 条。
      // 少了这块，唇就是一块光滑的红塑料。
      const grain =
        Math.sin(lx * 165 + (fbm3(px * 60, py * 60, pz * 60, 2) - 0.5) * 9) *
        smoothstep(1.05, 0.55, Math.abs(lx) / lipW);
      // 偏灰粉、不要血红：红绿差拉太大，加上 SSS 的暖红边缘会整体偏「血」色。
      // 唇色：肉粉，不是口红。
      // 决定「自然 / 化了妆」的不是绝对色相，而是**唇与周围皮肤的亮度差**。
      // 之前 r 高 g 低（红绿差 0.23），在 ACES 之后被推成一片饱和的红。
      // 把 g/b 抬上来、红绿差压到 0.13，同一张脸立刻从「涂了口红」变成「本来就这样」。
      const lr = 0.975 + 0.020 * bulb - 0.022 * lipUp + grain * 0.006;
      const lg = 0.705 + 0.018 * bulb - 0.020 * lipUp + grain * 0.005;
      const lb = 0.745 + 0.018 * bulb - 0.018 * lipUp + grain * 0.005;
      const k = lipK * 0.88;
      r += (lr - r) * k;
      g += (lg - g) * k;
      b += (lb - b) * k;
    }
    if (seamK > 0.002) {
      r -= 0.065 * seamK;
      g -= 0.046 * seamK;
      b -= 0.040 * seamK;
    }

    // 下唇与下巴之间那道阴影：真实感最强的几条线索之一，缺了就像贴上去的一块色。
    if (Math.abs(lx) < lipW * 1.15) {
      const e = Math.abs(lx) / lipW;
      const underY = SEAM_Y - LIP_DN * lipProfile(Math.min(e, 1));
      const dy = (ly - underY) / LIP_DN;
      const sh =
        smoothstep(0.02, 0.34, dy) * smoothstep(0.80, 0.34, dy) * smoothstep(1.15, 0.55, e);
      if (sh > 0.001) {
        r -= 0.042 * sh;
        g -= 0.039 * sh;
        b -= 0.034 * sh;
      }
    }

    // 人中：上唇红缘上方中央的两道浅沟。面积很小，但少了这一块，
    // 上唇就像直接贴在鼻底上。
    {
      const e = Math.abs(lx) / lipW;
      const topY = SEAM_Y + LIP_UP;
      if (e < 0.42 && ly > topY - 0.02) {
        const dy = (ly - topY) / 0.16;
        const band = smoothstep(0.05, 0.42, dy) * smoothstep(1.05, 0.45, dy);
        const groove = Math.exp(-(((e - 0.19) / 0.070) ** 2));
        const ph = band * groove * (1 - lipK);
        if (ph > 0.001) {
          r -= 0.032 * ph;
          g -= 0.029 * ph;
          b -= 0.025 * ph;
        }
      }
    }

    // ---- 鼻唇沟 ----
    // 从鼻翼外侧斜向下、绕到嘴角外侧的那道沟。
    // 它是「年轻脸」和「有体积的脸」的分界线：没有它，鼻子到嘴之间是一片
    // 模糊的平面，整张脸读起来像吹起来的气球。做法是一条随深度外扩的斜线，
    // 沟内侧压暗，外侧略微提亮（颊脂垫）。
    let fold = 0;
    {
      const t = clamp01((-0.46 - ny) / 0.44);
      if (t > 0.01 && t < 0.99) {
        const cxn = 0.175 + 0.180 * t; // 越往下越外扩
        const dn = (Math.abs(nx) - cxn) / 0.034;
        const fade = smoothstep(0.0, 0.14, t) * smoothstep(1.0, 0.80, t);
        fold = smoothstep(1.25, 0.0, Math.abs(dn)) * fade;
        if (fold > 0.001) {
          r -= 0.010 * fold;
          g -= 0.009 * fold;
          b -= 0.008 * fold;
        }
        // 沟外侧的颊脂垫高光
        const pad = smoothstep(2.4, 0.5, Math.abs(dn - 2.0)) * fade;
        if (pad > 0.001) {
          r += 0.016 * pad;
          g += 0.011 * pad;
          b += 0.007 * pad;
        }
      }
    }

    // ---- 细节：毛孔、色斑 ----
    // 用 3D 位置采样，避免 UV 拉伸导致毛孔被拉成条。
    // 频率必须跟贴图分辨率对齐：1 世界单位 ≈ 600 贴图像素，
    // 之前给 640（波长 0.9px）等于噪点，经 mipmap 平均后一点质感都不剩。
    // 160 对应约 4px 波长 ≈ 1.3mm，正好是肉眼在近景能读到的皮肤纹理尺度。
    const pn = noise3(px * 160, py * 160, pz * 160);
    const pn2 = noise3(px * 300 + 31.7, py * 300, pz * 300);
    const mottle = fbm3(px * 45, py * 45, pz * 45, 2);

    // 唇和眼周不要毛孔（那里的质感是光滑的）
    const detailK = 1 - lipK * 0.85 - hairK * 0.9;
    const pores = ((pn - 0.5) * 0.9 + (pn2 - 0.5) * 0.42) * 0.004 * detailK;
    const blotch = (mottle - 0.5) * 0.004 * detailK;
    // 注意方向：鼻头在眼下方，ny 是负的（实测鼻尖 -0.476）。
    // 之前写成 smoothstep(0.1, 0.5, ny)，等于只在鼻梁以上才算「油」，
    // 鼻头永远拿不到 —— T 区油光从来没生效过。
    // 另外必须按「脊」收窄：整块椭圆都降 roughness 会在鼻梁上糊出一颗圆形高光，
    // 看着像贴了颗珠子。真人鼻梁的油光是沿脊的一条竖线。
    const noseOil =
      noseK * smoothstep(-0.10, -0.24, ny) * smoothstep(0.115, 0.040, Math.abs(nx));

    r += pores + blotch;
    g += pores * 0.94 + blotch * 0.9;
    b += pores * 0.88 + blotch * 0.82;

    const o3 = o * 3;
    albedo[o3] = s2l(clamp01(r));
    albedo[o3 + 1] = s2l(clamp01(g));
    albedo[o3 + 2] = s2l(clamp01(b));

    // ---- 粗糙度 ----
    // 皮肤的油光分布是真实感的重要线索：额头/鼻梁出油、唇湿润、颊干爽、
    // 下颌偏干。全脸一个 roughness 是「石膏感」最大的来源之一。
    let rg = 0.58;
    rg -= 0.11 * noseOil; // 鼻头到鼻梁
    rg -= 0.10 * forehead; // 额头 T 区
    rg -= 0.05 * cheek;
    rg += 0.09 * jaw; // 下颌偏干
    rg -= 0.26 * lipK; // 唇是湿润的，反光明显
    rg -= 0.07 * alar; // 鼻翼沟里反而是干的、暗的
    rg -= 0.05 * earK;
    // 寸头不反光：头发比皮肤粗糙得多，且方向性很强
    rg += (0.80 - rg) * hairK * 0.9;
    rg += (pn - 0.5) * 0.12;
    rough[o] = clamp01(rg);

    // ---- 高度场（供法线用）----
    // 毛孔是「凹」，所以取负；唇纹是沿横向的细沟
    let hgt = -(pn - 0.5) * 0.5;
    if (lipK > 0.05) {
      // 唇本身的隆起：几何只有 2694 个顶点，唇的体积感全靠高度场补。
      // 下唇中央（唇珠）最高，往嘴角和唇缘落下。
      const e = Math.abs(lx) / lipW;
      const bulge = (lipUp === 0 ? 0.42 : 0.26) * lipProfile(Math.min(e, 1));
      hgt += bulge * lipK;
      // 唇纹：法线图上必须是纵向细沟（沿唇走向的竖条纹），
      // 之前用 sin(ly*820) 是横向的同心纹，方向错了，而且频率高到成噪点。
      hgt += Math.sin(lx * 165 + (mottle - 0.5) * 9) * 0.22 * lipK;
    }
    // 头发的高度场：发丝是细小的凸起，法线图上要有颗粒感，
    // 否则寸头会是一块死黑的平面。
    if (hairK > 0.02) {
      hgt += (hairStrand - 0.5) * 0.85 * hairK;
    }
    // 鼻唇沟在法线图上也要是个凹槽，光才会顺着它打出阴影
    if (fold > 0.01) hgt -= 0.62 * fold;
    height[o] = hgt;
  }

  /* --------- 填洞：UV 岛边缘与面片间隙 --------- */
  // 不填的话 mipmap 会把背景色混进来，模型边缘出现一圈脏边。
  // 三张图一起扩散，省掉两轮全图遍历（1024² 跑三遍不是小事）。
  dilateAll(
    [
      { buf: albedo, ch: 3 },
      { buf: rough, ch: 1 },
      { buf: height, ch: 1 },
    ],
    mask,
    size,
    3
  );

  /* --------- 由高度场求切线空间法线 --------- */
  const normal = new Float32Array(size * size * 3);
  const strength = 1.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const xl = height[y * size + Math.max(0, x - 1)];
      const xr = height[y * size + Math.min(size - 1, x + 1)];
      const yu = height[Math.max(0, y - 1) * size + x];
      const yd = height[Math.min(size - 1, y + 1) * size + x];
      let nX = (xl - xr) * strength;
      let nY = (yd - yu) * strength;
      let nZ = 1;
      const len = Math.hypot(nX, nY, nZ) || 1;
      nX /= len;
      nY /= len;
      nZ /= len;
      const o3 = o * 3;
      normal[o3] = nX * 0.5 + 0.5;
      normal[o3 + 1] = nY * 0.5 + 0.5;
      normal[o3 + 2] = nZ * 0.5 + 0.5;
    }
  }

  const elapsed = performance.now() - t0;

  // 调试标记：把几个已知世界位置投影到 UV。
  // 同一位置给出两种行方向的落点（A = (1-v)，B = v），
  // 哪个落在眼洞/唇上，就说明哪种映射是对的 —— 不用再靠猜。
  const marks = [];
  {
    const probe = {
      eyeL,
      eyeR,
      mouth,
      browMid: new THREE.Vector3((eyeL.x + eyeR.x) / 2, mid.y + 0.38 * u, mid.z),
      chin: new THREE.Vector3((eyeL.x + eyeR.x) / 2, mid.y - 0.75 * u, mid.z),
      nose: new THREE.Vector3((eyeL.x + eyeR.x) / 2, mid.y - 0.30 * u, mid.z),
    };
    for (const [label, target] of Object.entries(probe)) {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < vCount; i++) {
        const d = (wx[i] - target.x) ** 2 + (wy[i] - target.y) ** 2 + (wz[i] - target.z) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0) {
        marks.push({
          label,
          x: us[best] * size,
          yA: (1 - vs[best]) * size,
          yB: vs[best] * size,
        });
      }
    }
  }

  return {
    albedo,
    rough,
    normal,
    size,
    u,
    elapsed,
    marks,
    stats: { triCount, vCount, lipHalfW, lipHalfH, eyeR: eyeR2 },
  };
}

/** 把有效像素向外扩散，填补 UV 岛之间的小缝（多个缓冲区共用一轮遍历） */
function dilateAll(items, mask, size, rounds) {
  const accs = items.map(() => [0, 0, 0]);
  let cur = new Uint8Array(mask);
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(cur);
    for (let y = 1; y < size - 1; y++) {
      let o = y * size + 1;
      for (let x = 1; x < size - 1; x++, o++) {
        if (cur[o]) continue;
        let n = 0;
        for (const a of accs) {
          a[0] = 0;
          a[1] = 0;
          a[2] = 0;
        }
        for (let dy = -1; dy <= 1; dy++) {
          const base = o + dy * size;
          for (let dx = -1; dx <= 1; dx++) {
            const oo = base + dx;
            if (!cur[oo]) continue;
            n++;
            for (let k = 0; k < items.length; k++) {
              const it = items[k];
              const a = accs[k];
              if (it.ch === 3) {
                a[0] += it.buf[oo * 3];
                a[1] += it.buf[oo * 3 + 1];
                a[2] += it.buf[oo * 3 + 2];
              } else {
                a[0] += it.buf[oo];
              }
            }
          }
        }
        if (!n) continue;
        for (let k = 0; k < items.length; k++) {
          const it = items[k];
          const a = accs[k];
          if (it.ch === 3) {
            it.buf[o * 3] = a[0] / n;
            it.buf[o * 3 + 1] = a[1] / n;
            it.buf[o * 3 + 2] = a[2] / n;
          } else {
            it.buf[o] = a[0] / n;
          }
        }
        next[o] = 1;
      }
    }
    cur = next;
  }
}

/* ---------------- 眼球 ---------------- */

/**
 * 眼球贴图：按「从球心指向该点」的方向决定颜色。
 * 顶点色画虹膜只能做到一个模糊的色块，而真实眼球的辨识度几乎全在
 * 瞳孔边缘、虹膜纤维、角膜缘环这三处细节上。
 */
export function bakeEye(meshes, eyeAnchors, w = 512, h = 256) {
  /**
   * 眼球不能用模型自带的 UV。
   *
   * 那些 UV 是球体展开后的几个圆，彼此重叠 —— 光栅化时互相覆盖，
   * 结果贴图上只有一小块分到虹膜，剩下是灰/棕色碎块，渲染出来就是两颗黑珠子。
   *
   * 改成重写 UV 为球坐标（经度 u、纬度 v），贴图按经纬度直接生成：
   * 每个像素反算出一条视线方向，再按方向决定颜色。整颗球面一一对应，
   * 不存在重叠，虹膜也就稳定落在 u=0.5 / v=0.5（正前方）。
   */
  const v3 = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const anchor = eyeAnchors[mi] || eyeAnchors[0];
    const pos = mesh.geometry.attributes.position;
    if (!pos || !anchor) continue;
    const arr = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      v3.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      dir.copy(v3).sub(anchor.center).normalize();
      // 经度：+z 为 0，绕 y 轴一圈。纬度：+y 为 0，到 -y 为 π
      arr[i * 2] = Math.atan2(dir.x, dir.z) / (Math.PI * 2) + 0.5;
      arr[i * 2 + 1] = Math.acos(Math.max(-1, Math.min(1, dir.y))) / Math.PI;
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(arr, 2));
  }

  const albedo = new Float32Array(w * h * 3);
  const rough = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const phi = ((y + 0.5) / h) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let x = 0; x < w; x++) {
      const theta = ((x + 0.5) / w - 0.5) * Math.PI * 2;
      eyePixel(albedo, rough, y * w + x, sp * Math.sin(theta), cp, sp * Math.cos(theta));
    }
  }

  return { albedo, rough, width: w, height: h, size: w };
}

function eyePixel(albedo, rough, o, dx, dy, dz) {
  // 虹膜的「正前方」不是球体的赤道。
  // 实测这颗眼球的几何最前点在 v=0.455（对应 dy=+0.14），而瞳孔画在赤道（dy=0）。
  // 差这 8° 就足够让眼白全堆在下半、虹膜贴着上眼睑 —— 读起来就是「一直在往上看」。
  // 所以把虹膜参考方向压到 dy=-0.14，落到眼裂中央。
  const REF_Y = -0.145;
  const REF_Z = Math.sqrt(1 - REF_Y * REF_Y);
  const d = clamp01(dy * REF_Y + dz * REF_Z);
  const ang = Math.acos(Math.min(1, Math.max(-1, d)));

  // 巩膜不是灰的，但也不是纯白。0.935 在渲染里会读成两块「画上去的白」，
  // 真人眼白只有 0.86~0.90，而且上部被上睑压暗。
  let r = 0.897;
  let g = 0.886;
  let b = 0.876;
  let rg = 0.26;

  const blood = fbm3(dx * 9, dy * 9, dz * 9, 3);
  r = 0.897 + (blood - 0.5) * 0.050;
  g = 0.886 + (blood - 0.5) * 0.075;
  b = 0.876 + (blood - 0.5) * 0.090; // 蓝分量波动更大 → 眼白带极淡的冷调，不是死白
  // 往后贴的一圈更暗（眼睑阴影会盖住，但轮廓处透出来）。
  // 清纯风：彻底去掉这圈暗色。它是「内眼角污迹」的直接来源 ——
  // 眼球球体远大于眼裂，球体侧面正好从内眼角露出来，暗环就糊在眼角上。
  // 眼白保持干净通透，暗部交给眼睑自阴影去表现。
  const back = 0.0;

  // 上眼睑投影：眼白的上半部压出一道极淡的阴影。
  // 清纯风：给很淡的一层，既保留立体感又不显脏。
  const lid = smoothstep(REF_Y - 0.02, REF_Y + 0.52, dy);
  r -= 0.05 * lid;
  g -= 0.055 * lid;
  b -= 0.050 * lid;

  // 角膜缘：虹膜外圈那道深色环
  // 0.375 而不是 0.56：这个模型的脸裂（上下眼睑之间）很窄，只能看到眼球正前方
  // 一小块球冠。虹膜给到 0.56 正好把整块视野占满，眼白只剩两个小三角。
  // 缩到 0.375 后虹膜约占眼裂宽度的 2/3，两头才露得出巩膜。
  // 眼球几何被 reshapeEye 缩到 0.80，虹膜随之变小。
  // 把张角放大到接近真人的 0.52（虹膜直径 ≈ 眼球直径的一半）补回来，
  // 视觉上就是「眼白少、虹膜大」，这是眼睛显得有神的关键比例。
  const irisOuter = 0.685;
  const irisInner = 0.200;
  if (ang < irisOuter) {
    const t = smoothstep(irisOuter, irisOuter - 0.045, ang); // 环边缘柔和
    const ringK = smoothstep(irisOuter, irisOuter - 0.10, ang);
    // 清纯萝莉：金棕色的明亮虹膜，瞳孔深、外圈有柔和深环形成对比，
    // 这样眼睛才「有神」—— 纯浅色会显得空洞。
    let ir = 0.600;
    let ig = 0.420;
    let ib = 0.280;
    // 放射状纤维：沿角度方向的高频噪声。
    const theta = Math.atan2(dy, dx);
    const fiber = fbm3(Math.cos(theta) * 6, Math.sin(theta) * 6, dz * 8, 3);
    const streak = (fiber - 0.5) * 0.30 * (0.35 + ringK);
    ir += streak;
    ig += streak * 0.72;
    ib += streak * 0.55;
    // 内侧靠近瞳孔处更暖更亮（虹膜卷缩轮）
    ir += 0.150 * smoothstep(0.26, 0.08, ang);
    ig += 0.100 * smoothstep(0.26, 0.08, ang);
    // 下半圈透亮的蜂蜜色渐变，避免棕色虹膜变成一颗黑豆
    const lowerGlow = smoothstep(0.10, -0.34, dy - REF_Y) * ringK;
    ir += 0.17 * lowerGlow;
    ig += 0.13 * lowerGlow;
    ib += 0.070 * lowerGlow;
    // 角膜缘深环：减弱，避免虹膜外圈发黑。
    const limb = smoothstep(irisOuter - 0.012, irisOuter - 0.075, ang) * smoothstep(irisOuter - 0.19, irisOuter - 0.075, ang);
    ir -= 0.12 * limb;
    ig -= 0.14 * limb;
    ib -= 0.085 * limb;

    r += (ir - r) * t;
    g += (ig - g) * t;
    b += (ib - b) * t;
    rg += (0.10 - rg) * t;
  }

  // 瞳孔
  if (ang < irisInner) {
    const k = smoothstep(irisInner, irisInner * 0.55, ang);
    r += (0.015 - r) * k;
    g += (0.014 - g) * k;
    b += (0.016 - b) * k;
    rg += (0.06 - rg) * k;
  }

  // 日系眼睛必须能直接读到高光，而不是完全依赖灯光碰巧反射。
  // 高光画在角膜贴图上，会随眼球一起运动；一大一小，位置错开。
  {
    const ix = dx;
    const iy = (dy - REF_Y) / REF_Z;
    const h1 = Math.hypot((ix + 0.145) / 0.090, (iy - 0.175) / 0.105);
    const h2 = Math.hypot((ix - 0.125) / 0.042, (iy + 0.145) / 0.048);
    const hk = Math.max(smoothstep(1.10, 0.58, h1), smoothstep(1.10, 0.55, h2) * 0.82);
    r += (0.99 - r) * hk;
    g += (0.985 - g) * hk;
    b += (0.975 - b) * hk;
    rg += (0.08 - rg) * hk;
  }

  const o3 = o * 3;
  albedo[o3] = s2l(clamp01(r));
  albedo[o3 + 1] = s2l(clamp01(g));
  albedo[o3 + 2] = s2l(clamp01(b));
  rough[o] = clamp01(rg);
}

/* ---------------- 数据 -> 纹理 ---------------- */

export function toCanvas(data, w, h, channels) {
  const cvs = document.createElement('canvas');
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const n = w * h;
  if (channels === 3) {
    for (let i = 0; i < n; i++) {
      d[i * 4] = Math.round(clamp01(data[i * 3]) * 255);
      d[i * 4 + 1] = Math.round(clamp01(data[i * 3 + 1]) * 255);
      d[i * 4 + 2] = Math.round(clamp01(data[i * 3 + 2]) * 255);
      d[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = Math.round(clamp01(data[i]) * 255);
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}
