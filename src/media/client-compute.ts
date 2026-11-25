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
    if (!pcmSamples && media.previewStreamUrl && media.kind === 'audio') {
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

export type EqBands4 = [number, number, number, number];
export const IDLE_EQ_BANDS: EqBands4 = [0.18, 0.18, 0.18, 0.18];

function isSameOriginAudioSrc(mediaEl: HTMLMediaElement): boolean {
  const src = mediaEl.currentSrc || mediaEl.src || '';
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/')) return true;
  try {
    return typeof window !== 'undefined' && new URL(src, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function binsToEqBands(freqData: Uint8Array): EqBands4 {
  const avgRange = (start: number, end: number): number => {
    let sum = 0;
    let count = 0;
    for (let i = start; i <= end && i < freqData.length; i += 1) {
      sum += freqData[i] ?? 0;
      count += 1;
    }
    return count > 0 ? sum / (count * 255) : 0;
  };
  const b1 = Math.max(0.18, Math.min(1, 0.18 + avgRange(0, 2) * 0.95));
  const b2 = Math.max(0.18, Math.min(1, 0.18 + avgRange(3, 6) * 0.95));
  const b3 = Math.max(0.18, Math.min(1, 0.18 + avgRange(7, 13) * 1.05));
  const b4 = Math.max(0.18, Math.min(1, 0.18 + avgRange(14, 24) * 1.15));
  return [b1, b2, b3, b4];
}

const mediaAnalyserCache = new WeakMap<
  HTMLMediaElement,
  { ctx: AudioContext; analyser: AnalyserNode; freqData: Uint8Array<ArrayBuffer> }
>();

export function sampleMediaElementBands(mediaEl: HTMLMediaElement | null): EqBands4 {
  if (!mediaEl || mediaEl.paused || mediaEl.ended || mediaEl.readyState < 2) {
    return IDLE_EQ_BANDS;
  }
  if (typeof window !== 'undefined' && isSameOriginAudioSrc(mediaEl)) {
    let entry = mediaAnalyserCache.get(mediaEl);
    if (!entry) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          const ctx = new AudioCtx();
          const source = ctx.createMediaElementSource(mediaEl);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          analyser.smoothingTimeConstant = 0.72;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          entry = {
            ctx,
            analyser,
            freqData: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
          };
          mediaAnalyserCache.set(mediaEl, entry);
        } catch {
          // Element may already be bound elsewhere or blocked; fallback cadence used below
        }
      }
    }
    if (entry) {
      if (entry.ctx.state === 'suspended') {
        void entry.ctx.resume().catch(() => {});
      }
      if (entry.ctx.state === 'running') {
        entry.analyser.getByteFrequencyData(entry.freqData);
        const bands = binsToEqBands(entry.freqData);
        if (bands[0] > 0.19 || bands[1] > 0.19 || bands[2] > 0.19 || bands[3] > 0.19) {
          return bands;
        }
      }
    }
  }

  // Fallback cadence strictly tied to active advancing playback currentTime (never when paused)
  const t = mediaEl.currentTime;
  return [
    0.26 + Math.abs(Math.sin(t * 9.5)) * 0.62,
    0.26 + Math.abs(Math.sin(t * 12.1 + 1.1)) * 0.68,
    0.26 + Math.abs(Math.sin(t * 14.3 + 2.3)) * 0.65,
    0.26 + Math.abs(Math.sin(t * 10.7 + 3.4)) * 0.56,
  ];
}

/**
 * Client-Side Web Audio Stem Filter (Full Mix | Instrumental Mid/Side Cancel | Vocal Focus)
 * + Live FFT AnalyserNode metering for audio-reactive UI bars. Zero server CPU required.
 */
export type StemListeningMode = 'full' | 'instrumental' | 'vocals';

export class ClientAudioStemController {
  private ctx: AudioContext | null = null;
  private boundAudioEl: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private mode: StemListeningMode = 'full';
  private gainFull: GainNode | null = null;
  private gainInst: GainNode | null = null;
  private gainVocal: GainNode | null = null;
  private masterGain: GainNode | null = null;

  public attach(audioEl: HTMLAudioElement): void {
    this.boundAudioEl = audioEl;
    if (this.mode !== 'full' || isSameOriginAudioSrc(audioEl)) {
      this.ensureGraphConnected();
    }
    if (this.ctx?.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
  }

  private ensureGraphConnected(): void {
    const audioEl = this.boundAudioEl;
    if (!audioEl || this.source || typeof window === 'undefined') return;
    if (!isSameOriginAudioSrc(audioEl) && this.mode === 'full') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.source = this.ctx.createMediaElementSource(audioEl);
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 64;
      this.analyser.smoothingTimeConstant = 0.72;
      this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      // Branch 1: Full Mix
      this.gainFull = this.ctx.createGain();
      this.gainFull.gain.value = this.mode === 'full' ? 1 : 0;
      this.source.connect(this.gainFull);
      this.gainFull.connect(this.masterGain);

      // Branch 2: Instrumental (L - R Mid/Side center cancellation)
      const splitter = this.ctx.createChannelSplitter(2);
      const invertR = this.ctx.createGain();
      invertR.gain.value = -1;
      const sideMix = this.ctx.createGain();
      sideMix.gain.value = 0.85;
      this.gainInst = this.ctx.createGain();
      this.gainInst.gain.value = this.mode === 'instrumental' ? 1 : 0;

      this.source.connect(splitter);
      splitter.connect(sideMix, 0);
      splitter.connect(invertR, 1);
      invertR.connect(sideMix);
      sideMix.connect(this.gainInst);
      this.gainInst.connect(this.masterGain);

      // Branch 3: Vocal Focus (Bandpass 300Hz - 3400Hz)
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 300;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3400;
      this.gainVocal = this.ctx.createGain();
      this.gainVocal.gain.value = this.mode === 'vocals' ? 1 : 0;

      this.source.connect(hp);
      hp.connect(lp);
      lp.connect(this.gainVocal);
      this.gainVocal.connect(this.masterGain);
    } catch {
      // Fallback: native playback continues uninterrupted
    }
  }

  public getFrequencyBands(): EqBands4 {
    const audioEl = this.boundAudioEl;
    if (!audioEl || audioEl.paused || audioEl.ended || audioEl.readyState < 2) {
      return IDLE_EQ_BANDS;
    }
    if (this.analyser && this.freqData && this.ctx?.state === 'running') {
      this.analyser.getByteFrequencyData(this.freqData);
      const bands = binsToEqBands(this.freqData);
      if (bands[0] > 0.19 || bands[1] > 0.19 || bands[2] > 0.19 || bands[3] > 0.19) {
        return bands;
      }
    }
    const t = audioEl.currentTime;
    return [
      0.26 + Math.abs(Math.sin(t * 9.5)) * 0.62,
      0.26 + Math.abs(Math.sin(t * 12.1 + 1.1)) * 0.68,
      0.26 + Math.abs(Math.sin(t * 14.3 + 2.3)) * 0.65,
      0.26 + Math.abs(Math.sin(t * 10.7 + 3.4)) * 0.56,
    ];
  }

  public setMode(mode: StemListeningMode): void {
    this.mode = mode;
    if (mode !== 'full') {
      this.ensureGraphConnected();
    }
    if (this.ctx?.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (this.gainFull) this.gainFull.gain.value = mode === 'full' ? 1 : 0;
    if (this.gainInst) this.gainInst.gain.value = mode === 'instrumental' ? 1 : 0;
    if (this.gainVocal) this.gainVocal.gain.value = mode === 'vocals' ? 1 : 0;
  }

  public async resumeIfNeeded(): Promise<void> {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
  }

  public async fadeTransition(audioEl: HTMLAudioElement, targetVol = 1, durationMs = 260): Promise<void> {
    const startVol = audioEl.volume;
    const steps = 8;
    const stepMs = Math.max(16, Math.round(durationMs / steps));
    for (let i = 1; i <= steps; i += 1) {
      audioEl.volume = Math.max(0, Math.min(1, startVol + ((targetVol - startVol) * i) / steps));
      await new Promise((r) => setTimeout(r, stepMs));
    }
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

function encodeAudioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numChannels * 2;
  const wavBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  let offset = 44;
  for (let i = 0; i < buffer.length; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const s = Math.max(-1, Math.min(1, channels[ch]![i] ?? 0));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

/**
 * Client-side Audio -> PCM 16-bit WAV converter with zero server load.
 */
export async function exportLocalAudioAsWavClient(blob: Blob): Promise<Blob> {
  if (!blob || blob.size === 0 || blob.size > 90 * 1024 * 1024) {
    throw new Error('File too large for in-browser WAV decode.');
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('Web Audio API unavailable.');
  }
  const ctx = new AudioCtx();
  try {
    const arrBuf = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrBuf);
    return encodeAudioBufferToWavBlob(audioBuffer);
  } finally {
    void ctx.close().catch(() => {});
  }
}
