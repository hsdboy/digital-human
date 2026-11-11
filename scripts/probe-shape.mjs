/** 摸清头部形状尺度：居中后的包围盒、眼/牙位置、唇部朝向，供贴图烘焙用 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO({ extensions: ALL_EXTENSIONS }).registerExtensions(ALL_EXTENSIONS);
io.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read('assets/facecap.glb');
const root = doc.getRoot();

// 所有 primitive 的 position 合起来算整体包围盒
let gmin = [1e9, 1e9, 1e9];
let gmax = [-1e9, -1e9, -1e9];
const prims = [];
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION').getArray();
    const uv = p.getAttribute('TEXCOORD_0').getArray();
    const idx = p.getIndices().getArray();
    const n = pos.length / 3;
    let min = [1e9, 1e9, 1e9];
    let max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = pos[i * 3 + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
        if (v < gmin[c]) gmin[c] = v;
        if (v > gmax[c]) gmax[c] = v;
      }
    }
    prims.push({ n, pos, uv, idx, min, max, targets: p.listTargets().length });
    console.log(`prim verts=${n} targets=${prims.at(-1).targets} bbox min=${min.map((x) => +x.toFixed(3))} max=${max.map((x) => +x.toFixed(3))}`);
  }
}

const center = gmin.map((v, i) => (v + gmax[i]) / 2);
const size = gmin.map((v, i) => gmax[i] - v);
console.log('\n整体 bbox 尺寸', size.map((x) => +x.toFixed(3)), '中心', center.map((x) => +x.toFixed(3)));
const span = Math.max(...size);
console.log('归一化 span', span.toFixed(3), '→ 缩放 1/span');

// 头部 = targets 最多的那个
const head = prims.reduce((a, b) => (b.targets > a.targets ? b : a));
console.log('\n头部居中后 bbox:', head.min.map((v, i) => +(v - center[i]).toFixed(3)), head.max.map((v, i) => +(v - center[i]).toFixed(3)));

// 眼球：另两个 530 顶点
const eyes = prims.filter((p) => p.n === 530);
for (const e of eyes) {
  const c = e.min.map((v, i) => (v + e.max[i]) / 2 - center[i]);
  const r = Math.hypot(...e.max.map((v, i) => (v - e.min[i]) / 2));
  console.log('眼球(居中) 中心', c.map((x) => +x.toFixed(3)), '半径', +r.toFixed(3));
}
// 牙齿
const teeth = prims.find((p) => p.n === 614);
if (teeth) {
  console.log('牙齿(居中) bbox', teeth.min.map((v, i) => +(v - center[i]).toFixed(3)), teeth.max.map((v, i) => +(v - center[i]).toFixed(3)));
}

// 唇部：嘴角/唇缘在哪。取 z 最大的一批顶点，看它们的 y 分布
const hp = head.pos;
const n = head.n;
const verts = [];
for (let i = 0; i < n; i++) {
  verts.push([hp[i * 3] - center[0], hp[i * 3 + 1] - center[1], hp[i * 3 + 2] - center[2]]);
}
verts.sort((a, b) => b[2] - a[2]);
console.log('\n最靠前(z 最大)的 12 个顶点:', verts.slice(0, 12).map((v) => v.map((x) => +x.toFixed(3))));
const lowest = verts.filter((v) => v[1] < verts[0][1] - 0.12).slice(0, 6);
console.log('前突区域偏下的顶点:', lowest.map((v) => v.map((x) => +x.toFixed(3))));
console.log('\ny 范围（居中）', verts.reduce((a, v) => [Math.min(a[0], v[1]), Math.max(a[1], v[1])], [9, -9]).map((x) => +x.toFixed(3)));
console.log('x 范围（居中）', verts.reduce((a, v) => [Math.min(a[0], v[0]), Math.max(a[1], v[0])], [9, -9]).map((x) => +x.toFixed(3)));
console.log('z 范围（居中）', verts.reduce((a, v) => [Math.min(a[0], v[2]), Math.max(a[1], v[2])], [9, -9]).map((x) => +x.toFixed(3)));
