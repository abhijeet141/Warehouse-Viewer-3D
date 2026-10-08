import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Segment } from '../types';
import { BS, podHSL, loadHeight, type LanePod, type LaneStock } from '../data/blockStack';
import { seededRng } from './rng';
import { makePalletGeometry } from './goodsBuilder';
import { renderBrandedLabel } from './podLabel';
import {
  wrappedCartonTexture, wrappedCartonLabelMask, wrappedCartonNormal, stencilTexture, statusTagTexture,
} from './blockStackTextures';

// Block-stack floor storage: the painted lane markings on the slab (always on,
// part of the realistic layer) and the pallets standing in the lanes (toggled
// with the demo stock). Everything is instanced. three.js axes as elsewhere:
// x ← coordinateX, y(up) ← coordinateZ, z ← coordinateY.

export interface PodBox {
  x0: number; x1: number; // data X
  y0: number; y1: number; // data Y (depth)
  z0: number; z1: number; // data Z (height)
}

// Where a pallet stands in its lane, in data mm. Lanes fill from the BACK toward
// the face, each position stacked to the top before the next is started, so
// column 0 is the deepest position. The base height (pod.z0) is cumulative — the
// top of the pallet beneath — so stacks stay seated even over a part-picked load.
export function podBounds(pod: LanePod, lane: Segment): PodBox {
  const cfg = lane.lane!;
  const cx = lane.coordinateX + lane.dimensionX / 2;
  const cy = cfg.faceDir > 0
    ? lane.coordinateY + BS.BACK_CLEAR + pod.column * BS.COL_PITCH + BS.POD_D / 2
    : lane.coordinateY + lane.dimensionY - BS.BACK_CLEAR - pod.column * BS.COL_PITCH - BS.POD_D / 2;
  const z0 = pod.z0;
  return {
    x0: cx - BS.POD_W / 2, x1: cx + BS.POD_W / 2,
    y0: cy - BS.POD_D / 2, y1: cy + BS.POD_D / 2,
    z0, z1: z0 + BS.PALLET_H + loadHeight(pod),
  };
}

// Unit wrapped load: footprint x/z in [-0.5, 0.5], height y in [0, 1], with a slim
// film "cap" that pulls the top corners in.
export function makeLoadGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.985, 0.97, 0.985);
  body.translate(0, 0.485, 0);
  const cap = new THREE.BoxGeometry(0.9, 0.04, 0.9);
  cap.translate(0, 0.99, 0);
  const merged = mergeGeometries([body, cap]);
  body.dispose();
  cap.dispose();
  return merged;
}

// Wrapped carton loads: neutral texture tinted per pallet; labels glow white via
// the emissive mask whatever the tint.
export function makeLoadMaterial(env: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: wrappedCartonTexture(),
    normalMap: wrappedCartonNormal(),
    emissiveMap: wrappedCartonLabelMask(),
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.55,
    roughness: 0.32, metalness: 0, envMap: env, envMapIntensity: 0.9,
  });
  m.normalScale.set(0.6, 0.6);
  return m;
}

export const PLASTIC_PALLET_COLOR = 0x2a55a8; // blue plastic pallets, like the photo

// The branded FloWMS label is rendered by Labelary once per page and shared by
// every (re)build — a pick or putaway rebuilds the stock meshes, and re-posting the
// label each time would trip Labelary's rate limit.
let brandedLabel: Promise<THREE.Texture> | null = null;
function brandedLabelTexture(): Promise<THREE.Texture> {
  if (!brandedLabel) {
    brandedLabel = renderBrandedLabel().then(
      (url) => new Promise<THREE.Texture>((resolve, reject) => {
        new THREE.TextureLoader().load(url, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          resolve(tex);
        }, undefined, reject);
      }),
    );
    brandedLabel.catch(() => { brandedLabel = null; }); // let a later build retry
  }
  return brandedLabel;
}

const LABEL_ASPECT = 2.5 / 1.5; // branded label width:height
const TAG_W = 640;               // ALLOCATED tag on the load's face
const TAG_H = 240;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export interface BlockStackStock {
  group: THREE.Group;
  podMesh: THREE.InstancedMesh; // raycast target: instanceId → pods[instanceId]
  pods: LanePod[];
  hidePod(index: number): void; // collapse a pallet's instances (it has left on the forks)
  dispose: () => void;
}

// worldScale mirrors the non-uniform scale on the parent worldGroup ({ y: vScale,
// z: hScale }); instances are composed in world space and pre-multiplied by the
// inverse so the slight per-pallet yaw doesn't shear (same trick as goodsBuilder).
export function buildBlockStackStock(
  lanes: Segment[],
  stock: Map<string, LaneStock>,
  worldScale: { y: number; z: number } = { y: 1, z: 1 },
  env: THREE.Texture | null = null,
): BlockStackStock {
  const group = new THREE.Group();
  group.name = 'BLOCK_STACK_STOCK';

  const pods: LanePod[] = [];
  const laneOf: Segment[] = [];
  for (const lane of lanes) {
    const s = stock.get(lane.fullName);
    if (!s) continue;
    for (const p of s.pods) {
      pods.push(p);
      laneOf.push(lane);
    }
  }
  const n = pods.length;

  const palletGeom = makePalletGeometry();
  const palletMat = new THREE.MeshStandardMaterial({
    color: PLASTIC_PALLET_COLOR, roughness: 0.5, metalness: 0.05, envMap: env, envMapIntensity: 0.4,
  });
  const palletMesh = new THREE.InstancedMesh(palletGeom, palletMat, Math.max(1, n));
  palletMesh.count = n;
  palletMesh.frustumCulled = false;
  palletMesh.raycast = () => {}; // the load above is the click target
  palletMesh.name = 'BLOCK_PALLETS';

  const loadGeom = makeLoadGeometry();
  const loadMat = makeLoadMaterial(env);
  const podMesh = new THREE.InstancedMesh(loadGeom, loadMat, Math.max(1, n));
  podMesh.count = n;
  podMesh.frustumCulled = false;
  podMesh.name = 'BLOCK_PODS';

  // One FloWMS pod label per pallet on its aisle-facing side (shared texture), and
  // an amber ALLOCATED tag above it on the pallets an order has booked.
  const labelGeom = new THREE.PlaneGeometry(1, 1);
  const labelMat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const labelMesh = new THREE.InstancedMesh(labelGeom, labelMat, Math.max(1, n));
  labelMesh.count = n;
  labelMesh.frustumCulled = false;
  labelMesh.raycast = () => {};
  labelMesh.name = 'BLOCK_LABELS';
  labelMesh.visible = false; // shown once the shared texture is in

  // Status tags on the load faces: a booked pallet carries an ALLOCATED tag. One
  // instanced mesh per distinct text, collected while the pallets are placed.
  const tagsOf = (p: LanePod): { text: string; kind: string }[] => (p.allocation ? [{ text: 'ALLOCATED', kind: 'ALLOCATED' }] : []);
  interface TagGroup { kind: string; items: { pod: number; matrix: THREE.Matrix4 }[] }
  const tagGroups = new Map<string, TagGroup>();
  const tagRefs = new Map<number, { text: string; slot: number }[]>(); // pod index → its tag instances

  const { y: vS, z: hS } = worldScale;
  const invParent = new THREE.Matrix4().makeScale(1, 1 / vS, 1 / hS);
  const UP = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();
  const labelQuat = new THREE.Quaternion();
  const posV = new THREE.Vector3();
  const sclV = new THREE.Vector3();
  const worldMat = new THREE.Matrix4();
  const outMat = new THREE.Matrix4();
  const color = new THREE.Color();

  for (let i = 0; i < n; i++) {
    const pod = pods[i];
    const lane = laneOf[i];
    const cfg = lane.lane!;
    const b = podBounds(pod, lane);
    const r = seededRng('bspod:' + pod.code);
    const jx = (r() - 0.5) * 40;           // forklift placement isn't perfect
    const jz = (r() - 0.5) * 30;
    const rotY = ((r() - 0.5) * 3 * Math.PI) / 180;
    const cx = (b.x0 + b.x1) / 2 + jx;
    const cz = (b.y0 + b.y1) / 2 + jz;
    quat.setFromAxisAngle(UP, rotY);

    // pallet: geometry is 1200 × 144 × 1000 with its base at y = 0
    posV.set(cx, b.z0 * vS, cz * hS);
    sclV.set(1, vS, hS);
    worldMat.compose(posV, quat, sclV);
    outMat.multiplyMatrices(invParent, worldMat);
    palletMesh.setMatrixAt(i, outMat);

    // load on the pallet
    const lh = loadHeight(pod);
    posV.set(cx, (b.z0 + BS.PALLET_H) * vS, cz * hS);
    sclV.set(BS.POD_W, lh * vS, BS.POD_D * hS);
    worldMat.compose(posV, quat, sclV);
    outMat.multiplyMatrices(invParent, worldMat);
    podMesh.setMatrixAt(i, outMat);
    const hsl = podHSL(pod);
    podMesh.setColorAt(i, color.setHSL(hsl.h, hsl.s, hsl.l));

    // Face-side signage, always inside the load's face: the FloWMS label in the
    // lower band and, on a booked pallet, the ALLOCATED tag in the top band. Short
    // (part-picked) loads shrink both so nothing hangs above the film.
    const dirZ = cfg.faceDir;
    const GAP = 20;
    let lhh = Math.min(520 / LABEL_ASPECT, lh * 0.42);
    const tags = tagsOf(pod);
    let th = tags.length ? Math.min(TAG_H, lh * 0.3) : 0;
    const need = lhh + th * tags.length + GAP * (tags.length + 2);
    if (need > lh) { const k = (lh / need) * 0.95; lhh *= k; th *= k; }
    const lw = lhh * LABEL_ASPECT;
    const labelY = tags.length
      ? b.z0 + BS.PALLET_H + GAP + lhh / 2
      : b.z0 + BS.PALLET_H + Math.max(lhh / 2 + GAP, Math.min(lh - lhh / 2 - GAP, lh * 0.4));
    const off = (BS.POD_D * 0.985) / 2 + 5;
    const nx = dirZ * Math.sin(rotY);
    const nz = dirZ * Math.cos(rotY);
    labelQuat.setFromAxisAngle(UP, rotY + (dirZ < 0 ? Math.PI : 0));
    posV.set(cx + nx * off, labelY * vS, (cz + nz * off) * hS);
    sclV.set(lw, lhh * vS, 1);
    worldMat.compose(posV, labelQuat, sclV);
    outMat.multiplyMatrices(invParent, worldMat);
    labelMesh.setMatrixAt(i, outMat);

    // Tags stack down from the top of the load, the first one on top.
    tags.forEach((tag, k) => {
      const tw = th * (TAG_W / TAG_H);
      const tagY = b.z0 + BS.PALLET_H + lh - GAP - th / 2 - k * (th + GAP);
      posV.set(cx + nx * (off + 2), tagY * vS, (cz + nz * (off + 2)) * hS);
      sclV.set(tw, th * vS, 1);
      worldMat.compose(posV, labelQuat, sclV);
      const g = tagGroups.get(tag.text) ?? tagGroups.set(tag.text, { kind: tag.kind, items: [] }).get(tag.text)!;
      g.items.push({ pod: i, matrix: new THREE.Matrix4().multiplyMatrices(invParent, worldMat) });
      (tagRefs.get(i) ?? tagRefs.set(i, []).get(i)!).push({ text: tag.text, slot: g.items.length - 1 });
    });
  }

  palletMesh.instanceMatrix.needsUpdate = true;
  podMesh.instanceMatrix.needsUpdate = true;
  if (podMesh.instanceColor) podMesh.instanceColor.needsUpdate = true;
  labelMesh.instanceMatrix.needsUpdate = true;
  podMesh.computeBoundingSphere();
  group.add(palletMesh, podMesh, labelMesh);

  const tagMeshes = new Map<string, THREE.InstancedMesh>();
  const tagMats: THREE.Material[] = [];
  for (const [text, g] of tagGroups) {
    const mat = new THREE.MeshBasicMaterial({
      map: statusTagTexture(text, g.kind), side: THREE.DoubleSide, transparent: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.InstancedMesh(labelGeom, mat, g.items.length);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.name = `BLOCK_TAG_${g.kind}`;
    g.items.forEach((it, k) => mesh.setMatrixAt(k, it.matrix));
    mesh.instanceMatrix.needsUpdate = true;
    tagMeshes.set(text, mesh);
    tagMats.push(mat);
    group.add(mesh);
  }

  let disposed = false;
  brandedLabelTexture()
    .then((tex) => {
      if (disposed) return;
      labelMat.map = tex;
      labelMat.needsUpdate = true;
      labelMesh.visible = true;
    })
    .catch(() => { /* labels stay hidden if Labelary is unreachable */ });

  return {
    group,
    podMesh,
    pods,
    hidePod(index: number) {
      if (index < 0 || index >= n) return;
      palletMesh.setMatrixAt(index, ZERO);
      podMesh.setMatrixAt(index, ZERO);
      labelMesh.setMatrixAt(index, ZERO);
      palletMesh.instanceMatrix.needsUpdate = true;
      podMesh.instanceMatrix.needsUpdate = true;
      labelMesh.instanceMatrix.needsUpdate = true;
      for (const ref of tagRefs.get(index) ?? []) {
        const m = tagMeshes.get(ref.text);
        if (m) { m.setMatrixAt(ref.slot, ZERO); m.instanceMatrix.needsUpdate = true; }
      }
    },
    dispose() {
      disposed = true;
      palletGeom.dispose();
      palletMesh.dispose();
      palletMat.dispose();
      loadGeom.dispose();
      podMesh.dispose();
      loadMat.dispose();
      labelGeom.dispose();
      labelMesh.dispose();
      labelMat.dispose(); // the shared label texture itself lives for the page
      for (const m of tagMeshes.values()) m.dispose();
      for (const m of tagMats) m.dispose(); // the tag textures themselves live for the page
    },
  };
}

// A single pallet + load to ride on the forklift's carriage: sized like the
// instanced ones (depth stretched by hS to match the lane pallets when the truck
// faces a lane), depth along the forks (+X), width across them.
export function makeCarriedPallet(
  pod: LanePod,
  hS: number,
  env: THREE.Texture | null,
): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'CARRIED_PALLET';
  const palletGeom = makePalletGeometry();
  const palletMat = new THREE.MeshStandardMaterial({ color: PLASTIC_PALLET_COLOR, roughness: 0.5, metalness: 0.05, envMap: env, envMapIntensity: 0.4 });
  const pallet = new THREE.Mesh(palletGeom, palletMat);
  pallet.scale.set(1, 1, hS);
  pallet.rotation.y = Math.PI / 2; // 1000-deep side along the forks
  pallet.position.set(575, 45, 0);  // on the fork tops, centred along their length
  pallet.raycast = () => {};
  group.add(pallet);

  const loadGeom = makeLoadGeometry();
  const loadMat = makeLoadMaterial(env);
  const hsl = podHSL(pod);
  loadMat.color.setHSL(hsl.h, hsl.s, hsl.l);
  const lh = loadHeight(pod);
  const load = new THREE.Mesh(loadGeom, loadMat);
  load.scale.set(BS.POD_D * hS, lh, BS.POD_W);
  load.position.set(575, 45 + BS.PALLET_H, 0);
  load.raycast = () => {};
  group.add(load);

  return {
    group,
    dispose() {
      palletGeom.dispose();
      palletMat.dispose();
      loadGeom.dispose();
      loadMat.dispose();
    },
  };
}

// Painted floor: a white outline round every lane, the lane number stencilled on
// the slab just outside its face, and the zone code in big letters along the
// drive-aisle edge — the way the reference photo marks its blocks.
export function buildBlockStackMarkings(
  blocks: Segment[],
  lanes: Segment[],
  worldScale: { y: number; z: number } = { y: 1, z: 1 },
): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.name = 'BLOCK_STACK_MARKINGS';
  const disposables: { dispose(): void }[] = [];
  const { z: hS } = worldScale;

  const LINE_W = 80;
  const LINE_H = 4;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const paint = new THREE.MeshBasicMaterial({ color: 0xeef1f3 });
  disposables.push(unitBox, paint);
  const lines = new THREE.InstancedMesh(unitBox, paint, lanes.length * 4);
  lines.name = 'BLOCK_LANE_LINES';
  lines.raycast = () => {};
  const dummy = new THREE.Object3D();
  let li = 0;
  const setBox = (x: number, z: number, sx: number, sz: number) => {
    dummy.position.set(x, LINE_H / 2 + 1, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(sx, LINE_H, sz);
    dummy.updateMatrix();
    lines.setMatrixAt(li++, dummy.matrix);
  };
  for (const l of lanes) {
    const x0 = l.coordinateX;
    const x1 = l.coordinateX + l.dimensionX;
    const y0 = l.coordinateY;
    const y1 = l.coordinateY + l.dimensionY;
    // Lines running along X are thin in Z: undo the depth stretch so all four
    // edges paint the same 80 mm.
    setBox((x0 + x1) / 2, y0, x1 - x0 + LINE_W, LINE_W / hS);
    setBox((x0 + x1) / 2, y1, x1 - x0 + LINE_W, LINE_W / hS);
    setBox(x0, (y0 + y1) / 2, LINE_W, y1 - y0);
    setBox(x1, (y0 + y1) / 2, LINE_W, y1 - y0);
  }
  lines.instanceMatrix.needsUpdate = true;
  lines.computeBoundingSphere();
  group.add(lines);

  // Stencils lie flat and are read from the drive aisle (texture top away from the
  // reader). Lane numbers repeat across zones, so every distinct text becomes ONE
  // instanced mesh — a few dozen draw calls for hundreds of lanes, not one each.
  interface StencilGroup { w: number; h: number; items: { cx: number; cy: number; faceDir: 1 | -1 }[] }
  const stencils = new Map<string, StencilGroup>();
  const addStencil = (text: string, cx: number, cy: number, w: number, h: number, faceDir: 1 | -1) => {
    const key = `${text}|${w}x${h}`;
    const g = stencils.get(key) ?? stencils.set(key, { w, h, items: [] }).get(key)!;
    g.items.push({ cx, cy, faceDir });
  };
  for (const l of lanes) {
    const cfg = l.lane;
    if (!cfg) continue;
    const faceY = cfg.faceDir > 0 ? l.coordinateY + l.dimensionY : l.coordinateY;
    addStencil(l.fullName.slice(-2), l.coordinateX + l.dimensionX / 2, faceY + cfg.faceDir * 300, 700, 420, cfg.faceDir);
  }
  for (const b of blocks) {
    const first = lanes.find((l) => l.lane?.block === b.fullName);
    const faceDir = first?.lane?.faceDir ?? 1;
    const faceY = faceDir > 0 ? b.coordinateY + b.dimensionY : b.coordinateY;
    addStencil(b.fullName, b.coordinateX + b.dimensionX / 2, faceY + faceDir * 1250, 3400, 1000, faceDir);
  }
  for (const [key, g] of stencils) {
    const text = key.slice(0, key.indexOf('|'));
    const geom = new THREE.PlaneGeometry(g.w, g.h / hS); // world height h after the depth stretch
    geom.rotateX(-Math.PI / 2);
    const tex = stencilTexture(text, 512, Math.max(64, Math.round((512 * g.h) / g.w)));
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    disposables.push(geom, mat);
    const inst = new THREE.InstancedMesh(geom, mat, g.items.length);
    inst.name = `BLOCK_STENCIL_${text}`;
    inst.renderOrder = 3;
    inst.raycast = () => {};
    inst.frustumCulled = false;
    g.items.forEach((it, i) => {
      dummy.position.set(it.cx, 10, it.cy);
      dummy.rotation.set(0, it.faceDir > 0 ? 0 : Math.PI, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
}
