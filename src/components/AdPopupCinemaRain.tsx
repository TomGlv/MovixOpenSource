/**
 * Particules adaptées de P-Stream / Lightbar.tsx, sous AGPL-3.0.
 * Source, licence et adaptations : @/assets/pstream-lightbar/CREDITS.md.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLightMode } from '@/context/LightModeContext';
import { createCinemaMotifSequence } from "@/data/cinemaMotifs";
import type { CinemaMotif } from "@/types/cinemaMotifs";
import { fitCanvasBitmapSize, isCanvasInvalidStateError } from '@/utils/canvasSizing';

interface LightbarOptions {
  motif?: CinemaMotif;
  sizeRange?: readonly [number, number];
  depth?: number;
}

interface ReadableRegion {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const DEPTH_PLANES = [
  { scale: 0.76, speed: 0.72, opacity: 0.3, blur: 1.4, iconBoost: 1 },
  { scale: 1, speed: 1, opacity: 0.46, blur: 0.55, iconBoost: 1.2 },
  { scale: 1.1, speed: 1.12, opacity: 0.6, blur: 0, iconBoost: 1.25 },
] as const;
const TEXT_REGION_OPACITY = 0.14;
const POINT_OPACITY_SCALE = 0.8;
const imageCache = new Map<string, HTMLImageElement>();
const spriteCache = new Map<string, Map<number, HTMLCanvasElement>>();
const beamCache = new Map<string, HTMLCanvasElement>();

const loadImage = (url: string) => {
  let image = imageCache.get(url);
  if (!image) {
    image = new Image();
    image.decoding = 'async';
    image.src = url;
    imageCache.set(url, image);
  }
  return image;
};

// HTMLImageElement.decode manque avant Chrome 64 (WebView et TV anciennes,
// GlitchTip DK) : attendre alors le chargement classique de l'image.
const decodeImage = (image: HTMLImageElement): Promise<void> => {
  if (typeof image.decode === 'function') return image.decode();
  if (image.complete) {
    return image.naturalWidth > 0 ? Promise.resolve() : Promise.reject(new Error('Image indisponible'));
  }
  return new Promise((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => reject(new Error('Image indisponible')), { once: true });
  });
};

const prepareBeamSprite = (url: string, image: HTMLImageElement) => {
  if (!image.complete || !image.naturalWidth) return null;
  const cached = beamCache.get(url);
  if (cached) return cached;
  const sprite = document.createElement("canvas");
  sprite.width = 512;
  sprite.height = 256;
  sprite.dataset.cinemaBeam = 'true';
  const context = sprite.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, 512, 256);
  beamCache.set(url, sprite);
  return sprite;
};

// Tous les plans sont rastérisés une fois, y compris le plan net : aucun SVG
// n'est redessiné pendant l'animation. La résolution couvre aussi les écrans 2x.
const prepareSprite = (url: string, image: HTMLImageElement, depth: number) => {
  let planes = spriteCache.get(url);
  if (!planes) {
    planes = new Map();
    spriteCache.set(url, planes);
  }
  const cached = planes.get(depth);
  if (cached) return cached;
  const sprite = document.createElement("canvas");
  sprite.width = 128;
  sprite.height = 128;
  sprite.dataset.cinemaMotif = image.dataset.cinemaMotif;
  const context = sprite.getContext("2d");
  if (!context) return null;
  context.filter = `blur(${DEPTH_PLANES[depth].blur * 2}px)`;
  context.drawImage(image, 16, 16, 96, 96);
  planes.set(depth, sprite);
  return sprite;
};

const readabilityAt = (x: number, y: number, regions: ReadableRegion[], radius = 0) => {
  let opacity = 1;
  for (const region of regions) {
    const dx = Math.max(region.left - x, 0, x - region.right);
    const dy = Math.max(region.top - y, 0, y - region.bottom);
    const distance = Math.min(1, Math.max(0, Math.hypot(dx, dy) - radius) / 32);
    const falloff = distance * distance * (3 - 2 * distance);
    opacity = Math.min(opacity, TEXT_REGION_OPACITY + (1 - TEXT_REGION_OPACITY) * falloff);
  }
  return opacity;
};

class Particle {
  x = 0;

  y = 0;

  radius = 0;

  direction = 0;

  speed = 0;

  lifetime = 0;

  ran = 0;

  size = 10;

  options: LightbarOptions;

  pixelRatio: number;

  constructor(
    canvas: HTMLCanvasElement,
    options: LightbarOptions = {
      sizeRange: [10, 15],
    },
    pixelRatio = 1,
  ) {
    this.options = options;
    this.pixelRatio = pixelRatio;

    this.reset(canvas);
    this.initialize(canvas);
  }

  reset(canvas: HTMLCanvasElement) {
    const width = canvas.width / this.pixelRatio;
    this.x = Math.round((Math.random() * width) / 2 + width / 4);
    this.y = Math.random() * 100 + 5;

    this.radius = 1 + Math.floor(Math.random() * 0.5);
    this.direction = (Math.random() * Math.PI) / 2 + Math.PI / 4;
    const depth = DEPTH_PLANES[this.options.depth ?? 1];
    this.speed = (0.02 + Math.random() * 0.085) * depth.speed;

    const second = 65;
    this.lifetime = second * 3 + Math.random() * (second * 30);

    this.size = this.options.sizeRange
      ? Math.random() *
          (this.options.sizeRange[1] - this.options.sizeRange[0]) +
        this.options.sizeRange[0]
      : 10;
    this.size *= depth.scale;

    this.ran = 0;
  }

  initialize(canvas: HTMLCanvasElement) {
    this.ran = Math.random() * this.lifetime;
    const baseSpeed = this.speed;
    this.speed = Math.random() * this.lifetime * baseSpeed;
    this.update(canvas);
    this.speed = baseSpeed;
  }

  rotation() {
    return this.direction - Math.PI + (this.options.motif?.projection ? Math.PI / 2 : 0);
  }

  visualCenter() {
    const offset = this.options.motif ? this.size * 1.5 : 0;
    return { x: this.x - Math.sin(this.rotation()) * offset, y: this.y + Math.cos(this.rotation()) * offset };
  }

  /** Espacement à la naissance seulement : aucune répulsion ni secousse pendant la chute. */
  avoidOverlap(canvas: HTMLCanvasElement, particles: readonly Particle[], prefilled: boolean) {
    if (!this.options.motif) return;
    const neighbors = particles.filter(particle => particle !== this && particle.options.motif);
    if (neighbors.length === 0) return;
    const velocityX = this.speed * Math.cos(this.direction);
    const velocityY = this.speed * Math.sin(this.direction);
    const clearance = () => {
      const center = this.visualCenter();
      let nearest = Infinity;
      for (const other of neighbors) {
        const target = other.visualCenter();
        const dx = center.x - target.x, dy = center.y - target.y;
        const vx = velocityX - other.speed * Math.cos(other.direction);
        const vy = velocityY - other.speed * Math.sin(other.direction);
        // Anticipe le rapprochement pendant les quatre prochaines secondes,
        // ou jusqu'à la disparition de l'une des deux silhouettes.
        const horizon = Math.max(0, Math.min(240, this.lifetime - this.ran, other.lifetime - other.ran));
        const speedSquared = vx * vx + vy * vy;
        const time = speedSquared > 0 ? Math.max(0, Math.min(horizon, -(dx * vx + dy * vy) / speedSquared)) : 0;
        nearest = Math.min(nearest, Math.hypot(dx + vx * time, dy + vy * time) - (this.size + other.size) * 0.6 - 4);
      }
      return nearest;
    };
    let best = { x: this.x, y: this.y, clearance: clearance() };
    const width = canvas.width / this.pixelRatio;
    for (let attempt = 0; attempt < 16 && best.clearance < 0; attempt += 1) {
      const center = this.visualCenter();
      this.x += width / 4 + Math.random() * width / 2 - center.x;
      this.y += Math.random() * (prefilled ? 180 : 100) - center.y;
      const score = clearance();
      if (score > best.clearance) best = { x: this.x, y: this.y, clearance: score };
    }
    this.x = best.x;
    this.y = best.y;
  }

  update(canvas: HTMLCanvasElement, delta = 1, particles: readonly Particle[] = []) {
    this.ran += delta;

    const addX = this.speed * Math.cos(this.direction);
    const addY = this.speed * Math.sin(this.direction);
    this.x += addX * delta;
    this.y += addY * delta;

    if (this.ran > this.lifetime) {
      this.reset(canvas);
      this.avoidOverlap(canvas, particles, false);
    }
  }

  render(canvas: HTMLCanvasElement, regions: ReadableRegion[]) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const motif = this.options.motif;
    const depthIndex = this.options.depth ?? 1;
    const sprite = motif ? spriteCache.get(motif.image)?.get(depthIndex) : null;
    // La préparation progressive ne bloque ni les points lumineux ni la popup.
    if (motif && !sprite) return;

    ctx.save();
    ctx.beginPath();

    const x = this.ran / this.lifetime;
    const o = (x - x * x) * 4;
    const depth = DEPTH_PLANES[depthIndex];
    // P-Stream dessine l'image sous son origine, puis la fait tourner : le
    // masque suit sa surface visible, pas seulement ce point d'ancrage.
    // Un projecteur reste proche de l'horizontale : sa lentille et son cône
    // sont reconnaissables, tout en suivant le même mouvement de chute.
    const rotation = this.rotation();
    const center = this.visualCenter();
    const baseOpacity = Math.max(0, o * 0.8) * depth.opacity;
    const visibility = readabilityAt(
      center.x,
      center.y,
      regions,
      motif ? this.size * Math.SQRT1_2 : this.radius * 1.5,
    );
    // Le renfort disparaît dans les zones de lecture : leur opacité reste identique.
    const iconBoost = 1 + (depth.iconBoost - 1) * (visibility - TEXT_REGION_OPACITY) / (1 - TEXT_REGION_OPACITY);
    ctx.globalAlpha = baseOpacity * visibility * (motif ? iconBoost : POINT_OPACITY_SCALE);

    if (sprite) {
      ctx.translate(this.x, this.y);
      const w = this.size;
      const h = w; // Les quinze motifs du catalogue ont un viewBox carré.
      ctx.rotate(rotation);
      const projection = this.options.motif?.projection;
      const beam = projection ? beamCache.get(projection.image) : null;
      if (projection && beam) {
        // Le cône partage exactement la transformation de l'objectif. Son
        // emprise est atténuée séparément lorsqu'il traverse une zone de texte.
        const originX = -w / 2 + projection.origin[0] * w;
        const originY = h + projection.origin[1] * w;
        const length = projection.length * w;
        const halfWidth = projection.halfWidth * w;
        const centerX = originX + length / 2;
        const centerY = originY;
        const visibility = readabilityAt(
          this.x + Math.cos(rotation) * centerX - Math.sin(rotation) * centerY,
          this.y + Math.sin(rotation) * centerX + Math.cos(rotation) * centerY,
          regions,
          Math.hypot(length / 2, halfWidth),
        );
        ctx.save();
        ctx.globalAlpha = baseOpacity * 0.85 * visibility;
        ctx.globalCompositeOperation = "screen";
        // Zone utile du SVG de lumière : x=24..488, y=128±104.
        ctx.drawImage(beam, originX - length * 24 / 464, originY - halfWidth * 128 / 104,
          length * 512 / 464, halfWidth * 256 / 104);
        ctx.restore();
      }
      const padding = w / 6;
      ctx.drawImage(sprite, -w / 2 - padding, h - padding, h + padding * 2, w + padding * 2);
    } else {
      ctx.ellipse(
        this.x,
        this.y,
        this.radius,
        this.radius * 1.5,
        this.direction,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = "white";
      ctx.fill();
    }
    ctx.restore();
  }
}

// Preset cinéma de P-Stream, réparti sur trois plans de profondeur.
const PARTICLE_COUNT = 265;
const IMAGE_PARTICLE_COUNT = Math.floor(PARTICLE_COUNT / 7.85) + 1;

const AdPopupCinemaRain = ({ unlocked = false }: { unlocked?: boolean }) => {
  const { effectivePrefs } = useLightMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => { measureRef.current?.(); }, [unlocked]);

  useEffect(() => {
    if (!effectivePrefs.bgAnimations) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const particles: Particle[] = [];
    const pendingSprites: { url: string; motifId?: string; depth?: number }[] = [];
    let frame: number | null = null;
    let preparationFrame: number | null = null;
    let preparationTimer: number | null = null;
    let preparationGeneration = 0;
    let previousTime = 0;
    let pixelRatio = 1;
    let pixelRatioY = 1;
    let measured = false;
    let regions: ReadableRegion[] = [];
    const dialog = canvas.closest('[role="dialog"]');

    const measure = () => {
      if (reducedMotion.matches) return;
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      const size = fitCanvasBitmapSize(cssWidth, cssHeight, Math.min(window.devicePixelRatio || 1, 2));
      if (!size) {
        measured = false;
        return;
      }
      // Grouper les lectures avant de redimensionner le canvas.
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width) {
        measured = false;
        return;
      }
      const scale = cssWidth / bounds.width;
      regions = Array.from(dialog?.querySelectorAll('[data-ad-copy]') ?? []).map(element => {
        const rect = element.getBoundingClientRect();
        return {
          left: (rect.left - bounds.left) * scale - 16,
          right: (rect.right - bounds.left) * scale + 16,
          top: (rect.top - bounds.top) * scale - 20,
          bottom: (rect.bottom - bounds.top) * scale + 16,
        };
      });
      if (
        canvas.width !== size.width
        || canvas.height !== size.height
        || pixelRatio !== size.scaleX
        || pixelRatioY !== size.scaleY
      ) {
        const previousLogicalWidth = canvas.width / pixelRatio;
        const scaleX = previousLogicalWidth > 0 ? cssWidth / previousLogicalWidth : 1;
        for (const particle of particles) {
          particle.x *= scaleX;
          particle.pixelRatio = size.scaleX;
        }
        try {
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext('2d');
          context?.setTransform(size.scaleX, 0, 0, size.scaleY, 0, 0);
        } catch (error) {
          if (!isCanvasInvalidStateError(error)) throw error;
          canvas.width = 0;
          canvas.height = 0;
          measured = false;
          return;
        }
      }
      pixelRatio = size.scaleX;
      pixelRatioY = size.scaleY;
      measured = true;
    };
    measureRef.current = measure;

    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (preparationFrame !== null) cancelAnimationFrame(preparationFrame);
      if (preparationTimer !== null) window.clearTimeout(preparationTimer);
      frame = null;
      preparationFrame = null;
      preparationTimer = null;
      preparationGeneration += 1;
      previousTime = 0;
    };

    // Un seul décodage/rendu de sprite par tour, après que le navigateur a pu
    // peindre la popup. Ni le montage ni la boucle de dessin ne préparent les SVG.
    const schedulePreparation = () => {
      if (pendingSprites.length === 0) return;
      preparationFrame = requestAnimationFrame(() => {
        preparationFrame = null;
        preparationTimer = window.setTimeout(() => {
          preparationTimer = null;
          const generation = preparationGeneration;
          const { url, motifId, depth } = pendingSprites[0];
          const image = loadImage(url);
          if (motifId) image.dataset.cinemaMotif = motifId;
          void decodeImage(image).then(() => {
            if (generation !== preparationGeneration) return;
            if (depth === undefined) prepareBeamSprite(url, image);
            else prepareSprite(url, image, depth);
          }).catch(() => {
            // Un asset indisponible ne doit pas bloquer les autres motifs.
            if (generation === preparationGeneration) imageCache.delete(url);
          }).finally(() => {
            if (generation !== preparationGeneration) return;
            pendingSprites.shift();
            schedulePreparation();
          });
        }, 0);
      });
    };

    const particlesLoop = (time: number) => {
      frame = null;
      if (!measured) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const delta = previousTime ? Math.min((time - previousTime) / (1000 / 60), 3) : 1;
      previousTime = time;
      try {
        ctx.clearRect(0, 0, canvas.width / pixelRatio, canvas.height / pixelRatioY);
        for (const particle of particles) {
          particle.update(canvas, delta, particles);
          particle.render(canvas, regions);
        }
      } catch (error) {
        if (!isCanvasInvalidStateError(error)) throw error;
        canvas.width = 0;
        canvas.height = 0;
        measured = false;
        return;
      }
      frame = requestAnimationFrame(particlesLoop);
    };

    const syncActivity = () => {
      stop();
      if (!measured || document.hidden || reducedMotion.matches || !canvas.getContext("2d")) return;

      if (particles.length === 0) {
        const motifs = createCinemaMotifSequence(IMAGE_PARTICLE_COUNT);
        for (let i = 0; i < PARTICLE_COUNT; i += 1) {
          const motif = motifs[i];
          const particle = new Particle(canvas, {
            motif,
            sizeRange: motif?.sizeRange,
            depth: motif?.projection ? 1 + i % 2 : i % DEPTH_PLANES.length,
          }, pixelRatio);
          particle.avoidOverlap(canvas, particles, true);
          particles.push(particle);
        }
        particles.sort((a, b) => (a.options.depth ?? 1) - (b.options.depth ?? 1));
        const queued = new Set<string>();
        for (const particle of particles) {
          const { motif, depth = 1 } = particle.options;
          if (!motif) continue;
          const key = `${motif.image}:${depth}`;
          if (!spriteCache.get(motif.image)?.has(depth) && !queued.has(key)) {
            queued.add(key);
            pendingSprites.push({ url: motif.image, motifId: motif.id, depth });
          }
          const projection = motif.projection;
          if (projection && !beamCache.has(projection.image) && !queued.has(projection.image)) {
            queued.add(projection.image);
            pendingSprites.push({ url: projection.image });
          }
        }
      }

      frame = requestAnimationFrame(particlesLoop);
      schedulePreparation();
    };

    const handleReducedMotionChange = () => {
      if (!reducedMotion.matches && !measured) measure();
      syncActivity();
    };

    document.addEventListener("visibilitychange", syncActivity);
    const legacyReducedMotion = reducedMotion as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    if (typeof reducedMotion.addEventListener === 'function') {
      reducedMotion.addEventListener("change", handleReducedMotionChange);
    } else {
      legacyReducedMotion.addListener?.(handleReducedMotionChange);
    }
    // La première mesure suit le layout natif via ResizeObserver. Une lecture
    // synchrone au montage forcerait le layout de la page derrière le dialog.
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        measure();
        if (frame === null) syncActivity();
      });
    observer?.observe(canvas);
    if (dialog) observer?.observe(dialog);
    dialog?.querySelectorAll('[data-ad-copy]').forEach(element => observer?.observe(element));
    const handleWindowResize = () => {
      measure();
      if (frame === null) syncActivity();
    };
    if (!observer) {
      window.addEventListener('resize', handleWindowResize, { passive: true });
      measure();
    }
    syncActivity();

    return () => {
      stop();
      observer?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      measureRef.current = null;
      document.removeEventListener("visibilitychange", syncActivity);
      if (typeof reducedMotion.removeEventListener === 'function') {
        reducedMotion.removeEventListener("change", handleReducedMotionChange);
      } else {
        legacyReducedMotion.removeListener?.(handleReducedMotionChange);
      }
    };
  }, [effectivePrefs.bgAnimations]);

  if (!effectivePrefs.bgAnimations) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 select-none overflow-hidden rounded-2xl"
    >
      <div
        data-cinema-lightbar
        className="absolute inset-x-0 top-0 h-48 bg-[radial-gradient(ellipse_85%_110%_at_50%_-25%,rgba(96,165,250,0.44),rgba(59,130,246,0.08)_50%,transparent_76%)]"
      />
      <div className="absolute inset-x-[20%] top-0 h-px bg-gradient-to-r from-transparent via-blue-200/70 to-transparent" />
      <canvas ref={canvasRef} className="pointer-events-none absolute left-1/2 top-0 h-[300px] w-[200%] -translate-x-1/2 motion-reduce:hidden" />
      {unlocked && (
        <div
          data-cinema-unlocked
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_5%,rgba(96,165,250,0.24),transparent_65%)] opacity-0 motion-safe:animate-ad-unlocked-glow"
        />
      )}
    </div>
  );
};

export default AdPopupCinemaRain;
