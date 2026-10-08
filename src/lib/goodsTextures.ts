import * as THREE from 'three';
import { mulberry32 } from './rng';

// Canvas-generated textures for the demo stock (pallets + boxes), created once
// and cached. Each surface ships a colour map AND a matching normal map (derived
// from a height pass) so flat box/pallet faces pick up real relief under the
// scene lights — corrugation, tape ridges, plank seams, wrap wrinkles — without
// any extra geometry. Kept small (<=256); detail comes from the relief + repeat.

const cache = new Map<string, THREE.CanvasTexture>();

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function cached(key: string, build: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let t = cache.get(key);
  if (!t) {
    t = build();
    cache.set(key, t);
  }
  return t;
}

// Sobel a grayscale height canvas (red channel = height) into a tangent-space
// normal map. strength scales the bump depth. Wrapping is set by the caller.
export function heightToNormal(height: HTMLCanvasElement, strength = 2): THREE.CanvasTexture {
  const w = height.width;
  const h = height.height;
  const src = height.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [c, ctx] = makeCanvas(w, h);
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number) => {
    x = (x + w) % w;
    y = (y + h) % h;
    return src[(y * w + x) * 4];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = ((at(x + 1, y) - at(x - 1, y)) / 255) * strength;
      const dy = ((at(x, y + 1) - at(x, y - 1)) / 255) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  return t;
}

// ---- cardboard (kraft) -----------------------------------------------------
// Warm kraft box with paper mottle and a translucent packing-tape seam (the tape
// stands proud in the normal map so it catches the light). No printed shipping
// label here — the single real FloWMS label is placed on the load's front face by
// the goods builder, so a baked-in label would just repeat on every box face.
export function cardboardTexture(): THREE.CanvasTexture {
  return cached('cardboard', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(202);

    // Soft, light kraft — warm tan rather than dark saturated brown, which reads
    // better on a projector during a client demo.
    const grd = ctx.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#cbac80');
    grd.addColorStop(1, '#bd9b6c');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 256);

    // paper mottle
    for (let i = 0; i < 3400; i++) {
      const v = rnd();
      ctx.fillStyle = v > 0.5 ? 'rgba(255,238,205,0.05)' : 'rgba(80,55,25,0.06)';
      ctx.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 3, 1);
    }
    // soft edge darkening (boxes are scuffed at the rims)
    ctx.strokeStyle = 'rgba(70,48,22,0.22)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 250);

    // packing tape strip down the vertical seam
    ctx.fillStyle = 'rgba(208,186,142,0.6)';
    ctx.fillRect(112, 0, 32, 256);
    ctx.fillStyle = 'rgba(150,128,90,0.4)';
    ctx.fillRect(112, 0, 2, 256);
    ctx.fillRect(142, 0, 2, 256);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

export function cardboardNormal(): THREE.CanvasTexture {
  return cached('cardboard-n', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(212);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 256);
    // fine paper tooth
    for (let i = 0; i < 4000; i++) {
      const g = 110 + rnd() * 90;
      ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
      ctx.fillRect(rnd() * 256, rnd() * 256, 1, 1);
    }
    // raised tape seam
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(112, 0, 32, 256);
    ctx.fillStyle = '#cfcfcf';
    ctx.fillRect(112, 0, 3, 256);
    ctx.fillRect(141, 0, 3, 256);
    const t = heightToNormal(c, 2.2);
    t.anisotropy = 4;
    return t;
  });
}

// ---- printed carton (lighter, branded) -------------------------------------
// Used for the small-carton stacks so they read as retail/printed cartons next
// to the plain kraft loads — adds product variety on the shelves.
export function cartonTexture(): THREE.CanvasTexture {
  return cached('carton', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(505);
    ctx.fillStyle = '#e7e0d2';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2200; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(150,140,120,0.06)';
      ctx.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1);
    }
    // printed brand band + logo block
    ctx.fillStyle = '#2f7d76';
    ctx.fillRect(0, 96, 256, 40);
    ctx.fillStyle = '#e7e0d2';
    ctx.fillRect(20, 104, 26, 24);
    ctx.fillStyle = '#c9572f';
    ctx.fillRect(56, 108, 120, 16);
    // flap seam down the middle + thin product text rows
    ctx.fillStyle = 'rgba(120,110,90,0.35)';
    ctx.fillRect(127, 0, 2, 256);
    ctx.fillStyle = 'rgba(90,82,66,0.5)';
    for (let i = 0; i < 3; i++) ctx.fillRect(60, 156 + i * 10, 130 - i * 24, 3);
    // edge scuff
    ctx.strokeStyle = 'rgba(120,110,90,0.25)';
    ctx.lineWidth = 5;
    ctx.strokeRect(2, 2, 252, 252);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

export function cartonNormal(): THREE.CanvasTexture {
  return cached('carton-n', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(515);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 3000; i++) {
      const g = 120 + rnd() * 70;
      ctx.fillStyle = `rgba(${g},${g},${g},0.4)`;
      ctx.fillRect(rnd() * 256, rnd() * 256, 1, 1);
    }
    // central flap crease (groove)
    ctx.fillStyle = '#5a5a5a';
    ctx.fillRect(126, 0, 4, 256);
    const t = heightToNormal(c, 1.8);
    t.anisotropy = 4;
    return t;
  });
}

// ---- pallet wood -----------------------------------------------------------
// Weathered, slightly grey-tan softwood planks with grain, the odd knot and
// recessed seams between boards.
export function woodTexture(): THREE.CanvasTexture {
  return cached('wood', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(303);

    for (let y = 0; y < 256; y += 32) {
      // desaturated tan with per-plank weathering toward grey
      const base = 150 + Math.floor(rnd() * 34);
      const grey = rnd() * 0.35; // how weathered this board is
      const r = Math.round(base);
      const g = Math.round(base * (0.82 - grey * 0.12) + grey * 30);
      const b = Math.round(base * (0.62 - grey * 0.05) + grey * 40);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 256, 32);
      // grain streaks
      for (let i = 0; i < 30; i++) {
        ctx.fillStyle = `rgba(70,50,28,${0.05 + rnd() * 0.1})`;
        ctx.fillRect(rnd() * 256, y + rnd() * 30, 16 + rnd() * 70, 1);
      }
      // occasional knot
      if (rnd() > 0.7) {
        const kx = rnd() * 256;
        const ky = y + 8 + rnd() * 16;
        ctx.fillStyle = 'rgba(55,38,20,0.55)';
        ctx.beginPath();
        ctx.ellipse(kx, ky, 3 + rnd() * 3, 2 + rnd() * 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // dark seam between planks
      ctx.fillStyle = 'rgba(38,26,15,0.6)';
      ctx.fillRect(0, y, 256, 2);
    }

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  });
}

export function woodNormal(): THREE.CanvasTexture {
  return cached('wood-n', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(313);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 32) {
      // grain ridges
      for (let i = 0; i < 26; i++) {
        const g = 110 + rnd() * 80;
        ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
        ctx.fillRect(rnd() * 256, y + rnd() * 30, 14 + rnd() * 60, 1);
      }
      // recessed seam (dark = lower)
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(0, y, 256, 3);
    }
    const t = heightToNormal(c, 2.4);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  });
}

// ---- stretch wrap ----------------------------------------------------------
// Pale, cool, semi-glossy film. Vertical pull-streaks + diagonal creases in the
// normal map make it shimmer under the env map; the colour map hints at the
// boxes inside.
export function shrinkWrapTexture(): THREE.CanvasTexture {
  return cached('shrink', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(404);

    const grd = ctx.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#d6dde1');
    grd.addColorStop(1, '#c6cfd4');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 256);
    // boxes underneath, very faint
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = 'rgba(120,105,80,0.10)';
      ctx.fillRect(rnd() * 200, rnd() * 200, 40 + rnd() * 50, 40 + rnd() * 50);
    }
    // vertical sheen streaks
    for (let i = 0; i < 110; i++) {
      const x = rnd() * 256;
      ctx.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.18})`;
      ctx.fillRect(x, 0, 1 + rnd() * 3, 256);
    }

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

export function shrinkWrapNormal(): THREE.CanvasTexture {
  return cached('shrink-n', () => {
    const [c, ctx] = makeCanvas(256, 256);
    const rnd = mulberry32(414);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 256);
    // vertical wrinkles
    for (let i = 0; i < 60; i++) {
      const x = rnd() * 256;
      const g = 90 + rnd() * 110;
      ctx.fillStyle = `rgba(${g},${g},${g},0.5)`;
      ctx.fillRect(x, 0, 1 + rnd() * 2, 256);
    }
    // diagonal pull creases
    ctx.save();
    ctx.translate(128, 128);
    for (let i = 0; i < 14; i++) {
      ctx.rotate(rnd() * 0.5 - 0.25);
      const g = 120 + rnd() * 80;
      ctx.fillStyle = `rgba(${g},${g},${g},0.35)`;
      ctx.fillRect(-160, rnd() * 240 - 120, 320, 1 + rnd() * 2);
    }
    ctx.restore();
    const t = heightToNormal(c, 1.4);
    t.anisotropy = 4;
    return t;
  });
}

export function disposeGoodsTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
