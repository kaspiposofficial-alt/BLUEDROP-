/**
 * Client-Device Web Worker (`src/workers/media-analyzer.worker.ts`)
 *
 * Executes audio BPM/RMS/spectral estimation, keyword distillation, and safety
 * filtering entirely on the user's CPU during idle cycles — zero server load.
 */

import type { ClientAnalysisResult, MahsoodaKnowledgeCard, MediaKind, MediaPlatform } from '../../contracts/media.js';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was',
  'have', 'has', 'not', 'but', 'official', 'video', 'audio', 'music', 'feat', 'ft',
  'les', 'des', 'une', 'pour', 'avec', 'dans', 'sur', 'par', 'que', 'qui',
  'من', 'في', 'على', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'التي', 'الذي', 'ديال', 'ف',
]);

const UNSAFE_TERMS = ['nsfw', 'porn', 'xxx', 'hentai', 'explicit', 'onlyfans'];

export interface WorkerAnalyzeRequest {
  id: string;
  pcmSamples?: Float32Array;
  sampleRate?: number;
  dominantColors: string[];
  media: {
    sourceUrl: string;
    platform: MediaPlatform;
    kind: MediaKind;
    title: string;
    creator: string;
    durationSec: number;
    description?: string;
    transcriptText?: string;
    ocrText?: string;
  };
}

export interface WorkerAnalyzeResponse {
  id: string;
  analysis: ClientAnalysisResult;
  knowledgeCard: MahsoodaKnowledgeCard;
}

function estimateAudioMetrics(
  samples: Float32Array | undefined,
  sampleRate = 44100
): { bpm: number | null; rmsDb: number | null; spectralCentroidHz: number | null; moodTags: string[] } {
  if (!samples || samples.length < 2048) {
    return { bpm: null, rmsDb: null, spectralCentroidHz: null, moodTags: ['Stream Ready'] };
  }

  let sumSq = 0;
  let zeroCrossings = 0;
  const maxCheck = Math.min(samples.length, sampleRate * 20); // first 20s max
  for (let i = 1; i < maxCheck; i++) {
    const s = samples[i]!;
    sumSq += s * s;
    if ((s >= 0 && samples[i - 1]! < 0) || (s < 0 && samples[i - 1]! >= 0)) {
      zeroCrossings++;
    }
  }

  const rms = Math.sqrt(sumSq / maxCheck);
  const rmsDb = rms > 0 ? Math.round((20 * Math.log10(rms)) * 10) / 10 : -60;
  const zcrPerSec = zeroCrossings / (maxCheck / sampleRate);
  const spectralCentroidHz = Math.round(Math.min(8000, Math.max(120, zcrPerSec * 0.5)));

  // Envelope energy onset peak detector (~20ms windows)
  const winSize = Math.max(256, Math.floor(sampleRate * 0.02));
  const energies: number[] = [];
  for (let i = 0; i + winSize < maxCheck; i += winSize) {
    let e = 0;
    for (let j = 0; j < winSize; j++) {
      const v = samples[i + j]!;
      e += v * v;
    }
    energies.push(e / winSize);
  }

  let peaks = 0;
  const avgEnergy = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length);
  for (let i = 1; i < energies.length - 1; i++) {
    if (
      energies[i]! > avgEnergy * 1.45 &&
      energies[i]! > energies[i - 1]! &&
      energies[i]! > energies[i + 1]!
    ) {
      peaks++;
      i += 6; // refractory ~120ms
    }
  }

  const secondsAnalyzed = maxCheck / sampleRate;
  let bpm = secondsAnalyzed > 2 ? Math.round((peaks / secondsAnalyzed) * 60) : 110;
  while (bpm > 0 && bpm < 70) bpm *= 2;
  while (bpm > 175) bpm = Math.round(bpm / 2);
  if (bpm < 65 || bpm > 175) bpm = 116;

  const moodTags: string[] = [];
  if (bpm >= 122) moodTags.push('Upbeat');
  else if (bpm <= 92) moodTags.push('Downtempo');
  else moodTags.push('Mid-Tempo');

  if (rmsDb > -14) moodTags.push('High Energy');
  else moodTags.push('Dynamic');

  if (spectralCentroidHz > 1800) moodTags.push('Bright Mix');
  else moodTags.push('Warm Low-End');

  return { bpm, rmsDb, spectralCentroidHz, moodTags };
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  for (const tok of tokens) {
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
}

self.onmessage = (event: MessageEvent<WorkerAnalyzeRequest>) => {
  const started = performance.now();
  const req = event.data;
  const combined = `${req.media.title} ${req.media.creator} ${req.media.description ?? ''} ${req.media.transcriptText ?? ''} ${req.media.ocrText ?? ''}`;
  const lower = combined.toLowerCase();
  const safetyPassed = !UNSAFE_TERMS.some((term) => lower.includes(term));

  const audio = estimateAudioMetrics(req.pcmSamples, req.sampleRate);
  const keywords = extractKeywords(combined);
  const transcriptExcerpt = (req.media.transcriptText || req.media.description || req.media.title)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  const cardBase: Omit<MahsoodaKnowledgeCard, 'payloadBytes'> = {
    sourceUrl: req.media.sourceUrl,
    platform: req.media.platform,
    kind: req.media.kind,
    title: req.media.title.slice(0, 140),
    creator: req.media.creator.slice(0, 80),
    durationSec: req.media.durationSec,
    transcriptExcerpt,
    keywords,
    moodTags: audio.moodTags,
    bpm: audio.bpm,
    dominantColors: req.dominantColors.slice(0, 4),
    ocrText: req.media.ocrText?.slice(0, 240),
    safetyPassed,
  };

  const payloadBytes = new TextEncoder().encode(JSON.stringify(cardBase)).byteLength;
  const elapsedMs = Math.round(performance.now() - started);

  const response: WorkerAnalyzeResponse = {
    id: req.id,
    analysis: {
      bpm: audio.bpm,
      rmsDb: audio.rmsDb,
      spectralCentroidHz: audio.spectralCentroidHz,
      moodTags: audio.moodTags,
      dominantColors: req.dominantColors.slice(0, 4),
      keywords,
      safetyPassed,
      computeLocation: 'client-worker',
      elapsedMs,
    },
    knowledgeCard: {
      ...cardBase,
      payloadBytes,
    },
  };

  self.postMessage(response);
};
