/**
 * Media Downloader, Converter & Client-Side Knowledge Contracts (`contracts/media.ts`)
 */

export type MediaPlatform =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'x'
  | 'soundcloud'
  | 'audius'
  | 'bandcamp'
  | 'spotify'
  | 'archive'
  | 'streamable'
  | 'vimeo'
  | 'dailymotion'
  | 'reddit'
  | 'itunes'
  | 'direct'
  | 'local';

export type MediaKind = 'video' | 'audio' | 'image';

export type TargetFormatId =
  | 'mp4-4k'
  | 'mp4-1080'
  | 'mp4-720'
  | 'webm'
  | 'mkv'
  | 'mov'
  | 'gif'
  | 'mp3-320'
  | 'mp3-192'
  | 'wav'
  | 'flac'
  | 'aac'
  | 'ogg'
  | 'm4a'
  | 'png'
  | 'jpg'
  | 'webp'
  | 'srt'
  | 'txt';

export interface FormatOption {
  id: TargetFormatId;
  label: string;
  ext: string;
  category: 'video' | 'audio' | 'image' | 'subtitle';
  quality: string;
  codec: string;
  estimatedSizeMb?: number;
  available: boolean;
  directUrl?: string;
}

export interface MediaSearchItem {
  id: string;
  title: string;
  creator: string;
  platform: MediaPlatform;
  kind: MediaKind;
  durationSec: number;
  durationLabel: string;
  thumbnailUrl: string;
  sourceUrl: string;
  previewStreamUrl?: string;
  viewsLabel?: string;
  genreOrTag?: string;
}

export interface MediaInspectResult {
  id: string;
  title: string;
  creator: string;
  platform: MediaPlatform;
  kind: MediaKind;
  durationSec: number;
  durationLabel: string;
  thumbnailUrl: string;
  sourceUrl: string;
  previewStreamUrl?: string;
  directVideoUrl?: string;
  directAudioUrl?: string;
  embedPlayerUrl?: string;
  streamIsHls?: boolean;
  playlistItems?: MediaSearchItem[];
  description: string;
  keywords: string[];
  transcriptText: string;
  transcriptSegments: Array<{ startSec: number; text: string }>;
  lyricsText?: string;
  lyricsSynced?: Array<{ timeSec: number; line: string }>;
  lyricsSource?: string;
  formats: FormatOption[];
  resolution?: string;
  bitrateKbps?: number;
  fileSizeBytes?: number;
  extractorNote: string;
}

export interface ClientAnalysisResult {
  bpm: number | null;
  rmsDb: number | null;
  spectralCentroidHz: number | null;
  moodTags: string[];
  dominantColors: string[];
  keywords: string[];
  safetyPassed: boolean;
  computeLocation: 'client-worker';
  elapsedMs: number;
}

export interface MahsoodaKnowledgeCard {
  sourceUrl: string;
  platform: MediaPlatform;
  kind: MediaKind;
  title: string;
  creator: string;
  durationSec: number;
  transcriptExcerpt: string;
  keywords: string[];
  moodTags: string[];
  bpm: number | null;
  dominantColors: string[];
  ocrText?: string;
  safetyPassed: boolean;
  payloadBytes: number;
  eventType?: 'visit' | 'search' | 'inspect' | 'watch' | 'study' | 'download' | 'upload';
  chosenFormat?: string;
  accessNodeMode?: 'server' | 'client-edge' | 'local-file';
  visualFrameCount?: number;
}

export type AiMediaAction =
  | 'watch'
  | 'summarize'
  | 'transcript'
  | 'lyrics'
  | 'translate'
  | 'separate'
  | 'taste_dna';

export interface AiMediaRequest {
  action: AiMediaAction;
  targetLang?: 'ar' | 'ary' | 'fr' | 'en';
  media: {
    title: string;
    creator: string;
    platform: MediaPlatform;
    sourceUrl: string;
    audioUrl?: string;
    description?: string;
    transcriptText?: string;
    keywords?: string[];
    durationSec?: number;
    imageDataUrls?: string[];
    clientTelemetry?: {
      bpm?: number | null;
      rmsDb?: number | null;
      dominantColors?: string[];
      accessNode?: string;
      frameCount?: number;
    };
    collectiveVisualHint?: string;
  };
}

export interface AiMediaResponse {
  ok: boolean;
  action: AiMediaAction;
  providerMode: 'mahsooda' | 'gemini' | 'local-analyzer';
  modelUsed?: string;
  externalStatus?: string;
  heading: string;
  content: string;
  bullets?: string[];
  stemMode?: {
    vocalGain: number;
    instrumentalMode: 'mid-side-cancel' | 'bandpass-vocal';
    description: string;
  };
}
