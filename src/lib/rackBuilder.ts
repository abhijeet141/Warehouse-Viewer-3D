import * as THREE from 'three';
import type { Segment } from '../types';

// Real rack hardware dimensions (mm), matching the warehouse data:
// BAY offsetX=100 is the upright width, LEVEL offsetZ=100 the beam height,
// bay X-pitch 3700 vs dimension 3600 leaves the 100mm frame slot between bays.
export const RACK = {
  POST: 100,            // upright post cross-section
  FRAME_GAP: 100,       // bay-to-bay gap = shared upright frame slot
  BEAM_H: 100,
  BEAM_D: 120,
  BRACE: 45,            // bracing member cross-section
  BRACE_PANEL: 1500,    // target vertical panel height for the zig-zag bracing
  BASEPLATE: { x: 180, y: 20, z: 150 },
};

export const RACK_COLORS = {
  upright: 0x1e4fa3,
  bracing: 0x9aa2aa,
  beam: 0xe8731a,
  basePlate: 0x44484c,
  signBg: '#1d4ed8',
  endGuard: 0xf0b400, // safety-yellow rack-end protectors
};

// Deterministic per-index hash → [0,1): stable load placement across reloads.
function hash01(i: number): number {
  let h = Math.imul(i + 1, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1597334677) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface RackRow {
  aisle: string;
  y: number;       // data coordinateY (depth axis) of the row's min corner
  depth: number;   // data dimensionY
  height: number;  // data dimensionZ
  bays: Segment[]; // sorted by coordinateX
}

export interface Frame {
  x: number;       // min corner of the 100mm frame slot (data X)
  y: number;
  depth: number;
  height: number;
}

// three.js axes: x ← coordinateX, y(up) ← coordinateZ, z ← coordinateY.

const aisleLetterOf = (name: string) => (name.match(/^[A-Z]+/i)?.[0] ?? name).toUpperCase();

export function groupBaysIntoRows(segments: Segment[]): RackRow[] {
  const rows = new Map<string, RackRow>();
  for (const s of segments) {
    if (s.type !== 'BAY') continue;
    const letter = aisleLetterOf(s.fullName);
    const key = `${letter}|${s.coordinateY}`;
    let row = rows.get(key);
    if (!row) {
      row = { aisle: letter, y: s.coordinateY, depth: s.dimensionY, height: s.dimensionZ, bays: [] };
      rows.set(key, row);
    }
    row.bays.push(s);
    row.depth = Math.max(row.depth, s.dimensionY);
    row.height = Math.max(row.height, s.dimensionZ);
  }
  const out = [...rows.values()];
  for (const r of out) r.bays.sort((a, b) => a.coordinateX - b.coordinateX);
  return out;
}

// One frame before the first bay, one after the last, and one in every
// bay-to-bay gap. Gaps wider than 150mm (tunnels, missing bays) get a closing
// frame on each side instead of a shared one.
export function computeFrames(rows: RackRow[]): Frame[] {
  const frames: Frame[] = [];
  for (const row of rows) {
    const { y, depth, height, bays } = row;
    if (bays.length === 0) continue;
    frames.push({ x: bays[0].coordinateX - RACK.FRAME_GAP, y, depth, height });
    for (let i = 0; i < bays.length; i++) {
      const cur = bays[i];
      const curEnd = cur.coordinateX + cur.dimensionX;
      const next = bays[i + 1];
      if (!next) {
        frames.push({ x: curEnd, y, depth, height });
      } else if (next.coordinateX - curEnd <= 150) {
        frames.push({ x: curEnd, y, depth, height });
      } else {
        frames.push({ x: curEnd, y, depth, height });
        frames.push({ x: next.coordinateX - RACK.FRAME_GAP, y, depth, height });
      }
    }
  }
  return frames;
}

export function buildRacks(
  segments: Segment[],
  rows: RackRow[],
): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'RACKS';
  const disposables: { dispose(): void }[] = [];
  const dummy = new THREE.Object3D();

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);

  const frames = computeFrames(rows);
  const levels = segments.filter((s) => s.type === 'LEVEL');

  // Top-level design change: the topmost level is open from the top. For each
  // rack stack we find the highest LEVEL so we can (a) skip its upper beam and
  // (b) cut the uprights down. "Top shelf" = that top level's coordinateZ (the
  // beam it rests on); the posts/frame are trimmed to about half their height
  // above that shelf instead of running to the full bay height.
  const topZByFootprint = new Map<string, number>();
  const topShelfZByY = new Map<number, number>();
  for (const lv of levels) {
    const fk = `${lv.coordinateX}|${lv.coordinateY}`;
    const fPrev = topZByFootprint.get(fk);
    if (fPrev === undefined || lv.coordinateZ > fPrev) topZByFootprint.set(fk, lv.coordinateZ);
    const yPrev = topShelfZByY.get(lv.coordinateY);
    if (yPrev === undefined || lv.coordinateZ > yPrev) topShelfZByY.set(lv.coordinateY, lv.coordinateZ);
  }
  // Trimmed upright height per frame: halfway between the top shelf and the old
  // full height. Frames with no levels (shouldn't happen) keep their height.
  const frameTops = frames.map((f) => {
    const shelf = topShelfZByY.get(f.y);
    return shelf === undefined ? f.height : shelf + (f.height - shelf) / 2;
  });

  function makeInst(count: number, mat: THREE.Material, name: string): THREE.InstancedMesh {
    const inst = new THREE.InstancedMesh(unitBox, mat, count);
    inst.name = name;
    inst.raycast = () => {}; // structure must never steal hover from SPACE
    disposables.push(mat);
    group.add(inst);
    return inst;
  }

  function setBox(
    inst: THREE.InstancedMesh, i: number,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    rotX = 0,
  ) {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(rotX, 0, 0);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }

  // Upright posts: two per frame, front and back of the rack depth.
  const posts = makeInst(
    frames.length * 2,
    new THREE.MeshStandardMaterial({ color: RACK_COLORS.upright, roughness: 0.55, metalness: 0.35 }),
    'RACK_POSTS',
  );
  let pi = 0;
  frames.forEach((f, idx) => {
    const top = frameTops[idx]; // trimmed: posts stop above the top level, not the full bay height
    for (const zOff of [RACK.POST / 2, f.depth - RACK.POST / 2]) {
      setBox(posts, pi++, f.x + RACK.POST / 2, top / 2, f.y + zOff, RACK.POST, top, RACK.POST);
    }
  });

  // Frame bracing: horizontal member at each panel bottom plus the frame top,
  // one diagonal per panel alternating direction (zig-zag), all spanning the
  // clear depth between post centres.
  // Bracing rises with the (now trimmed) upright frame, so it never floats above
  // the shortened posts.
  const framePanels = frames.map((_, idx) => Math.max(1, Math.round(frameTops[idx] / RACK.BRACE_PANEL)));
  let braceCount = 0;
  for (const n of framePanels) braceCount += 2 * n + 1;
  const braces = makeInst(
    braceCount,
    new THREE.MeshStandardMaterial({ color: RACK_COLORS.bracing, roughness: 0.5, metalness: 0.6 }),
    'RACK_BRACING',
  );
  let bi = 0;
  frames.forEach((f, idx) => {
    const n = framePanels[idx];
    const top = frameTops[idx];
    const panelH = top / n;
    const clearDepth = f.depth - RACK.POST;
    const cx = f.x + RACK.POST / 2;
    const cz = f.y + f.depth / 2;
    const diagLen = Math.hypot(clearDepth, panelH);
    const diagTilt = Math.atan2(clearDepth, panelH);
    for (let p = 0; p < n; p++) {
      const yBottom = p * panelH;
      setBox(braces, bi++, cx, yBottom + RACK.BRACE / 2, cz, RACK.BRACE, RACK.BRACE, clearDepth);
      setBox(braces, bi++, cx, yBottom + panelH / 2, cz, RACK.BRACE, diagLen, RACK.BRACE, (p % 2 === 0 ? 1 : -1) * diagTilt);
    }
    setBox(braces, bi++, cx, top - RACK.BRACE / 2, cz, RACK.BRACE, RACK.BRACE, clearDepth);
  });

  // Beam pairs: one front + one back beam at the TOP of every LEVEL segment.
  // Levels start at the slab, so this yields beams at 2500–2600, 5100–5200, …
  // and none at floor level — matching the physical racking.
  const beams = makeInst(
    levels.length * 2,
    new THREE.MeshStandardMaterial({ color: RACK_COLORS.beam, roughness: 0.5, metalness: 0.3 }),
    'RACK_BEAMS',
  );
  let bmi = 0;
  for (const lv of levels) {
    // Skip the upper beam of the topmost level in each stack — that level is
    // open from the top, with no beam above it.
    if (lv.coordinateZ === topZByFootprint.get(`${lv.coordinateX}|${lv.coordinateY}`)) continue;
    const xC = lv.coordinateX + lv.dimensionX / 2;
    const yC = lv.coordinateZ + lv.dimensionZ + RACK.BEAM_H / 2;
    for (const zC of [lv.coordinateY + RACK.BEAM_D / 2, lv.coordinateY + lv.dimensionY - RACK.BEAM_D / 2]) {
      // +2mm so beam tops aren't coplanar with the LEVEL overlay boxes
      setBox(beams, bmi++, xC, yC, zC, lv.dimensionX, RACK.BEAM_H + 2, RACK.BEAM_D);
    }
  }
  beams.count = bmi; // we skipped the top-level beams, so trim the instance count

  // Base plates under every post.
  const plates = makeInst(
    frames.length * 2,
    new THREE.MeshStandardMaterial({ color: RACK_COLORS.basePlate, roughness: 0.7, metalness: 0.5 }),
    'RACK_BASEPLATES',
  );
  let pli = 0;
  for (const f of frames) {
    for (const zOff of [RACK.POST / 2, f.depth - RACK.POST / 2]) {
      setBox(plates, pli++, f.x + RACK.POST / 2, RACK.BASEPLATE.y / 2, f.y + zOff, RACK.BASEPLATE.x, RACK.BASEPLATE.y, RACK.BASEPLATE.z);
    }
  }

  // Safety-yellow guard at both ends of every rack row, like the physical
  // rack-end protectors that face the cross-aisles.
  const GUARD_H = 400;
  const GUARD_T = 160;
  const guards = makeInst(
    rows.length * 2,
    new THREE.MeshStandardMaterial({ color: RACK_COLORS.endGuard, roughness: 0.5, metalness: 0.2 }),
    'RACK_END_GUARDS',
  );
  let gi = 0;
  for (const row of rows) {
    if (row.bays.length === 0) continue;
    const first = row.bays[0];
    const last = row.bays[row.bays.length - 1];
    const zC = row.y + row.depth / 2;
    setBox(guards, gi++, first.coordinateX - RACK.FRAME_GAP - GUARD_T / 2 - 20, GUARD_H / 2, zC, GUARD_T, GUARD_H, row.depth + 120);
    setBox(guards, gi++, last.coordinateX + last.dimensionX + GUARD_T / 2 + 20, GUARD_H / 2, zC, GUARD_T, GUARD_H, row.depth + 120);
  }
  guards.count = gi;

  for (const inst of [posts, braces, beams, plates, guards]) {
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.computeBoundingBox();
  }

  return {
    group,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

// Pallets + shrink-wrapped box loads in (almost) every SPACE, so the racks
// read full like the photos. Occupancy is a stable per-index hash for now;
// swap in real pod occupancy when it gets fetched.
export function buildPallets(spaces: Segment[]): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'LOADS';
  const disposables: { dispose(): void }[] = [];
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);
  const dummy = new THREE.Object3D();

  const occupied: number[] = [];
  for (let i = 0; i < spaces.length; i++) if (hash01(i) < 0.93) occupied.push(i);

  const palletMat = new THREE.MeshStandardMaterial({ color: 0x9c7344, roughness: 0.9, metalness: 0 });
  // White base so per-instance colors carry the cardboard shade untinted.
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  disposables.push(palletMat, boxMat);

  const pallets = new THREE.InstancedMesh(unitBox, palletMat, occupied.length);
  pallets.name = 'LOAD_PALLETS';
  pallets.raycast = () => {}; // loads must never steal hover from SPACE
  const boxes = new THREE.InstancedMesh(unitBox, boxMat, occupied.length);
  boxes.name = 'LOAD_BOXES';
  boxes.raycast = () => {};

  const PALLET_H = 150;
  const color = new THREE.Color();
  occupied.forEach((si, j) => {
    const s = spaces[si];
    const cx = s.coordinateX + s.dimensionX / 2;
    const cz = s.coordinateY + s.dimensionY / 2;
    const r1 = hash01(si * 3 + 1);
    const r2 = hash01(si * 3 + 2);
    const pw = Math.min(1100, s.dimensionX - 100);
    const pd = Math.min(1100, s.dimensionY - 50);

    dummy.position.set(cx, s.coordinateZ + PALLET_H / 2, cz);
    dummy.scale.set(pw, PALLET_H, pd);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    pallets.setMatrixAt(j, dummy.matrix);

    // Load height varies per slot, capped to clear the beam above.
    const maxLoad = Math.max(600, s.dimensionZ - PALLET_H - 350);
    const bh = maxLoad * (0.62 + 0.38 * r1);
    dummy.position.set(cx, s.coordinateZ + PALLET_H + bh / 2, cz);
    dummy.scale.set(pw - 40, bh, pd - 30);
    dummy.updateMatrix();
    boxes.setMatrixAt(j, dummy.matrix);

    // Cardboard browns, with the odd pale shrink-wrapped load mixed in.
    if (r2 > 0.85) color.setHSL(0.08, 0.10, 0.72 + 0.08 * r1);
    else color.setHSL(0.07 + 0.02 * r2, 0.45, 0.42 + 0.14 * r1);
    boxes.setColorAt(j, color);
  });

  for (const inst of [pallets, boxes]) {
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.computeBoundingBox();
  }
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  group.add(pallets, boxes);

  return {
    group,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

// Banner artwork hung on the netting. Drop the real banner photos into
// src/assets/banners/ (jpg/png) and they are picked up automatically, in
// filename order; with no files there, stylized placeholder posters render.
const BANNER_URLS = Object.entries(
  import.meta.glob('../assets/banners/*.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url as string);

// Recreation of the real "METRO SUPPLY CHAIN" banner hung on the F-row net.
function makeMetroBanner(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#eceae6';
  ctx.fillRect(0, 0, 512, 320);
  ctx.strokeStyle = '#d4d1cb';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 314);

  // Sphere mark: an orange and a dark-grey arc chasing each other.
  const mx = 104;
  const my = 152;
  const r = 56;
  ctx.lineCap = 'round';
  ctx.lineWidth = 24;
  ctx.strokeStyle = '#e8932c';
  ctx.beginPath();
  ctx.arc(mx, my, r, Math.PI * 0.55, Math.PI * 1.4);
  ctx.stroke();
  ctx.strokeStyle = '#4d4c4a';
  ctx.beginPath();
  ctx.arc(mx, my, r, Math.PI * 1.55, Math.PI * 0.4);
  ctx.stroke();
  ctx.lineCap = 'butt';

  ctx.fillStyle = '#3b3a38';
  ctx.font = '900 84px Arial, sans-serif';
  ctx.fillText('METRO', 186, 158);
  ctx.fillStyle = '#6b6862';
  ctx.font = '600 29px Arial, sans-serif';
  (ctx as any).letterSpacing = '6px';
  ctx.fillText('SUPPLY CHAIN', 190, 204);
  (ctx as any).letterSpacing = '0px';
  ctx.fillStyle = '#e8932c';
  ctx.fillRect(190, 222, 244, 10);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function makePlaceholderBanner(i: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f5f6f7';
  ctx.fillRect(0, 0, 512, 320);
  const hues = [210, 28, 160, 350, 90, 250];
  const h = hues[i % hues.length];
  const g = ctx.createLinearGradient(0, 16, 0, 304);
  g.addColorStop(0, `hsl(${h}, 22%, 62%)`);
  g.addColorStop(1, `hsl(${h}, 30%, 38%)`);
  ctx.fillStyle = g;
  ctx.fillRect(16, 16, 480, 288);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(120 + ((i * 53) % 200), 130, 70, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(280, 60 + ((i * 37) % 80), 170, 90);
  ctx.fillStyle = 'rgba(17,24,39,0.85)';
  ctx.fillRect(16, 244, 480, 60);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px Arial, sans-serif';
  ctx.fillText('FloWMS', 36, 287);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function makePlaceholderPlaque(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1c2940';
  ctx.fillRect(0, 0, 256, 160);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, 240, 144);
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(24, 30, 150, 16);
  ctx.fillRect(24, 64, 200, 8);
  ctx.fillRect(24, 84, 184, 8);
  ctx.fillRect(24, 104, 196, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// Anti-fall mesh netting on rack faces that are only partially backed by an
// opposing row — e.g. F's first row: aisle E's racks only start at bay 25, so
// bays 1–24 of F have an open back where boxes could fall to the floor area.
// Faces with no opposing row at all (walls, cross-aisles) stay un-netted.
export function buildSafetyNets(rows: RackRow[]): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'SAFETY_NETS';
  const disposables: { dispose(): void }[] = [];

  const GAP_MAX = 500;   // max flue gap that still counts as "backed"
  const MIN_RUN = 1000;  // ignore exposed slivers shorter than this
  const CELL = 80;       // mesh cell size (mm)

  const extentOf = (r: RackRow): [number, number] => {
    const last = r.bays[r.bays.length - 1];
    return [r.bays[0].coordinateX, last.coordinateX + last.dimensionX];
  };

  // Large photo banners along the top of the net plus a row of smaller dark
  // info plaques below, like the real signage hung on the F-row netting.
  const loader = new THREE.TextureLoader();
  function bannerTexture(i: number): THREE.Texture {
    if (BANNER_URLS.length > 0) {
      const tex = loader.load(BANNER_URLS[i % BANNER_URLS.length]);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return tex;
    }
    // Without image files: alternate the METRO banner with generic posters.
    return i % 2 === 0 ? makeMetroBanner() : makePlaceholderBanner(i);
  }
  function hangBanners(a: number, b: number, netZ: number, height: number, face: 0 | 1) {
    const w = b - a;
    const z = face === 0 ? netZ - 60 : netZ + 60;
    const rotY = face === 0 ? Math.PI : 0;
    const addPlane = (tex: THREE.Texture, cx: number, cy: number, pw: number, ph: number, zOff: number) => {
      const geom = new THREE.PlaneGeometry(pw, ph);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      disposables.push(geom, tex, mat);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(cx, cy, z + zOff);
      mesh.rotation.y = rotY;
      mesh.raycast = () => {};
      group.add(mesh);
    };
    const nBanners = Math.max(1, Math.floor(w / 7500));
    const step = w / nBanners;
    for (let i = 0; i < nBanners; i++) {
      addPlane(bannerTexture(i), a + step * (i + 0.5), height * 0.72, 5600, 3200, 0);
    }
    const nPlaques = Math.max(1, Math.floor(w / 10500));
    const stepP = w / nPlaques;
    for (let i = 0; i < nPlaques; i++) {
      addPlane(makePlaceholderPlaque(), a + stepP * (i + 0.5), height * 0.46, 2600, 1500, 0);
    }
  }

  function makeNetMaterial(w: number, h: number): THREE.MeshBasicMaterial {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    // Faint sheet fill so the net still reads as a translucent veil from a
    // distance, where the mipmapped wire lines alone would fade out.
    ctx.fillStyle = 'rgba(225, 228, 232, 0.14)';
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = 'rgba(238, 240, 243, 1)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(0, 3);
    ctx.lineTo(64, 3);
    ctx.moveTo(3, 0);
    ctx.lineTo(3, 64);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(w / CELL, h / CELL);
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    disposables.push(tex, mat);
    return mat;
  }

  for (const row of rows) {
    if (row.bays.length === 0) continue;
    const [x0, x1] = extentOf(row);
    // face 0 = back face at row.y, face 1 = front face at row.y + depth
    for (const face of [0, 1] as const) {
      const opposing: Array<[number, number]> = [];
      for (const other of rows) {
        if (other === row || other.bays.length === 0) continue;
        const gap = face === 0
          ? row.y - (other.y + other.depth)
          : other.y - (row.y + row.depth);
        if (gap >= -50 && gap <= GAP_MAX) opposing.push(extentOf(other));
      }
      if (opposing.length === 0) continue;
      // Net whatever part of this face the opposing rows don't cover.
      opposing.sort((a, b) => a[0] - b[0]);
      const exposed: Array<[number, number]> = [];
      let cursor = x0;
      for (const [a, b] of opposing) {
        if (a > cursor) exposed.push([cursor, Math.min(a, x1)]);
        cursor = Math.max(cursor, b);
        if (cursor >= x1) break;
      }
      if (cursor < x1) exposed.push([cursor, x1]);
      for (const [a, b] of exposed) {
        if (b - a < MIN_RUN) continue;
        const w = b - a;
        const geom = new THREE.PlaneGeometry(w, row.height);
        disposables.push(geom);
        const mesh = new THREE.Mesh(geom, makeNetMaterial(w, row.height));
        const z = face === 0 ? row.y - 40 : row.y + row.depth + 40;
        mesh.position.set((a + b) / 2, row.height / 2, z);
        mesh.raycast = () => {};
        group.add(mesh);
        // if (w >= 15000) hangBanners(a, b, z, row.height, face);
      }
    }
  }

  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
}

// Blue plates with the aisle letter, mounted on the rack ends on BOTH sides
// of the aisle (not floating in the corridor), facing the cross-aisle — like
// the photo signage.
export function buildAisleSigns(
  segments: Segment[],
  rows: RackRow[],
): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'AISLE_SIGNS';
  const disposables: { dispose(): void }[] = [];

  const geom = new THREE.PlaneGeometry(700, 500);
  disposables.push(geom);

  const materials = new Map<string, THREE.MeshBasicMaterial>();
  function materialFor(letter: string): THREE.MeshBasicMaterial {
    let mat = materials.get(letter);
    if (mat) return mat;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 192;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = RACK_COLORS.signBg;
    ctx.fillRect(0, 0, 256, 192);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 236, 172);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 130px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 128, 102);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    disposables.push(tex, mat);
    materials.set(letter, mat);
    return mat;
  }

  for (const aisle of segments) {
    if (aisle.type !== 'AISLE') continue;
    const letter = aisleLetterOf(aisle.fullName);
    const aisleRows = rows.filter((r) => r.aisle === letter);
    if (aisleRows.length === 0) continue;
    const mat = materialFor(letter);
    for (const r of aisleRows) {
      if (r.bays.length === 0) continue;
      const first = r.bays[0];
      const last = r.bays[r.bays.length - 1];
      const zC = r.y + r.depth / 2;
      const ends: Array<[number, number]> = [
        [first.coordinateX - 320, -Math.PI / 2],
        [last.coordinateX + last.dimensionX + 320, Math.PI / 2],
      ];
      for (const [x, rotY] of ends) {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(x, 4500, zC);
        mesh.rotation.y = rotY;
        mesh.raycast = () => {};
        group.add(mesh);
      }
    }
  }

  return {
    group,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
