/**
 * Client-Device Compute, Visual Keyframe Perception & Evolution Sync (`src/media/client-compute.ts`)
 *
 * Uses the user's device as the sensory body for HEYUKA:
 * - Multi-timestamp <video> -> <canvas> keyframe sampling (works even on 1h-2h Range streams)
 * - Thumbnail palette & fallback vision capture
 * - Web Audio BPM/RMS/spectral decoding + Mid/Side vocal/instrumental DSP
 * - Idle-scheduled ~2KB JSON evolution sync to `/api/mahsooda-learn` + local IndexedDB vault
 */

import type {
  ClientAnalysisResult,
  MahsoodaKnowledgeCard,
  MediaInspectResult,
} from '../../contracts/media.js';
import type { WorkerAnalyzeRequest, WorkerAnalyzeResponse } from '../workers/media-analyzer.worker.js';
import { persistEmbodiedDeviceMemory } from './edge-resolver.js';

let workerInstance: Worker | null = null;

function getAnalyzerWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('../workers/media-analyzer.worker.ts', import.meta.url),
      { type: 'module' }
    );
  }
  return workerInstance;
}

function scheduleIdle<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      task().then(resolve).catch(reject);
    };
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(run, { timeout: 1200 });
    } else {
      setTimeout(run, 40);
    }
  });
}

async function imageUrlToDataUrl(imageUrl: string): Promise<string | null> {
  if (!imageUrl || typeof document === 'undefined') return null;
  try {
    const proxiedUrl =
      imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')
        ? imageUrl
        : `/api/media/thumb?url=${encodeURIComponent(imageUrl)}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('img timeout')), 3500);
      img.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('img failed'));
      };
      img.src = proxiedUrl;
    });
    const canvas = document.createElement('canvas');
    const w = Math.min(360, img.naturalWidth || 360);
    const h = Math.max(120, Math.round(((img.naturalHeight || 202) / (img.naturalWidth || 360)) * w));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

/**
 * Captures up to 4 keyframes across any video stream duration (3m, 1h, 2h+)
 * using Range-seeked offscreen <video> + <canvas>, falling back to proxied thumbnail.
 */
export async function extractVideoKeyframes(
  videoStreamUrl: string | undefined,
  thumbnailUrl: string,
  maxFrames = 4
): Promise<string[]> {
  const frames: string[] = [];

  if (videoStreamUrl && typeof document !== 'undefined' && !videoStreamUrl.includes('.m3u8')) {
    try {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = videoStreamUrl;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('video metadata timeout')), 4500);
        video.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error('video load error'));
        };
      });

      const dur = Number.isFinite(video.duration) && video.duration > 1 ? video.duration : 0;
      const ratios = [0.08, 0.34, 0.62, 0.88].slice(0, maxFrames);
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');

      if (ctx && dur > 0) {
        for (const r of ratios) {
          try {
            video.currentTime = Math.max(0.5, Math.min(dur - 0.5, dur * r));
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => reject(new Error('seek timeout')), 1800);
              video.onseeked = () => {
                clearTimeout(t);
                resolve();
              };
            });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.68);
            if (dataUrl.startsWith('data:image/')) {
              frames.push(dataUrl);
            }
          } catch {
            break; // CORS tainted canvas or seek failed
          }
        }
      }
      video.removeAttribute('src');
      video.load();
    } catch {
      // Fall back to thumbnail frame below
    }
  }

  if (frames.length === 0 && thumbnailUrl) {
    const thumbFrame = await imageUrlToDataUrl(thumbnailUrl);
    if (thumbFrame) frames.push(thumbFrame);
  }

  return frames;
}

export async function extractDominantColorsFromThumb(thumbnailUrl: string): Promise<string[]> {
  if (!thumbnailUrl || typeof document === 'undefined') return ['#F4F03A', '#111111'];
  try {
    const proxiedUrl =
      thumbnailUrl.startsWith('data:') || thumbnailUrl.startsWith('blob:')
        ? thumbnailUrl
        : `/api/media/thumb?url=${encodeURIComponent(thumbnailUrl)}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('thumb timeout')), 3500);
      img.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('thumb load failed'));
      };
      img.src = proxiedUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    if (!ctx) return ['#F4F03A', '#111111'];
    ctx.drawImage(img, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;

    const buckets = new Map<string, number>();
    for (let i = 0; i < data.length; i += 16) {
      const r = Math.round((data[i] ?? 0) / 32) * 32;
      const g = Math.round((data[i + 1] ?? 0) / 32) * 32;
      const b = Math.round((data[i + 2] ?? 0) / 32) * 32;
      const hex = `#${[r, g, b].map((c) => Math.min(255, c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      buckets.set(hex, (buckets.get(hex) ?? 0) + 1);
    }
    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hex]) => hex);
  } catch {
    return ['#F4F03A', '#FFA8E4'];
  }
}

async function decodeAudioSamplesFromUrl(url: string): Promise<{ samples?: Float32Array; sampleRate?: number }> {
  if (!url || typeof window === 'undefined') return {};
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return {};
  try {
    // Request only first 1.5MB via Range if possible so 2-hour streams don't get downloaded whole for BPM analysis
    const resp = await fetch(url, {
      headers: { Range: 'bytes=0-1572864' },
      signal: AbortSignal.timeout(5500),
    });
    if (!resp.ok) return {};
    const buf = await resp.arrayBuffer();
    const ctx = new AudioCtx();
    const decoded = await ctx.decodeAudioData(buf);
    const channelData = decoded.getChannelData(0).slice(0, decoded.sampleRate * 16);
    void ctx.close();
    return { samples: channelData, sampleRate: decoded.sampleRate };
  } catch {
    return {};
  }
}

export async function reportEvolutionEvent(
  card: MahsoodaKnowledgeCard
): Promise<{ synced: boolean; evolutionGeneration?: number; localBodyCount: number }> {
  const localBodyCount = await persistEmbodiedDeviceMemory(card);
  let synced = false;
  let evolutionGeneration: number | undefined;
  try {
    const resp = await fetch('/api/mahsooda-learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      keepalive: true,
    });
    if (resp.ok) {
      const json = (await resp.json()) as { ok?: boolean; evolutionGeneration?: number };
      synced = Boolean(json.ok);
      evolutionGeneration = json.evolutionGeneration;
    }
  } catch {
    synced = false;
  }
  return { synced, evolutionGeneration, localBodyCount };
}

export async function runClientMediaAnalysisAndSync(
  media: MediaInspectResult,
  options: {
    localAudioSamples?: Float32Array;
    localSampleRate?: number;
    silentSync?: boolean;
    accessNodeMode?: 'server' | 'client-edge' | 'local-file';
    eventType?: MahsoodaKnowledgeCard['eventType'];
  } = {}
): Promise<{
  analysis: ClientAnalysisResult;
  knowledgeCard: MahsoodaKnowledgeCard;
  synced: boolean;
  keyframes: string[];
  evolutionGeneration?: number;
  localBodyCount: number;
}> {
  return scheduleIdle(async () => {
    const [dominantColors, keyframes] = await Promise.all([
      extractDominantColorsFromThumb(media.thumbnailUrl),
      extractVideoKeyframes(
        media.kind === 'video' ? media.previewStreamUrl || media.directVideoUrl : undefined,
        media.thumbnailUrl,
        4
      ),
    ]);

    let pcmSamples = options.localAudioSamples;
    let sampleRate = options.localSampleRate;
    if (!pcmSamples && media.previewStreamUrl && (media.kind === 'audio' || media.platform === 'itunes')) {
      const decoded = await decodeAudioSamplesFromUrl(media.previewStreamUrl);
      pcmSamples = decoded.samples;
      sampleRate = decoded.sampleRate;
    }

    const worker = getAnalyzerWorker();
    let result: WorkerAnalyzeResponse;

    if (worker) {
      const id = `${media.id}-${Date.now()}`;
      result = await new Promise<WorkerAnalyzeResponse>((resolve) => {
        const onMsg = (ev: MessageEvent<WorkerAnalyzeResponse>) => {
          if (ev.data?.id === id) {
            worker.removeEventListener('message', onMsg);
            resolve(ev.data);
          }
        };
        worker.addEventListener('message', onMsg);
        const payload: WorkerAnalyzeRequest = {
          id,
          pcmSamples,
          sampleRate,
          dominantColors,
          media: {
            sourceUrl: media.sourceUrl,
            platform: media.platform,
            kind: media.kind,
            title: media.title,
            creator: media.creator,
            durationSec: media.durationSec,
            description: media.description,
            transcriptText: media.transcriptText,
          },
        };
        worker.postMessage(payload);
      });
    } else {
      const card: MahsoodaKnowledgeCard = {
        sourceUrl: media.sourceUrl,
        platform: media.platform,
        kind: media.kind,
        title: media.title,
        creator: media.creator,
        durationSec: media.durationSec,
        transcriptExcerpt: (media.transcriptText || media.description || media.title).slice(0, 500),
        keywords: media.keywords.slice(0, 6),
        moodTags: ['Stream Ready'],
        bpm: null,
        dominantColors,
        safetyPassed: true,
        payloadBytes: 512,
      };
      result = {
        id: media.id,
        analysis: {
          bpm: null,
          rmsDb: null,
          spectralCentroidHz: null,
          moodTags: ['Stream Ready'],
          dominantColors,
          keywords: media.keywords.slice(0, 6),
          safetyPassed: true,
          computeLocation: 'client-worker',
          elapsedMs: 1,
        },
        knowledgeCard: card,
      };
    }

    const enrichedCard: MahsoodaKnowledgeCard = {
      ...result.knowledgeCard,
      eventType: options.eventType ?? 'inspect',
      accessNodeMode: options.accessNodeMode ?? (media.platform === 'local' ? 'local-file' : 'server'),
      visualFrameCount: keyframes.length,
    };

    let synced = false;
    let evolutionGeneration: number | undefined;
    let localBodyCount = 0;

    if (options.silentSync !== false && result.analysis.safetyPassed) {
      const reported = await reportEvolutionEvent(enrichedCard);
      synced = reported.synced;
      evolutionGeneration = reported.evolutionGeneration;
      localBodyCount = reported.localBodyCount;
    } else {
      localBodyCount = await persistEmbodiedDeviceMemory(enrichedCard);
    }

    return {
      analysis: result.analysis,
      knowledgeCard: enrichedCard,
      synced,
      keyframes,
      evolutionGeneration,
      localBodyCount,
    };
  });
}

/**
 * Client-Side Web Audio Stem Filter (Full Mix | Instrumental Mid/Side Cancel | Vocal Focus)
 * Zero server CPU required.
 */
export type StemListeningMode = 'full' | 'instrumental' | 'vocals';

export class ClientAudioStemController {
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private mode: StemListeningMode = 'full';
  private gainFull: GainNode | null = null;
  private gainInst: GainNode | null = null;
  private gainVocal: GainNode | null = null;

  public attach(audioEl: HTMLAudioElement): void {
    if (this.source || typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.source = this.ctx.createMediaElementSource(audioEl);

      // Branch 1: Full Mix
      this.gainFull = this.ctx.createGain();
      this.gainFull.gain.value = 1;
      this.source.connect(this.gainFull);
      this.gainFull.connect(this.ctx.destination);

      // Branch 2: Instrumental (L - R Mid/Side center cancellation)
      const splitter = this.ctx.createChannelSplitter(2);
      const invertR = this.ctx.createGain();
      invertR.gain.value = -1;
      const sideMix = this.ctx.createGain();
      sideMix.gain.value = 0.85;
      this.gainInst = this.ctx.createGain();
      this.gainInst.gain.value = 0;

      this.source.connect(splitter);
      splitter.connect(sideMix, 0);
      splitter.connect(invertR, 1);
      invertR.connect(sideMix);
      sideMix.connect(this.gainInst);
      this.gainInst.connect(this.ctx.destination);

      // Branch 3: Vocal Focus (Bandpass 300Hz - 3400Hz)
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 300;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3400;
      this.gainVocal = this.ctx.createGain();
      this.gainVocal.gain.value = 0;

      this.source.connect(hp);
      hp.connect(lp);
      lp.connect(this.gainVocal);
      this.gainVocal.connect(this.ctx.destination);

      this.setMode(this.mode);
    } catch {
      // Cross-origin audio element cannot be routed through Web Audio; native playback still works
    }
  }

  public setMode(mode: StemListeningMode): void {
    this.mode = mode;
    if (this.ctx?.state === 'suspended') {
      void this.ctx.resume();
    }
    if (this.gainFull) this.gainFull.gain.value = mode === 'full' ? 1 : 0;
    if (this.gainInst) this.gainInst.gain.value = mode === 'instrumental' ? 1 : 0;
    if (this.gainVocal) this.gainVocal.gain.value = mode === 'vocals' ? 1 : 0;
  }

  public getMode(): StemListeningMode {
    return this.mode;
  }
}

/**
 * Client-side Image Format Converter (Canvas -> PNG / JPG / WEBP) with zero server roundtrip.
 */
export async function convertImageFileLocally(
  file: File,
  targetExt: 'png' | 'jpg' | 'webp'
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable.');
  ctx.drawImage(bitmap, 0, 0);
  const mime =
    targetExt === 'png' ? 'image/png' : targetExt === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Image conversion failed.'));
      },
      mime,
      0.92
    );
  });
}
