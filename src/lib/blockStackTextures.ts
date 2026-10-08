import * as THREE from 'three';
import { mulberry32 } from './rng';
import { heightToNormal } from './goodsTextures';

// Canvas textures for the block-stack pallets: shrink-wrapped carton loads like
// the reference photo — a grid of cartons under clear film, every carton carrying
// a white label. The colour map is kept NEUTRAL (light grey cartons) so the
// per-pallet instance tint turns it into the stock class colour; the labels live
// in a separate emissive mask so they stay white whatever the tint (instance
// colour multiplies the diffuse only, never the emissive).

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

const SIZE = 256;
const COLS = 3;
const ROWS = 4;
const SEAM = 5;

interface Carton { x: number; y: number; w: number; h: number; lx: number; ly: number; lw: number; lh: number }

// Carton cells of the tile, each with the label rectangle it carries.
function cartons(): Carton[] {
  const out: Carton[] = [];
  const cw = SIZE / COLS;
  const ch = SIZE / ROWS;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * cw + SEAM / 2;
      const y = r * ch + SEAM / 2;
      const w = cw - SEAM;
      const h = ch - SEAM;
      const lw = w * 0.58;
      const lh = h * 0.42;
      out.push({ x, y, w, h, lx: x + (w - lw) / 2, ly: y + (h - lh) / 2, lw, lh });
    }
  }
  return out;
}

export function wrappedCartonTexture(): THREE.CanvasTexture {
  return cached('bs-carton', () => {
    const [c, ctx] = makeCanvas(SIZE, SIZE);
    const rnd = mulberry32(909);
    // the dark gaps between cartons show through the film
    ctx.fillStyle = '#4f5559';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (const k of cartons()) {
      const g = ctx.createLinearGradient(0, k.y, 0, k.y + k.h);
      g.addColorStop(0, '#e1e5e8');
      g.addColorStop(1, '#c8cdd1');
      ctx.fillStyle = g;
      ctx.fillRect(k.x, k.y, k.w, k.h);
      // board mottle
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(60,65,70,0.06)';
        ctx.fillRect(k.x + rnd() * k.w, k.y + rnd() * k.h, 1 + rnd() * 2, 1);
      }
      // white label: barcode band on top, two text lines under it
      ctx.fillStyle = '#f8f9fa';
      ctx.fillRect(k.lx, k.ly, k.lw, k.lh);
      ctx.fillStyle = '#1f2327';
      const by = k.ly + k.lh * 0.14;
      const bh = k.lh * 0.3;
      let bx = k.lx + k.lw * 0.1;
      while (bx < k.lx + k.lw * 0.9) {
        const bw = 1 + Math.floor(rnd() * 2);
        ctx.fillRect(bx, by, bw, bh);
        bx += bw + 1 + Math.floor(rnd() * 2);
      }
      ctx.fillStyle = '#5b6168';
      ctx.fillRect(k.lx + k.lw * 0.1, k.ly + k.lh * 0.56, k.lw * 0.8, Math.max(1, k.lh * 0.07));
      ctx.fillRect(k.lx + k.lw * 0.1, k.ly + k.lh * 0.72, k.lw * 0.55, Math.max(1, k.lh * 0.07));
    }
    // stretch film: vertical sheen streaks and a few soft diagonal highlights
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.04 + rnd() * 0.14})`;
      ctx.fillRect(rnd() * SIZE, 0, 1 + rnd() * 2, SIZE);
    }
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate(-0.35);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.08})`;
      ctx.fillRect(-SIZE, rnd() * SIZE - SIZE / 2, SIZE * 2, 2 + rnd() * 6);
    }
    ctx.restore();

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

// White where the labels are, black elsewhere — used as the emissive map so the
// labels read white on any tint.
export function wrappedCartonLabelMask(): THREE.CanvasTexture {
  return cached('bs-carton-mask', () => {
    const [c, ctx] = makeCanvas(SIZE, SIZE);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#ffffff';
    for (const k of cartons()) ctx.fillRect(k.lx + 1, k.ly + 1, k.lw - 2, k.lh - 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

export function wrappedCartonNormal(): THREE.CanvasTexture {
  return cached('bs-carton-n', () => {
    const [c, ctx] = makeCanvas(SIZE, SIZE);
    const rnd = mulberry32(919);
    // seams recessed, cartons raised, labels a touch higher still
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (const k of cartons()) {
      ctx.fillStyle = '#8c8c8c';
      ctx.fillRect(k.x, k.y, k.w, k.h);
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(k.lx, k.ly, k.lw, k.lh);
    }
    // film wrinkles pulled vertically
    for (let i = 0; i < 50; i++) {
      const g = 100 + rnd() * 100;
      ctx.fillStyle = `rgba(${g},${g},${g},0.45)`;
      ctx.fillRect(rnd() * SIZE, 0, 1 + rnd() * 2, SIZE);
    }
    const t = heightToNormal(c, 1.8);
    t.anisotropy = 4;
    return t;
  });
}

// Floor stencil: transparent tile with the text in white paint.
export function stencilTexture(text: string, w: number, h: number): THREE.CanvasTexture {
  return cached(`bs-stencil:${text}:${w}x${h}`, () => {
    const [c, ctx] = makeCanvas(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f1f3f5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Shrink the font until the text fits the tile width with a small margin.
    let px = Math.floor(h * 0.82);
    for (; px > 8; px -= 2) {
      ctx.font = `900 ${px}px Arial, Helvetica, sans-serif`;
      if (ctx.measureText(text).width <= w * 0.92) break;
    }
    ctx.fillText(text, w / 2, h / 2 + px * 0.04);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

// Tag colours per quantity type: amber for the booking, green for free stock, the
// rest muted so they read as information, not alarm.
const TAG_STYLE: Record<string, { bg: string; edge: string; fg: string }> = {
  ALLOCATED: { bg: '#f59e0b', edge: '#92400e', fg: '#1c1200' },
  AVAILABLE: { bg: '#059669', edge: '#064e3b', fg: '#f0fdf4' },
  HELD:      { bg: '#dc2626', edge: '#7f1d1d', fg: '#fff1f2' },
  PICKED:    { bg: '#0284c7', edge: '#0c4a6e', fg: '#f0f9ff' },
  RECEIPTED: { bg: '#64748b', edge: '#334155', fg: '#f8fafc' },
  PICKING:   { bg: '#0369a1', edge: '#082f49', fg: '#e0f2fe' },
  'IN TRANSIT': { bg: '#6d28d9', edge: '#3b0764', fg: '#f5f3ff' },
};
const TAG_DEFAULT = { bg: '#7c3aed', edge: '#4c1d95', fg: '#f5f3ff' };

// A status tag stuck on the face of a pallet: the quantity type and, in DB mode, the
// quantity behind it — "ALLOCATED", "AVAILABLE 100 UNIT". One texture per distinct text.
export function statusTagTexture(text: string, kind: string): THREE.CanvasTexture {
  return cached(`bs-tag|${kind}|${text}`, () => {
    const style = TAG_STYLE[kind] ?? TAG_DEFAULT;
    const W = 512;
    const H = 192; // same 8:3 aspect as the 640 × 240 mm tag on the pallet
    const [c, ctx] = makeCanvas(W, H);
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, W - 14, H - 14);
    ctx.fillStyle = style.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Shrink the font until the whole text sits inside the border with a margin.
    let px = 120;
    for (; px > 20; px -= 2) {
      ctx.font = `900 ${px}px Arial, Helvetica, sans-serif`;
      if (ctx.measureText(text).width <= W * 0.84) break;
    }
    ctx.fillText(text, W / 2, H / 2 + px * 0.05);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

// Amber "ALLOCATED" tag stuck on the face of a pallet an order has booked.
export function allocatedTagTexture(): THREE.CanvasTexture {
  return statusTagTexture('ALLOCATED', 'ALLOCATED');
}

export function disposeBlockStackTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
