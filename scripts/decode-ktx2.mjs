import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

const dir = path.resolve('basis');
const src = fs.readFileSync(path.join(dir, 'basis_transcoder.js'), 'utf8');
const mod = { exports: {} };
const nodeRequire = createRequire(path.join(dir, 'basis_transcoder.js'));
const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', 'process', 'console',
  src + '\n;return module.exports;');
const BASIS = fn(mod, mod.exports, nodeRequire, path.join(dir, 'basis_transcoder.js'), dir, process, console);
const m = await BASIS({ locateFile: (f) => path.join(dir, f) });

// 从 GLB 里取出第一张图的 bufferView
const glb = fs.readFileSync('assets/facecap.glb');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const img = json.images[0];
const bv = json.bufferViews[img.bufferView];
const ktx2 = new Uint8Array(glb.buffer, glb.byteOffset + binStart + (bv.byteOffset || 0), bv.byteLength);

const file = new m.KTX2File(ktx2);
if (!file.startTranscoding()) throw new Error('startTranscoding failed');
const w = file.getWidth(0, 0);
const h = file.getHeight(0, 0);
const fmt = m.transcoder_texture_format.cTFRGBA32;
const size = file.getImageTranscodedSizeInBytes(0, 0, fmt);
const dst = new Uint8Array(size);
if (!file.transcodeImage(dst, 0, 0, fmt, 0, -1)) throw new Error('transcodeImage failed');
file.close();

const png = new PNG({ width: w, height: h });
png.data = Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength);
fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/face_skin.png', PNG.sync.write(png));
console.log(`decoded ${w}x${h} -> assets/face_skin.png (${(fs.statSync('assets/face_skin.png').size / 1024).toFixed(0)} KB)`);
