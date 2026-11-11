/** 用 gltf-transform 读未压缩几何，确认能拿到 position / uv / index */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO({ extensions: ALL_EXTENSIONS }).registerExtensions(ALL_EXTENSIONS);
io.registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const doc = await io.read('assets/facecap.glb');
const root = doc.getRoot();
const meshes = root.listMeshes();
console.log('meshes', meshes.length);

for (const m of meshes) {
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    const uv = p.getAttribute('TEXCOORD_0');
    const idx = p.getIndices();
    console.log(
      m.getName() || '(unnamed)',
      'verts', pos.getCount(),
      'uv', uv ? uv.getCount() : null,
      'tris', idx ? idx.getCount() / 3 : null,
      'weights', p.getAttribute('WEIGHTS_0') ? 'yes' : 'no',
      'targets', p.listTargets().length
    );
    if (uv) {
      const a = uv.getArray();
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < uv.getCount(); i++) {
        const u = a[i * 2], v = a[i * 2 + 1];
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      console.log('   uv 范围', [u0, u1, v0, v1].map((x) => +x.toFixed(4)));
    }
  }
}
