/**
 * BLUEDROP — Standalone Media Downloader, On-Device Library & 3D Studio (`src/media/app.ts`)
 *
 * Built strictly in the "Blocks" visual identity:
 * flat saturated color blocks (#111111, #F3F0E6, #F4F03A, #FFA8E4, #FF5A14, #B9F0C6, #6E8BFF, #A9A2E0),
 * zero gradients, zero glow, Inter Tight + JetBrains Mono, Odometer metrics, dotted-leader receipts.
 */

import gsap from 'gsap';
import type {
  AiMediaResponse,
  ClientAnalysisResult,
  FormatOption,
  MediaInspectResult,
  MediaSearchItem,
  TargetFormatId,
} from '../../contracts/index.js';
import { Odometer } from '../design/components/odometer.js';
import {
  ClientAudioStemController,
  convertImageFileLocally,
  reportEvolutionEvent,
  runClientMediaAnalysisAndSync,
  type StemListeningMode,
} from './client-compute.js';
import {
  createSaveFolder,
  getDeviceStorageUsageSummary,
  inferCategoryFromFolder,
  listDeviceLibrary,
  listSaveFolders,
  removeFromDeviceLibrary,
  saveToDeviceLibrary,
  updateDeviceLibraryItem,
  type DeviceLibraryItem,
  type LibraryCategory,
} from './device-library.js';
import {
  getEmbodiedDeviceMemoryCount,
  resolveStreamFromDeviceEdge,
} from './edge-resolver.js';
import { UI_COPY, type UiLang } from './i18n.js';
import { MascotStageController } from './mascot-stage.js';
import { PixelTrailController } from './pixel-trail.js';
import {
  SEO_PAGES,
  applySeoHeadMetadata,
  matchSeoPage,
  type SeoRoutePage,
} from './seo-pages.js';
import {
  analyzeImagePixelsAndDepth,
  deleteLibraryItemFromFirestore,
  loadLocalVisualBrain,
  loadUserLibraryFromFirestore,
  signInWithGmailPopup,
  signOutUser,
  studyAvatarPixelsAndSave,
  studyClipInBackground,
  subscribeAuthState,
  subscribeCollectiveKnowledge,
  syncLibraryItemToFirestore,
  type AuthUserProfile,
  type CollectiveVisualStudy,
} from './firebase-client.js';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const LOCAL_CONVERT_TARGETS: Array<{ id: TargetFormatId; label: string; cat: 'video' | 'audio' | 'image' }> = [
  { id: 'mp4-1080', label: 'MP4 · 1080p', cat: 'video' },
  { id: 'mp4-720', label: 'MP4 · 720p', cat: 'video' },
  { id: 'webm', label: 'WEBM · VP9', cat: 'video' },
  { id: 'mkv', label: 'MKV', cat: 'video' },
  { id: 'mov', label: 'MOV', cat: 'video' },
  { id: 'gif', label: 'GIF Clip', cat: 'video' },
  { id: 'mp3-320', label: 'MP3 · 320k', cat: 'audio' },
  { id: 'mp3-192', label: 'MP3 · 192k', cat: 'audio' },
  { id: 'wav', label: 'WAV · PCM', cat: 'audio' },
  { id: 'flac', label: 'FLAC', cat: 'audio' },
  { id: 'aac', label: 'AAC', cat: 'audio' },
  { id: 'ogg', label: 'OGG', cat: 'audio' },
  { id: 'm4a', label: 'M4A', cat: 'audio' },
  { id: 'png', label: 'PNG', cat: 'image' },
  { id: 'jpg', label: 'JPG', cat: 'image' },
  { id: 'webp', label: 'WEBP', cat: 'image' },
];

const BLUEDROP_LOGO_SVG = `
<svg class="bd-logo-svg" viewBox="0 0 120 120" aria-hidden="true">
  <g fill="#111111">
    <polygon points="60,8 66,17 54,17"/>
    <polygon points="52,21 68,21 73,29 47,29"/>
    <polygon points="45,33 58,33 58,40 41,40"/>
    <polygon points="62,33 75,33 80,40 62,40"/>
    <polygon points="39,44 58,44 58,52 34,52"/>
    <polygon points="62,44 82,44 87,52 62,52"/>
    <polygon points="32,56 56,56 56,64 27,64"/>
    <polygon points="64,56 89,56 94,64 64,64"/>
    <polygon points="25,68 54,68 54,77 20,77"/>
    <polygon points="66,68 96,68 101,77 66,77"/>
    <polygon points="18,81 51,81 51,90 13,90"/>
    <polygon points="69,81 103,81 108,90 69,90"/>
    <polygon points="10,94 110,94 115,106 5,106"/>
  </g>
</svg>
`;

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function formatSrtTimestamp(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function extractUrlFromInput(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  const fullMatch = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  if (fullMatch) {
    return fullMatch[0].replace(/[),.;!?]+$/, '');
  }
  const bareMatch = trimmed.match(
    /(?:^|\s)((?:www\.)?(?:youtube\.com|youtu\.be|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|soundcloud\.com|on\.soundcloud\.com|audius\.co|open\.spotify\.com|vimeo\.com|dailymotion\.com|reddit\.com|archive\.org|streamable\.com|[a-z0-9-]+\.bandcamp\.com)\/[^\s"'<>]*)/i
  );
  if (bareMatch?.[1]) {
    return `https://${bareMatch[1].replace(/[),.;!?]+$/, '')}`;
  }
  return null;
}

function renderBookmarkSvg(saved: boolean): string {
  return saved
    ? `<svg class="bd-bookmark-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 3h14a1 1 0 0 1 1 1v17l-8-4.5L4 21V4a1 1 0 0 1 1-1z"/></svg>`
    : `<svg class="bd-bookmark-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M5 4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v16l-7-4-7 4V4z"/></svg>`;
}

type VectorIconName =
  | 'download'
  | 'music'
  | 'play'
  | 'shuffle'
  | 'order'
  | 'check'
  | 'fullscreen'
  | 'pin'
  | 'up'
  | 'down'
  | 'plus'
  | 'google'
  | 'arrow-right'
  | 'folder'
  | 'upload'
  | 'discover'
  | 'library'
  | 'convert'
  | 'app';

function renderVectorIcon(name: VectorIconName): string {
  switch (name) {
    case 'download':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>`;
    case 'music':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="16.5" cy="16" r="2.5" fill="currentColor"/></svg>`;
    case 'play':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><polygon fill="currentColor" points="6,4 20,12 6,20"/></svg>`;
    case 'shuffle':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M16 4h4v4M4 18l5-5M15 7l5-3M4 6l16 12m0 0h-4m4 0v-4"/></svg>`;
    case 'order':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 7h13m0 0l-3-3m3 3l-3 3M20 17H7m0 0l3 3m-3-3l3-3"/></svg>`;
    case 'check':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" d="M4.5 12.5l5 5 10-11"/></svg>`;
    case 'fullscreen':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
    case 'pin':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><polygon fill="currentColor" points="12,3 19,12 12,21 5,12"/></svg>`;
    case 'up':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M12 19V5m0 0l-6 6m6-6l6 6"/></svg>`;
    case 'down':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M12 5v14m0 0l-6-6m6 6l6-6"/></svg>`;
    case 'plus':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M12 5v14M5 12h14"/></svg>`;
    case 'google':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.8 10.2h-9.6v3.9h5.6c-.5 2.5-2.7 4-5.6 4a6.1 6.1 0 1 1 4.1-10.6l2.8-2.8A10 10 0 1 0 12.2 22c5.5 0 9.8-3.9 9.8-9.8 0-.7-.1-1.3-.2-2z"/></svg>`;
    case 'arrow-right':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M5 12h14m0 0l-5-5m5 5l-5 5"/></svg>`;
    case 'folder':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M3 6h6l2 2h10v10H3z"/></svg>`;
    case 'upload':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" d="M12 16V5m0 0l-4.5 4.5M12 5l4.5 4.5M5 19h14"/></svg>`;
    case 'discover':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2.2" d="M16 16l4.5 4.5"/></svg>`;
    case 'library':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="16" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="7" height="16" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
    case 'convert':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 8h11l-3-3m8 11H9l3 3"/></svg>`;
    case 'app':
      return `<svg class="bd-ico-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M10 17h4v1.5h-4z"/></svg>`;
  }
}

function renderEqBarsHtml(): string {
  return `<span class="bd-eq-bars" aria-hidden="true"><span></span><span></span><span></span><span></span></span>`;
}

export class BlockdropApp {
  private readonly root: HTMLElement;
  private lang: UiLang = 'en';
  private seoPage: SeoRoutePage;
  private searchFilter: 'all' | 'music' | 'video' = 'all';
  private searchQuery = '';
  private searching = false;
  private searchResults: MediaSearchItem[] = [];
  private searchError = '';
  private inspecting = false;
  private inspectingUrlLabel = '';
  private inspectedMedia: MediaInspectResult | null = null;
  private clientAnalysis: ClientAnalysisResult | null = null;
  private activeStudioNav: 'discover' | 'library' | 'converter' | 'install' = 'discover';

  private downloadBusyFormat: string | null = null;
  private downloadProgressPct = 0;
  private downloadStatusMsg = '';

  private aiLang: 'ar' | 'ary' | 'fr' | 'en' = 'ary';

  private stemController = new ClientAudioStemController();
  private stemMode: StemListeningMode = 'full';
  private playerPlaying = false;
  private playerCurrentSec = 0;
  private playerDurationSec = 0;
  private playerSheetExpanded = false;

  // Persistent background audio element so audio continues even when scrolling/switching views/minimizing
  private bgAudio: HTMLAudioElement | null = null;
  private activeBgTrack: {
    id: string;
    title: string;
    creator: string;
    src: string;
    artwork: string;
    sourceUrl?: string;
    platform?: MediaInspectResult['platform'];
    kind?: MediaInspectResult['kind'];
    durationLabel?: string;
  } | null = null;
  private activeLyrics: {
    trackKey: string;
    text?: string;
    synced?: Array<{ timeSec: number; line: string }>;
    source?: string;
    loading: boolean;
  } | null = null;
  private lyricsTranslation = '';
  private lyricsTranslating = false;
  private blobUrlPool: string[] = [];

  // On-Device Media Library & Instagram-style Collections state
  private resultsTab: 'live' | 'library' = 'live';
  private resultsViewMode: 'grid' | 'list' = 'grid';
  private playOrderMode: 'sequential' | 'shuffle' = 'sequential';
  private selectedArtistFilter = 'all';
  private extractingLyrics = false;
  private libraryItems: DeviceLibraryItem[] = [];
  private librarySearchQuery = '';
  private libraryCategoryFilter: 'all' | LibraryCategory = 'all';
  private libraryFolderFilter = 'all';
  private saveFolders: string[] = listSaveFolders();
  private activeSaveFolder = 'Favorites';
  private folderPickerTarget: {
    id: string;
    title: string;
    creator: string;
    platform: MediaInspectResult['platform'];
    kind: MediaInspectResult['kind'];
    albumOrTag: string;
    durationSec: number;
    durationLabel: string;
    sourceUrl: string;
    streamUrl?: string;
    directVideoUrl?: string;
    directAudioUrl?: string;
    embedPlayerUrl?: string;
    thumbnailUrl?: string;
    description?: string;
    keywords?: string[];
    transcriptText?: string;
    extractorNote?: string;
    lyricsText?: string;
  } | null = null;
  private saveFeedbackBanner = '';
  private isolatedOnly = false;
  private deviceUsedMb = 0;

  private localFile: File | null = null;
  private localTargetFormat: TargetFormatId = 'mp3-320';
  private localConverting = false;
  private localStatusMsg = '';

  private capturedKeyframes: string[] = [];
  private deviceEdgeNode = 'server-verified';

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private isStandalone = false;
  private installNotice = '';
  private formatOdometer: Odometer | null = null;

  // Auth, Persistent Gmail Profile & Silent Background Collective Brain
  private currentUser: AuthUserProfile | null = null;
  private authLoading = false;
  private authError = '';
  private authGateOpen = false;
  private authResolvedOnce = false;
  private pendingAfterAuthAction: (() => Promise<void> | void) | null = null;
  private collectiveBrain: CollectiveVisualStudy = loadLocalVisualBrain();
  private unsubAuth: (() => void) | null = null;
  private unsubBrain: (() => void) | null = null;

  // Persistent visual layers (never torn down during partial updates)
  private mascotStage: MascotStageController | null = null;
  private heroTrail: PixelTrailController | null = null;
  private inspectorTrail: PixelTrailController | null = null;
  private dropzoneTrail: PixelTrailController | null = null;
  private shellMounted = false;

  constructor(root: HTMLElement) {
    this.root = root;
    const pathName = typeof window !== 'undefined' ? window.location.pathname : '/';
    const urlParams =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const qLang = urlParams?.get('lang')?.toLowerCase();
    if (qLang === 'ar' || qLang === 'ary') {
      this.lang = 'ar';
    } else if (qLang === 'fr') {
      this.lang = 'fr';
    } else if (qLang === 'en') {
      this.lang = 'en';
    }
    this.seoPage = matchSeoPage(pathName);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = this.lang;
      document.documentElement.dir = this.lang === 'ar' ? 'rtl' : 'ltr';
    }
    applySeoHeadMetadata(this.seoPage, this.lang);
  }

  public mount(): void {
    this.registerPwaListeners();
    this.initBackgroundAudioElement();
    this.renderShell();
    this.mountVisualLayers();
    this.mascotStage?.applyCollectiveVisualStudy(this.collectiveBrain);
    this.initFirebaseAuthAndBrain();
    this.runHeroEntranceAnimation();
    void this.refreshDeviceLibrary();
    void this.reportSilentVisitEvent();

    const params =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const sharedRaw = [params?.get('url'), params?.get('text'), params?.get('title')]
      .filter(Boolean)
      .join(' ')
      .trim();
    const directUrl = sharedRaw ? extractUrlFromInput(sharedRaw) : null;
    if (directUrl) {
      this.searchQuery = directUrl;
      const inputEl = document.getElementById('bd-search-input') as HTMLInputElement | null;
      if (inputEl) inputEl.value = directUrl;
      void this.inspectUrl(directUrl);
      void this.performSearch(this.seoPage.sampleSearch || 'Daft Punk', this.searchFilter);
      return;
    }

    const initialQuery =
      (sharedRaw && !directUrl ? sharedRaw : '') || this.seoPage.sampleSearch || 'Daft Punk';
    this.searchQuery = initialQuery;
    const inputEl = document.getElementById('bd-search-input') as HTMLInputElement | null;
    if (inputEl) inputEl.value = initialQuery;
    void this.performSearch(initialQuery, this.searchFilter);
  }

  private async reportSilentVisitEvent(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      const formFactor =
        window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop';
      await reportEvolutionEvent({
        sourceUrl: window.location.href,
        platform: 'direct',
        kind: 'audio',
        title: `Device Visit (${formFactor}${this.isStandalone ? ' standalone' : ' web'})`,
        creator: navigator.platform || 'browser',
        durationSec: 0,
        transcriptExcerpt: `${this.seoPage.path} · lang=${this.lang} · cores=${navigator.hardwareConcurrency ?? 4}`,
        keywords: [formFactor, this.isStandalone ? 'installed-app' : 'web', this.seoPage.shortLabel],
        moodTags: ['Visit'],
        bpm: null,
        dominantColors: ['#111111', '#F4F03A'],
        safetyPassed: true,
        payloadBytes: 310,
        eventType: 'visit',
        accessNodeMode: 'server',
      });
    } catch {
      // Never block UI on background telemetry
    }
  }

  private initFirebaseAuthAndBrain(): void {
    this.unsubAuth?.();
    this.unsubAuth = subscribeAuthState((profile) => {
      const wasSignedOut = !this.currentUser;
      this.currentUser = profile;
      this.authResolvedOnce = true;

      if (profile) {
        this.authError = '';
        this.authGateOpen = false;
        this.renderTopbarNav();
        this.renderAuthGateModal();
        this.renderDownloadSection();

        if (wasSignedOut) {
          this.unsubBrain?.();
          this.unsubBrain = subscribeCollectiveKnowledge((study) => {
            this.collectiveBrain = study;
            this.mascotStage?.applyCollectiveVisualStudy(study);
          });

          void studyAvatarPixelsAndSave(profile).then((avatarStudy) => {
            if (avatarStudy) {
              this.mascotStage?.applyCollectiveVisualStudy(avatarStudy);
            }
          });

          void loadUserLibraryFromFirestore().then(async (remoteItems) => {
            if (remoteItems.length > 0) {
              const localIds = new Set(this.libraryItems.map((it) => it.id));
              for (const r of remoteItems) {
                if (!localIds.has(r.id)) {
                  await saveToDeviceLibrary(r);
                }
              }
              await this.refreshDeviceLibrary();
            }
          });
        }

        if (this.pendingAfterAuthAction) {
          const resume = this.pendingAfterAuthAction;
          this.pendingAfterAuthAction = null;
          void resume();
        }
      } else {
        this.unsubBrain?.();
        this.unsubBrain = null;
        this.renderTopbarNav();
        this.renderDownloadSection();
        // When launched as installed PWA app without an active Gmail session, greet user with Gmail Sign-In first
        if (this.isStandalone && this.authResolvedOnce) {
          this.authGateOpen = true;
          this.renderAuthGateModal();
        }
      }
    });
  }

  private requireGmailAuthThen(action: () => Promise<void> | void): void {
    if (this.currentUser) {
      void action();
      return;
    }
    this.pendingAfterAuthAction = action;
    this.authError = '';
    this.authGateOpen = true;
    this.renderAuthGateModal();
  }

  private async triggerGmailSignIn(): Promise<void> {
    if (this.authLoading) return;
    this.authLoading = true;
    this.authError = '';
    this.renderAuthGateModal();
    this.renderTopbarNav();
    try {
      const profile = await signInWithGmailPopup();
      this.currentUser = profile;
      this.authGateOpen = false;
    } catch (err) {
      this.authError =
        err instanceof Error
          ? err.message
          : 'Google / Gmail Sign-In was cancelled or blocked by popup blocker.';
    } finally {
      this.authLoading = false;
      this.renderAuthGateModal();
      this.renderTopbarNav();
    }
  }

  private async triggerClipBackgroundStudy(input: {
    title: string;
    creator: string;
    platform: string;
    kind: string;
    thumbnailUrl?: string;
    lyricsText?: string;
    bpm?: number | null;
  }): Promise<void> {
    try {
      let paletteHexes = this.clientAnalysis?.dominantColors;
      let depthRatio = 64;
      if (input.thumbnailUrl) {
        const studied = await analyzeImagePixelsAndDepth(input.thumbnailUrl);
        if (studied) {
          paletteHexes = studied.paletteHexes;
          depthRatio = studied.depthRatio;
        }
      }
      this.mascotStage?.applyCollectiveVisualStudy({
        paletteHexes: paletteHexes ?? this.collectiveBrain.paletteHexes,
        depthRatio,
      });
      await studyClipInBackground({
        studyType: input.lyricsText ? 'lyrics-fluency' : 'clip-study',
        platform: input.platform,
        clipType: input.kind,
        bpm: input.bpm ?? this.clientAnalysis?.bpm ?? null,
        depthRatio,
        paletteHexes: paletteHexes ?? this.collectiveBrain.paletteHexes,
        studySummary: `${input.platform.toUpperCase()} ${input.kind}: ${input.title.slice(0, 80)} (${input.creator.slice(0, 40)})`,
        lyricsSample: input.lyricsText ? input.lyricsText.slice(0, 260) : undefined,
      });
      this.collectiveBrain = loadLocalVisualBrain();
    } catch {
      // Never block or crash media playback on background study failure
    }
  }

  private registerPwaListeners(): void {
    if (typeof window === 'undefined') return;
    this.isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.renderDownloadSection();
      this.renderAppRail();
    });
    window.addEventListener('appinstalled', () => {
      this.isStandalone = true;
      this.deferredPrompt = null;
      this.installNotice = 'BLUEDROP installed on your device.';
      this.renderDownloadSection();
      this.renderAppRail();
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const winWithLaunch = window as unknown as {
      launchQueue?: {
        setConsumer: (
          cb: (launchParams: {
            files?: Array<{ getFile: () => Promise<File> }>;
          }) => void
        ) => void;
      };
    };
    if (winWithLaunch.launchQueue?.setConsumer) {
      winWithLaunch.launchQueue.setConsumer(async (launchParams) => {
        if (!launchParams.files || launchParams.files.length === 0) return;
        const resolvedFiles: File[] = [];
        for (const handle of launchParams.files) {
          try {
            resolvedFiles.push(await handle.getFile());
          } catch {
            // skip unreadable handle
          }
        }
        if (resolvedFiles.length > 0) {
          await this.handleFilesUploadedToLibrary(resolvedFiles);
        }
      });
    }
    window.addEventListener('popstate', () => {
      this.seoPage = matchSeoPage(window.location.pathname);
      applySeoHeadMetadata(this.seoPage);
      this.renderHeroSection();
      this.renderSubbar();
    });
  }

  private initBackgroundAudioElement(): void {
    if (typeof window === 'undefined' || this.bgAudio) return;
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';
    this.bgAudio = audio;

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        this.playerDurationSec = audio.duration;
        this.updatePlayerProgressDom();
      }
    });
    audio.addEventListener('timeupdate', () => {
      this.playerCurrentSec = audio.currentTime;
      this.updatePlayerProgressDom();
      this.syncActiveLyricHighlight();
      if ('mediaSession' in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(audio.currentTime, audio.duration),
          });
        } catch {
          // ignore
        }
      }
    });
    audio.addEventListener('play', () => {
      this.playerPlaying = true;
      this.mascotStage?.setAudioActive(true);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      this.renderMiniDock();
      this.renderNowPlayingSheet();
      this.renderResultsAndLibrary();
      this.syncPlayButtonLabel();
    });
    audio.addEventListener('pause', () => {
      this.playerPlaying = false;
      this.mascotStage?.setAudioActive(false);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      this.renderMiniDock();
      this.renderNowPlayingSheet();
      this.renderResultsAndLibrary();
      this.syncPlayButtonLabel();
    });
    audio.addEventListener('ended', () => {
      this.playerPlaying = false;
      this.mascotStage?.setAudioActive(false);
      this.playNextInQueue(1);
    });
  }

  private updateMediaSessionMetadata(title: string, creator: string, artworkUrl: string): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      const artwork = artworkUrl
        ? [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }]
        : [{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }];
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: creator,
        album: 'BLUEDROP Device Library',
        artwork,
      });
      navigator.mediaSession.setActionHandler('play', () => {
        void this.toggleActiveAudioPlayback();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        void this.toggleActiveAudioPlayback();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.playNextInQueue(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this.playNextInQueue(1);
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        if (this.bgAudio) this.bgAudio.currentTime = Math.max(0, this.bgAudio.currentTime - 10);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        if (this.bgAudio) {
          this.bgAudio.currentTime = Math.min(
            this.bgAudio.duration || 99999,
            this.bgAudio.currentTime + 10
          );
        }
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (this.bgAudio && typeof details.seekTime === 'number') {
          this.bgAudio.currentTime = details.seekTime;
        }
      });
    } catch {
      // MediaSession not supported in this browser
    }
  }

  private pickQueueIndex(len: number, currentIdx: number, direction: 1 | -1): number {
    if (len <= 1) return 0;
    if (this.playOrderMode === 'shuffle') {
      let randIdx = Math.floor(Math.random() * len);
      if (randIdx === currentIdx) {
        randIdx = (currentIdx + 1 + Math.floor(Math.random() * (len - 1))) % len;
      }
      return randIdx;
    }
    return currentIdx < 0 ? 0 : (currentIdx + direction + len) % len;
  }

  private async playNextInQueue(direction: 1 | -1): Promise<void> {
    const libPlayable = this.getFilteredLibraryItems().filter(
      (it) => Boolean(it.localBlob || it.streamUrl || it.directAudioUrl || it.directVideoUrl)
    );
    const currentId = this.activeBgTrack?.id;
    const playingFromLibrary =
      this.resultsTab === 'library' || this.libraryItems.some((it) => it.id === currentId);

    if (libPlayable.length > 0 && playingFromLibrary) {
      const idx = libPlayable.findIndex((it) => it.id === currentId);
      const nextIdx = this.pickQueueIndex(libPlayable.length, idx, direction);
      const nextItem = libPlayable[nextIdx];
      if (nextItem) {
        await this.playLibraryItemInBackground(nextItem);
        return;
      }
    }
    if (this.searchResults.length > 0) {
      const idx = this.searchResults.findIndex((it) => it.id === currentId);
      const nextIdx = this.pickQueueIndex(this.searchResults.length, idx, direction);
      const nextLive = this.searchResults[nextIdx];
      if (nextLive) {
        await this.playLiveSearchItem(nextLive);
        return;
      }
    }
    if (libPlayable.length > 0) {
      const nextIdx = this.pickQueueIndex(libPlayable.length, -1, direction);
      const nextItem = libPlayable[nextIdx];
      if (nextItem) await this.playLibraryItemInBackground(nextItem);
    }
  }

  private stripThinkingTextClient(raw: string): string {
    return raw
      .replace(/<(think|thought|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(think|thought|thinking|reasoning|analysis)>[\s\S]*$/gi, '')
      .replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/gm, '')
      .replace(/```$/gm, '')
      .trim();
  }

  private async fetchLyricsForTrack(
    title: string,
    creator: string,
    initialLyrics?: { text?: string; synced?: Array<{ timeSec: number; line: string }>; source?: string },
    itemId?: string
  ): Promise<void> {
    const trackKey = `${title}::${creator}`.toLowerCase();
    this.lyricsTranslation = '';
    if (initialLyrics?.text) {
      const cleanInit = this.stripThinkingTextClient(initialLyrics.text);
      this.activeLyrics = {
        trackKey,
        text: cleanInit,
        synced: initialLyrics.synced,
        source: initialLyrics.source,
        loading: false,
      };
      this.renderLyricsPanels();
      return;
    }
    this.activeLyrics = { trackKey, loading: true };
    this.renderLyricsPanels();
    try {
      const resp = await fetch(
        `/api/media/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(creator)}`
      );
      if (!resp.ok) throw new Error('Lyrics unavailable');
      const data = (await resp.json()) as {
        lyricsText?: string;
        lyricsSynced?: Array<{ timeSec: number; line: string }>;
        lyricsSource?: string;
      };
      if (this.activeLyrics?.trackKey !== trackKey) return;
      const cleanText = data.lyricsText ? this.stripThinkingTextClient(data.lyricsText) : undefined;
      this.activeLyrics = {
        trackKey,
        text: cleanText,
        synced: data.lyricsSynced,
        source: data.lyricsSource,
        loading: false,
      };
      if (cleanText && itemId) {
        await updateDeviceLibraryItem(itemId, { lyricsText: cleanText });
        await this.refreshDeviceLibrary();
      } else if (!cleanText) {
        const hasAudioOrCaptions = Boolean(
          this.inspectedMedia?.directAudioUrl ||
            this.inspectedMedia?.previewStreamUrl ||
            this.inspectedMedia?.transcriptText?.trim() ||
            (this.activeBgTrack?.src && this.activeBgTrack.src.startsWith('http'))
        );
        if (hasAudioOrCaptions) {
          this.renderLyricsPanels();
          void this.extractPureLyricsWithAi();
          return;
        }
      }
    } catch {
      if (this.activeLyrics?.trackKey !== trackKey) return;
      this.activeLyrics = { trackKey, loading: false };
    }
    this.renderLyricsPanels();
  }

  private async extractPureLyricsWithAi(): Promise<void> {
    if (this.extractingLyrics) return;
    const title = this.activeBgTrack?.title || this.inspectedMedia?.title || 'Track';
    const creator = this.activeBgTrack?.creator || this.inspectedMedia?.creator || 'Artist';
    const trackKey = `${title}::${creator}`.toLowerCase();
    const audioUrl =
      this.inspectedMedia?.directAudioUrl ||
      (this.activeBgTrack?.src && this.activeBgTrack.src.startsWith('http')
        ? this.activeBgTrack.src
        : undefined) ||
      this.inspectedMedia?.previewStreamUrl ||
      this.inspectedMedia?.directVideoUrl;

    this.extractingLyrics = true;
    this.renderLyricsPanels();
    try {
      const resp = await fetch('/api/ai-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'lyrics',
          targetLang: this.aiLang,
          media: {
            title,
            creator,
            platform: this.inspectedMedia?.platform || this.activeBgTrack?.platform || 'direct',
            sourceUrl: this.inspectedMedia?.sourceUrl || this.activeBgTrack?.sourceUrl || 'https://bluedrop.studio',
            audioUrl,
            transcriptText: this.inspectedMedia?.transcriptText || '',
            durationSec: this.inspectedMedia?.durationSec || this.playerDurationSec || 0,
          },
        }),
      });
      const data = (await resp.json()) as AiMediaResponse;
      const cleanText = this.stripThinkingTextClient(data.content || '');
      if (cleanText && !/^No sung lyrics found/i.test(cleanText)) {
        this.activeLyrics = {
          trackKey,
          text: cleanText,
          source: 'Pure Vocal Lyrics',
          loading: false,
        };
        const targetId = this.inspectedMedia?.id || this.activeBgTrack?.id;
        if (this.inspectedMedia && this.inspectedMedia.id === targetId) {
          this.inspectedMedia.lyricsText = cleanText;
        }
        if (targetId) {
          await updateDeviceLibraryItem(targetId, { lyricsText: cleanText });
          await this.refreshDeviceLibrary();
        }
      } else {
        this.activeLyrics = {
          trackKey,
          text: cleanText || 'No sung lyrics found for this clip.',
          source: undefined,
          loading: false,
        };
      }
    } catch {
      // keep existing lyrics state cleanly
    } finally {
      this.extractingLyrics = false;
      this.renderLyricsPanels();
    }
  }

  private async playLiveSearchItem(item: MediaSearchItem): Promise<void> {
    this.initBackgroundAudioElement();
    if (!this.bgAudio) return;

    const preview = item.previewStreamUrl;
    if (preview) {
      this.activeBgTrack = {
        id: item.id,
        title: item.title,
        creator: item.creator,
        src: preview,
        artwork: item.thumbnailUrl || '/pwa-512x512.png',
        sourceUrl: item.sourceUrl,
        platform: item.platform,
        kind: item.kind,
        durationLabel: item.durationLabel,
      };
      this.bgAudio.src = preview;
      this.playerDurationSec = item.durationSec || 30;
      this.playerCurrentSec = 0;
      this.stemController.attach(this.bgAudio);
      this.updateMediaSessionMetadata(item.title, item.creator, item.thumbnailUrl || '');
      this.renderMiniDock();
      this.renderResultsAndLibrary();
      this.renderNowPlayingSheet();
      void this.bgAudio.play().catch(() => {});
      void this.fetchLyricsForTrack(item.title, item.creator);
      void this.triggerClipBackgroundStudy({
        title: item.title,
        creator: item.creator,
        platform: item.platform,
        kind: item.kind,
        thumbnailUrl: item.thumbnailUrl,
      });
      void this.inspectUrl(item.sourceUrl, item, { keepSheetState: true, skipScroll: true });
      return;
    }

    // No direct preview yet -> inspect & auto-play resolved stream
    this.activeBgTrack = {
      id: item.id,
      title: item.title,
      creator: item.creator,
      src: '',
      artwork: item.thumbnailUrl || '/pwa-512x512.png',
      sourceUrl: item.sourceUrl,
      platform: item.platform,
      kind: item.kind,
      durationLabel: item.durationLabel,
    };
    this.renderMiniDock();
    this.renderResultsAndLibrary();
    void this.fetchLyricsForTrack(item.title, item.creator);
    await this.inspectUrl(item.sourceUrl, item, { autoPlay: true, keepSheetState: true });
  }

  private async playLibraryItemInBackground(item: DeviceLibraryItem): Promise<void> {
    this.initBackgroundAudioElement();
    if (!this.bgAudio) return;

    let playSrc = item.streamUrl || '';
    if (item.localBlob) {
      playSrc = URL.createObjectURL(item.localBlob);
      this.blobUrlPool.push(playSrc);
    }
    if (!playSrc) {
      this.activeBgTrack = {
        id: item.id,
        title: item.title,
        creator: item.creator,
        src: '',
        artwork: item.thumbnailUrl || '/pwa-512x512.png',
        sourceUrl: item.sourceUrl,
        platform: item.platform,
        kind: item.kind,
        durationLabel: item.durationLabel,
      };
      this.renderMiniDock();
      this.renderResultsAndLibrary();
      await this.inspectUrl(item.sourceUrl, undefined, { autoPlay: true, keepSheetState: true });
      return;
    }

    this.activeBgTrack = {
      id: item.id,
      title: item.title,
      creator: item.creator,
      src: playSrc,
      artwork: item.thumbnailUrl || '/pwa-512x512.png',
      sourceUrl: item.sourceUrl,
      platform: item.platform,
      kind: item.kind,
      durationLabel: item.durationLabel,
    };
    this.bgAudio.src = playSrc;
    this.playerDurationSec = item.durationSec || 30;
    this.playerCurrentSec = 0;
    this.stemController.attach(this.bgAudio);
    this.updateMediaSessionMetadata(item.title, item.creator, item.thumbnailUrl || '');
    this.renderMiniDock();
    this.renderResultsAndLibrary();
    this.renderNowPlayingSheet();
    await this.bgAudio.play().catch(() => {});
    void this.triggerClipBackgroundStudy({
      title: item.title,
      creator: item.creator,
      platform: item.platform,
      kind: item.kind,
      thumbnailUrl: item.thumbnailUrl,
      lyricsText: item.lyricsText,
    });
    void this.fetchLyricsForTrack(
      item.title,
      item.creator,
      item.lyricsText ? { text: item.lyricsText } : undefined
    );
  }

  private async toggleActiveAudioPlayback(): Promise<void> {
    const videoEl = document.getElementById('bd-preview-video') as HTMLVideoElement | null;
    if (videoEl && !this.playerSheetExpanded) {
      if (videoEl.paused) {
        await videoEl.play().catch(() => {});
        this.playerPlaying = true;
      } else {
        videoEl.pause();
        this.playerPlaying = false;
      }
      this.mascotStage?.setAudioActive(this.playerPlaying);
      this.syncPlayButtonLabel();
      this.renderMiniDock();
      this.renderResultsAndLibrary();
      return;
    }

    if (this.bgAudio && (this.activeBgTrack?.src || this.inspectedMedia?.previewStreamUrl)) {
      if (!this.activeBgTrack?.src && this.inspectedMedia?.previewStreamUrl) {
        this.activeBgTrack = {
          id: this.inspectedMedia.id,
          title: this.inspectedMedia.title,
          creator: this.inspectedMedia.creator,
          src: this.inspectedMedia.previewStreamUrl,
          artwork: this.inspectedMedia.thumbnailUrl || '/pwa-512x512.png',
          sourceUrl: this.inspectedMedia.sourceUrl,
          platform: this.inspectedMedia.platform,
          kind: this.inspectedMedia.kind,
          durationLabel: this.inspectedMedia.durationLabel,
        };
        this.bgAudio.src = this.inspectedMedia.previewStreamUrl;
        this.stemController.attach(this.bgAudio);
        this.updateMediaSessionMetadata(
          this.inspectedMedia.title,
          this.inspectedMedia.creator,
          this.inspectedMedia.thumbnailUrl || ''
        );
      }
      if (this.bgAudio.paused) {
        await this.bgAudio.play().catch(() => {});
      } else {
        this.bgAudio.pause();
      }
    }
  }

  private syncPlayButtonLabel(): void {
    const btn = document.getElementById('bd-player-toggle');
    if (btn) btn.textContent = this.playerPlaying ? 'PAUSE' : 'PLAY';
    const sheetBtn = document.getElementById('bd-sheet-play-toggle');
    if (sheetBtn) sheetBtn.textContent = this.playerPlaying ? 'PAUSE' : 'PLAY';
  }

  private updatePlayerProgressDom(): void {
    const dur = this.playerDurationSec || 30;
    const pct = Math.min(100, (this.playerCurrentSec / dur) * 100);
    const fillEl = document.getElementById('bd-player-fill');
    const timeEl = document.getElementById('bd-player-time');
    const miniFillEl = document.getElementById('bd-mini-progress-fill');
    const sheetFillEl = document.getElementById('bd-sheet-player-fill');
    const sheetTimeEl = document.getElementById('bd-sheet-player-time');
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (miniFillEl) miniFillEl.style.width = `${pct}%`;
    if (sheetFillEl) sheetFillEl.style.width = `${pct}%`;
    const clockStr = `${formatClock(this.playerCurrentSec)} / ${formatClock(dur)}`;
    if (timeEl) timeEl.textContent = clockStr;
    if (sheetTimeEl) sheetTimeEl.textContent = clockStr;
  }

  private syncActiveLyricHighlight(): void {
    const synced = this.activeLyrics?.synced;
    if (!synced || synced.length === 0) return;
    let activeIdx = -1;
    for (let i = 0; i < synced.length; i += 1) {
      if (synced[i]!.timeSec <= this.playerCurrentSec + 0.35) {
        activeIdx = i;
      } else {
        break;
      }
    }
    this.root.querySelectorAll<HTMLElement>('[data-lyric-idx]').forEach((el) => {
      const idx = Number.parseInt(el.dataset.lyricIdx ?? '-1', 10);
      el.classList.toggle('active', idx === activeIdx);
    });
  }

  private async refreshDeviceLibrary(): Promise<void> {
    const [items, storage] = await Promise.all([
      listDeviceLibrary(),
      getDeviceStorageUsageSummary(),
    ]);
    this.libraryItems = items;
    this.saveFolders = listSaveFolders();
    this.deviceUsedMb = storage.usedMb;
    this.renderResultsAndLibrary();
    this.renderAppRail();
    const vaultVal = document.getElementById('bd-hero-vault-val');
    if (vaultVal) {
      vaultVal.textContent = `${this.libraryItems.length} SAVED · ${this.deviceUsedMb} MB`;
    }
  }

  private isSavedOnDevice(id: string, sourceUrl?: string): DeviceLibraryItem | undefined {
    return this.libraryItems.find(
      (it) => it.id === id || (sourceUrl && it.sourceUrl === sourceUrl)
    );
  }

  private getFilteredLibraryItems(ignoreArtist = false): DeviceLibraryItem[] {
    const q = this.librarySearchQuery.trim().toLowerCase();
    const artistLower = this.selectedArtistFilter.trim().toLowerCase();
    return this.libraryItems.filter((item) => {
      if (this.isolatedOnly && !item.isolated) return false;
      if (this.libraryCategoryFilter !== 'all' && item.category !== this.libraryCategoryFilter) {
        return false;
      }
      if (
        this.libraryFolderFilter !== 'all' &&
        (item.folderName || 'Favorites').toLowerCase() !== this.libraryFolderFilter.toLowerCase()
      ) {
        return false;
      }
      if (
        !ignoreArtist &&
        artistLower !== 'all' &&
        item.creator.trim().toLowerCase() !== artistLower
      ) {
        return false;
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.creator.toLowerCase().includes(q) ||
        item.albumOrTag.toLowerCase().includes(q) ||
        (item.folderName || '').toLowerCase().includes(q) ||
        item.platform.toLowerCase().includes(q)
      );
    });
  }

  private getAvailableLibraryArtists(): Array<{ name: string; count: number }> {
    const basePool = this.getFilteredLibraryItems(true);
    const counts = new Map<string, { name: string; count: number }>();
    for (const item of basePool) {
      const raw = (item.creator || '').trim();
      if (!raw || raw.length < 2) continue;
      const key = raw.toLowerCase();
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { name: raw, count: 1 });
      }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private setLanguage(lang: UiLang): void {
    this.lang = lang;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }
    applySeoHeadMetadata(this.seoPage, lang);
    const appEl = document.getElementById('bd-app-root');
    if (appEl) appEl.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    this.renderTopbarNav();
    this.renderAppRail();
    this.renderMobileBottomNav();
    this.renderSubbar();
    this.renderHeroSection();
    this.renderInspectorSection();
    this.renderResultsAndLibrary();
    this.renderConverterSection();
    this.renderDownloadSection();
    this.renderFooterSection();
    this.syncMascotCaption();
  }

  private navigateSeoRoute(page: SeoRoutePage): void {
    this.seoPage = page;
    applySeoHeadMetadata(page, this.lang);
    if (typeof window !== 'undefined' && window.location.pathname !== page.path) {
      const nextUrl = this.lang === 'en' ? page.path : `${page.path}?lang=${this.lang}`;
      window.history.pushState({}, '', nextUrl);
    }
    this.renderSubbar();
    this.renderHeroSection();
    if (page.path === '/download') {
      document.getElementById('download-section')?.scrollIntoView({ behavior: 'smooth' });
    } else if (page.path === '/music-player') {
      this.searchFilter = 'music';
      this.renderHeroSection();
    }
  }

  private async handleSearchOrUrlSubmit(rawInput: string): Promise<void> {
    const val = rawInput.trim();
    if (!val) return;
    this.searchQuery = val;
    const extractedUrl = extractUrlFromInput(val);
    if (extractedUrl) {
      if (typeof window !== 'undefined') {
        const u = new URL(window.location.href);
        u.searchParams.set('url', extractedUrl);
        window.history.replaceState({}, '', u.toString());
      }
      await this.inspectUrl(extractedUrl);
    } else {
      this.resultsTab = 'live';
      await this.performSearch(val, this.searchFilter);
    }
  }

  private async performSearch(query: string, type: 'all' | 'music' | 'video'): Promise<void> {
    this.searching = true;
    this.searchError = '';
    this.renderSearchButtonState();
    this.renderResultsAndLibrary();
    void reportEvolutionEvent({
      sourceUrl: typeof window !== 'undefined' ? window.location.href : 'https://bluedrop.studio',
      platform: 'direct',
      kind: type === 'music' ? 'audio' : 'video',
      title: query,
      creator: 'search-query',
      durationSec: 0,
      transcriptExcerpt: `Search: ${query} (${type})`,
      keywords: [query, type],
      moodTags: ['Search'],
      bpm: null,
      dominantColors: ['#111111', '#F4F03A'],
      safetyPassed: true,
      payloadBytes: 280,
      eventType: 'search',
      accessNodeMode: 'server',
    }).catch(() => {});
    try {
      const resp = await fetch(
        `/api/media/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`
      );
      const data = (await resp.json()) as {
        ok?: boolean;
        items?: MediaSearchItem[];
        error?: string;
      };
      if (!resp.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || 'Search unavailable.');
      }
      this.searchResults = data.items;
      if (data.items.length === 0) {
        this.searchError = 'No matches found. Try another keyword or paste a direct URL.';
      }
    } catch (err) {
      this.searchError = err instanceof Error ? err.message : 'Search failed.';
    } finally {
      this.searching = false;
      this.renderSearchButtonState();
      this.renderErrorBanner();
      this.renderResultsAndLibrary();
    }
  }

  private async inspectUrl(
    url: string,
    fallbackItem?: MediaSearchItem,
    opts?: { autoPlay?: boolean; keepSheetState?: boolean; skipScroll?: boolean }
  ): Promise<void> {
    this.inspecting = true;
    this.inspectingUrlLabel = url;
    this.searchError = '';
    this.downloadStatusMsg = '';
    this.clientAnalysis = null;
    this.capturedKeyframes = [];
    this.deviceEdgeNode = 'probing';
    this.stemController = new ClientAudioStemController();
    this.stemMode = 'full';
    this.renderSearchButtonState();
    this.renderErrorBanner();
    this.renderInspectorSection();

    if (!opts?.skipScroll) {
      document
        .getElementById('bd-inspector-slot')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    try {
      const resp = await fetch('/api/media/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        media?: MediaInspectResult;
        error?: string;
      };
      if (!resp.ok || !data.media) {
        throw new Error(data.error || 'Failed to inspect URL.');
      }

      if (fallbackItem) {
        data.media.id = fallbackItem.id || data.media.id;
        if (fallbackItem.title) data.media.title = fallbackItem.title;
        if (fallbackItem.creator) data.media.creator = fallbackItem.creator;
        if (fallbackItem.thumbnailUrl) data.media.thumbnailUrl = fallbackItem.thumbnailUrl;
        if (fallbackItem.durationSec > 0) {
          data.media.durationSec = fallbackItem.durationSec;
          data.media.durationLabel = fallbackItem.durationLabel;
        }
        if (fallbackItem.previewStreamUrl && !data.media.previewStreamUrl) {
          data.media.previewStreamUrl = fallbackItem.previewStreamUrl;
        }
        if (
          data.media.thumbnailUrl &&
          !data.media.formats.some((f) => f.category === 'image')
        ) {
          data.media.formats.push(
            {
              id: 'png',
              label: 'PNG · Cover Art',
              ext: 'png',
              category: 'image',
              quality: 'Original',
              codec: 'PNG-24',
              available: true,
            },
            {
              id: 'jpg',
              label: 'JPG · Cover Art HD',
              ext: 'jpg',
              category: 'image',
              quality: '95% Q',
              codec: 'JPEG',
              available: true,
            },
            {
              id: 'webp',
              label: 'WEBP · Ultra Light',
              ext: 'webp',
              category: 'image',
              quality: '90% Q',
              codec: 'WebP',
              available: true,
            }
          );
        }
      }

      this.inspectedMedia = data.media;
      this.playerDurationSec = data.media.durationSec || 30;
      this.inspecting = false;
      this.inspectingUrlLabel = '';
      this.renderSearchButtonState();
      this.renderInspectorSection();

      // Auto-save every pasted / inspected link with complete video, audio, cover, and metadata into DeviceLibrary
      const existingLib = this.isSavedOnDevice(data.media.id, data.media.sourceUrl);
      const defaultFolder = data.media.kind === 'audio' ? 'Music' : 'Reels & Video';
      const targetFolder = existingLib?.folderName || defaultFolder;
      const targetCategory = inferCategoryFromFolder(targetFolder, data.media.kind);
      const primaryStream =
        data.media.directAudioUrl || data.media.directVideoUrl || data.media.previewStreamUrl;

      await saveToDeviceLibrary({
        id: data.media.id,
        title: data.media.title,
        creator: data.media.creator,
        platform: data.media.platform,
        kind: data.media.kind,
        category: targetCategory,
        folderName: targetFolder,
        albumOrTag: existingLib?.albumOrTag || data.media.platform.toUpperCase(),
        durationSec: data.media.durationSec,
        durationLabel: data.media.durationLabel,
        sourceUrl: data.media.sourceUrl,
        streamUrl: primaryStream || existingLib?.streamUrl,
        directVideoUrl: data.media.directVideoUrl || existingLib?.directVideoUrl,
        directAudioUrl: data.media.directAudioUrl || existingLib?.directAudioUrl,
        embedPlayerUrl: data.media.embedPlayerUrl || existingLib?.embedPlayerUrl,
        thumbnailUrl: data.media.thumbnailUrl || existingLib?.thumbnailUrl,
        description: data.media.description || existingLib?.description,
        keywords: data.media.keywords,
        transcriptText: data.media.transcriptText || existingLib?.transcriptText,
        extractorNote: data.media.extractorNote,
        lyricsText: data.media.lyricsText || existingLib?.lyricsText,
        localBlob: existingLib?.localBlob,
        mimeType: existingLib?.mimeType,
        fileSizeBytes: existingLib?.fileSizeBytes,
        savedAt: existingLib?.savedAt || new Date().toISOString(),
        isolated: existingLib?.isolated,
      });
      await this.refreshDeviceLibrary();
      this.renderInspectorSection();

      void this.fetchLyricsForTrack(
        data.media.title,
        data.media.creator,
        data.media.lyricsText
          ? {
              text: data.media.lyricsText,
              synced: data.media.lyricsSynced,
              source: data.media.lyricsSource,
            }
          : existingLib?.lyricsText
            ? { text: existingLib.lyricsText, source: 'Saved Lyrics' }
            : undefined,
        data.media.id
      );

      if (opts?.autoPlay && (data.media.previewStreamUrl || data.media.directAudioUrl)) {
        const src = data.media.directAudioUrl || data.media.previewStreamUrl || '';
        if (src) {
          this.initBackgroundAudioElement();
          this.activeBgTrack = {
            id: data.media.id,
            title: data.media.title,
            creator: data.media.creator,
            src,
            artwork: data.media.thumbnailUrl || '/pwa-512x512.png',
            sourceUrl: data.media.sourceUrl,
            platform: data.media.platform,
            kind: data.media.kind,
            durationLabel: data.media.durationLabel,
          };
          if (this.bgAudio) {
            this.bgAudio.src = src;
            this.stemController.attach(this.bgAudio);
            this.updateMediaSessionMetadata(
              data.media.title,
              data.media.creator,
              data.media.thumbnailUrl || ''
            );
            void this.bgAudio.play().catch(() => {});
          }
          this.renderMiniDock();
          this.renderNowPlayingSheet();
        }
      }

      if (!opts?.skipScroll) {
        document
          .getElementById('inspector-stage')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // 1. User Device acts as Residential Access Node if server lacks direct stream
      let accessNodeMode: 'server' | 'client-edge' = 'server';
      if (!data.media.directVideoUrl && !data.media.directAudioUrl) {
        const edge = await resolveStreamFromDeviceEdge(data.media);
        this.deviceEdgeNode = edge.nodeLabel;
        if (edge.resolvedOnDevice && (edge.directVideoUrl || edge.directAudioUrl)) {
          accessNodeMode = 'client-edge';
          data.media.directVideoUrl = edge.directVideoUrl || data.media.directVideoUrl;
          data.media.directAudioUrl = edge.directAudioUrl || data.media.directAudioUrl;
          data.media.previewStreamUrl =
            edge.directAudioUrl || edge.directVideoUrl || data.media.previewStreamUrl;
          if (edge.durationSec && edge.durationSec > 0) {
            data.media.durationSec = edge.durationSec;
          }
          data.media.extractorNote = `Resolved via user device edge node (${edge.nodeLabel})`;
          this.inspectedMedia = data.media;
          await updateDeviceLibraryItem(data.media.id, {
            streamUrl: data.media.directAudioUrl || data.media.directVideoUrl || data.media.previewStreamUrl,
            directVideoUrl: data.media.directVideoUrl,
            directAudioUrl: data.media.directAudioUrl,
            durationSec: data.media.durationSec,
            durationLabel: data.media.durationLabel,
            extractorNote: data.media.extractorNote,
          });
          await this.refreshDeviceLibrary();
          this.renderInspectorSection();
        }
      } else {
        this.deviceEdgeNode = 'server+device-body';
      }

      // 2. Client Device Body perceives keyframes + audio BPM/RMS + saves local memory + syncs silently
      const analyzed = await runClientMediaAnalysisAndSync(data.media, {
        accessNodeMode,
        eventType: 'inspect',
      });
      this.clientAnalysis = analyzed.analysis;
      this.capturedKeyframes = analyzed.keyframes;
      void getEmbodiedDeviceMemoryCount().catch(() => 0);

      // 3. Feed silent background visual/pixel study & watch perception (zero UI output)
      void this.triggerClipBackgroundStudy({
        title: data.media.title,
        creator: data.media.creator,
        platform: data.media.platform,
        kind: data.media.kind,
        thumbnailUrl: data.media.thumbnailUrl,
        lyricsText: data.media.lyricsText,
        bpm: analyzed.analysis.bpm,
      });
      void this.runSilentBackgroundWatch();
    } catch (err) {
      this.inspecting = false;
      this.inspectingUrlLabel = '';
      this.searchError = err instanceof Error ? err.message : 'Could not inspect URL.';
      this.renderSearchButtonState();
      this.renderErrorBanner();
      this.renderInspectorSection();
    }
  }

  private async handleFormatDownload(format: FormatOption): Promise<void> {
    if (!this.currentUser) {
      this.requireGmailAuthThen(() => this.handleFormatDownload(format));
      return;
    }
    const media = this.inspectedMedia;
    if (!media || this.downloadBusyFormat) return;
    const copy = UI_COPY[this.lang];

    const recordDownloadEvolution = () => {
      void reportEvolutionEvent({
        sourceUrl: media.sourceUrl,
        platform: media.platform,
        kind: media.kind,
        title: media.title,
        creator: media.creator,
        durationSec: media.durationSec,
        transcriptExcerpt: (media.transcriptText || media.description || media.title).slice(0, 400),
        keywords: this.clientAnalysis?.keywords ?? media.keywords.slice(0, 6),
        moodTags: this.clientAnalysis?.moodTags ?? ['Downloaded'],
        bpm: this.clientAnalysis?.bpm ?? null,
        dominantColors: this.clientAnalysis?.dominantColors ?? ['#111111', '#F4F03A'],
        safetyPassed: true,
        payloadBytes: 420,
        eventType: 'download',
        chosenFormat: format.id,
        accessNodeMode: this.deviceEdgeNode.startsWith('device-edge') ? 'client-edge' : 'server',
        visualFrameCount: this.capturedKeyframes.length,
      }).catch(() => {});

      if (!this.activeLyrics?.text || /^No sung lyrics found/i.test(this.activeLyrics.text)) {
        void this.fetchLyricsForTrack(media.title, media.creator, undefined, media.id);
      }

      const existingLib = this.isSavedOnDevice(media.id, media.sourceUrl);
      const targetFolder =
        existingLib?.folderName || (format.category === 'audio' ? 'Music' : 'Reels & Video');
      const targetCategory = inferCategoryFromFolder(
        targetFolder,
        format.category === 'audio' ? 'audio' : media.kind
      );

      const libItem = {
        id: media.id,
        title: media.title,
        creator: media.creator,
        platform: media.platform,
        kind: (format.category === 'audio' ? 'audio' : media.kind) as 'video' | 'audio' | 'image',
        category: targetCategory,
        folderName: targetFolder,
        albumOrTag: `${format.ext.toUpperCase()} · ${media.platform.toUpperCase()}`,
        durationSec: media.durationSec,
        durationLabel: media.durationLabel,
        sourceUrl: media.sourceUrl,
        streamUrl: media.directAudioUrl || media.directVideoUrl || media.previewStreamUrl,
        directVideoUrl: media.directVideoUrl,
        directAudioUrl: media.directAudioUrl,
        embedPlayerUrl: media.embedPlayerUrl,
        thumbnailUrl: media.thumbnailUrl,
        description: media.description,
        keywords: media.keywords,
        transcriptText: media.transcriptText,
        extractorNote: media.extractorNote,
        lyricsText: existingLib?.lyricsText || media.lyricsText,
        savedAt: existingLib?.savedAt || new Date().toISOString(),
        isolated: existingLib?.isolated,
      };
      void saveToDeviceLibrary(libItem).then(() => this.refreshDeviceLibrary());
      void syncLibraryItemToFirestore(libItem);
    };

    if (format.id === 'txt' || format.id === 'srt') {
      const safeName =
        media.title.replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_').slice(0, 60) || 'transcript';
      if (format.id === 'txt') {
        const txt = `${media.title} — ${media.creator}\n${media.sourceUrl}\n\n${media.transcriptText || media.description}`;
        triggerBlobDownload(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${safeName}.txt`);
      } else {
        const srt =
          media.transcriptSegments.length > 0
            ? media.transcriptSegments
                .map((seg, i) => {
                  const nextStart = media.transcriptSegments[i + 1]?.startSec ?? seg.startSec + 3;
                  return `${i + 1}\n${formatSrtTimestamp(seg.startSec)} --> ${formatSrtTimestamp(nextStart)}\n${seg.text}\n`;
                })
                .join('\n')
            : `1\n00:00:00,000 --> 00:00:05,000\n${media.title}\n`;
        triggerBlobDownload(new Blob([srt], { type: 'text/plain;charset=utf-8' }), `${safeName}.srt`);
      }
      recordDownloadEvolution();
      this.downloadStatusMsg = `${copy.downloadReady} (${format.ext.toUpperCase()})`;
      this.updateDownloadUi();
      return;
    }

    let targetStream = '';
    if (format.category === 'image') {
      targetStream = media.thumbnailUrl;
    } else if (format.category === 'audio') {
      targetStream = media.directAudioUrl || media.previewStreamUrl || media.directVideoUrl || '';
    } else {
      targetStream = media.directVideoUrl || media.previewStreamUrl || '';
    }

    // Attempt live browser-IP residential edge resolution before reporting blocked stream
    if (!targetStream && format.category !== 'image') {
      this.downloadBusyFormat = format.id;
      this.downloadProgressPct = 15;
      this.downloadStatusMsg = 'Resolving direct video/audio stream via your device node...';
      this.updateDownloadUi();
      const edge = await resolveStreamFromDeviceEdge(media).catch(() => null);
      if (edge?.resolvedOnDevice && (edge.directVideoUrl || edge.directAudioUrl)) {
        this.deviceEdgeNode = edge.nodeLabel;
        media.directVideoUrl = edge.directVideoUrl || media.directVideoUrl;
        media.directAudioUrl = edge.directAudioUrl || media.directAudioUrl;
        media.previewStreamUrl =
          edge.directAudioUrl || edge.directVideoUrl || media.previewStreamUrl;
        targetStream =
          format.category === 'audio'
            ? media.directAudioUrl || media.previewStreamUrl || media.directVideoUrl || ''
            : media.directVideoUrl || media.previewStreamUrl || '';
        await updateDeviceLibraryItem(media.id, {
          streamUrl: media.directAudioUrl || media.directVideoUrl || media.previewStreamUrl,
          directVideoUrl: media.directVideoUrl,
          directAudioUrl: media.directAudioUrl,
        });
        await this.refreshDeviceLibrary();
      }
      this.downloadBusyFormat = null;
    }

    if (!targetStream) {
      this.downloadStatusMsg =
        format.category === 'image'
          ? 'No cover image published by this source.'
          : 'Direct video/audio stream is DRM or login-gated by source host. Use Cover Art (PNG/JPG) explicitly if you only want the thumbnail, or try Local Studio.';
      this.updateDownloadUi();
      return;
    }

    this.downloadBusyFormat = format.id;
    this.downloadProgressPct = 24;
    this.downloadStatusMsg = copy.preparingStream;
    this.updateDownloadUi();

    try {
      const dlUrl = `/api/media/download?streamUrl=${encodeURIComponent(targetStream)}&format=${encodeURIComponent(format.id)}&title=${encodeURIComponent(media.title)}&artist=${encodeURIComponent(media.creator)}`;
      const preflight = await fetch(dlUrl, { method: 'HEAD' });
      if (!preflight.ok) {
        if (this.deviceEdgeNode.startsWith('device-edge')) {
          const safeName =
            media.title.replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_').slice(0, 60) || 'bluedrop';
          const directAnchor = document.createElement('a');
          directAnchor.href = targetStream;
          directAnchor.target = '_blank';
          directAnchor.rel = 'noopener noreferrer';
          directAnchor.download = `${safeName}.${format.ext}`;
          document.body.appendChild(directAnchor);
          directAnchor.click();
          directAnchor.remove();
          recordDownloadEvolution();
          this.downloadProgressPct = 100;
          this.downloadStatusMsg = `${copy.downloadReady} via Device Edge Stream (${format.label})`;
          return;
        }
        throw new Error(`Stream source refused connection (HTTP ${preflight.status}).`);
      }

      this.downloadProgressPct = 78;
      this.downloadStatusMsg = `Streaming ${format.label} directly to your device...`;
      this.updateDownloadUi();

      const safeName =
        media.title.replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_').slice(0, 60) || 'bluedrop';
      const anchor = document.createElement('a');
      anchor.href = dlUrl;
      anchor.download = `${safeName}.${format.ext}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      recordDownloadEvolution();
      this.downloadProgressPct = 100;
      this.downloadStatusMsg = `${copy.downloadReady} (${format.label}) — Saved via HTTP Stream`;
    } catch (err) {
      this.downloadStatusMsg =
        err instanceof Error ? err.message : 'Stream download failed. Try PNG/SRT or Local Studio.';
    } finally {
      this.downloadBusyFormat = null;
      this.updateDownloadUi();
    }
  }

  private async runSilentBackgroundWatch(): Promise<void> {
    if (!this.inspectedMedia) return;
    try {
      await fetch('/api/ai-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'watch',
          targetLang: this.aiLang,
          media: {
            title: this.inspectedMedia.title,
            creator: this.inspectedMedia.creator,
            platform: this.inspectedMedia.platform,
            sourceUrl: this.inspectedMedia.sourceUrl,
            description: this.inspectedMedia.description,
            transcriptText: this.inspectedMedia.transcriptText,
            keywords: this.inspectedMedia.keywords,
            durationSec: this.inspectedMedia.durationSec,
            imageDataUrls: this.capturedKeyframes.slice(0, 4),
            collectiveVisualHint: this.collectiveBrain.brainHintText,
            clientTelemetry: {
              bpm: this.clientAnalysis?.bpm ?? null,
              rmsDb: this.clientAnalysis?.rmsDb ?? null,
              dominantColors: this.clientAnalysis?.dominantColors ?? [],
              accessNode: this.deviceEdgeNode,
              frameCount: this.capturedKeyframes.length,
            },
          },
        }),
      });
    } catch {
      // Never block or surface internal model study to UI
    }
  }

  private async handleFilesUploadedToLibrary(files: FileList | File[]): Promise<void> {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    this.localFile = fileArr[0]!;
    let savedCount = 0;

    for (const file of fileArr) {
      const isImage =
        file.type.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
      const isAudio =
        file.type.startsWith('audio/') ||
        /\.(mp3|wav|flac|aac|ogg|m4a|opus|wma)$/i.test(file.name);
      const kind = isImage ? 'image' : isAudio ? 'audio' : 'video';
      const category: LibraryCategory =
        fileArr.length > 1 ? 'albums' : isAudio ? 'music' : isImage ? 'uploads' : 'video';
      const folderName =
        fileArr.length > 1 ? 'Albums' : isAudio ? 'Music' : isImage ? 'Favorites' : 'Reels & Video';

      let localAudioSamples: Float32Array | undefined;
      let localSampleRate: number | undefined;
      let durationSec = 0;
      if (isAudio || kind === 'video') {
        try {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AudioCtx && file.size < 25 * 1024 * 1024) {
            const ctx = new AudioCtx();
            const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
            durationSec = Math.round(decoded.duration || 0);
            localAudioSamples = decoded.getChannelData(0).slice(0, decoded.sampleRate * 16);
            localSampleRate = decoded.sampleRate;
            void ctx.close();
          }
        } catch {
          // FFmpeg/media player handles playback natively even if WebAudio decode skips
        }
      }

      const itemId = `device-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await saveToDeviceLibrary({
        id: itemId,
        title: file.name.replace(/\.[^.]+$/, ''),
        creator: 'On-Device Upload',
        platform: 'local',
        kind,
        category,
        folderName,
        albumOrTag: fileArr.length > 1 ? 'Uploaded Album' : 'My Device',
        durationSec,
        durationLabel: durationSec > 0 ? formatClock(durationSec) : 'LOCAL',
        sourceUrl: `local://${file.name}`,
        localBlob: file,
        mimeType: file.type,
        fileSizeBytes: file.size,
        savedAt: new Date().toISOString(),
      });
      savedCount += 1;

      if (savedCount === 1) {
        if (isImage && !['png', 'jpg', 'webp'].includes(this.localTargetFormat)) {
          this.localTargetFormat = 'webp';
        } else if (
          isAudio &&
          ['mp4-1080', 'mp4-720', 'webm', 'mkv', 'mov', 'gif'].includes(this.localTargetFormat)
        ) {
          this.localTargetFormat = 'mp3-320';
        } else if (kind === 'video' && ['png', 'jpg', 'webp'].includes(this.localTargetFormat)) {
          this.localTargetFormat = 'mp4-1080';
        }

        const analyzed = await runClientMediaAnalysisAndSync(
          {
            id: itemId,
            title: file.name.replace(/\.[^.]+$/, ''),
            creator: 'Local Device File',
            platform: 'local',
            kind,
            durationSec,
            durationLabel: 'LOCAL',
            thumbnailUrl: '',
            sourceUrl: `local://${file.name}`,
            description: `Local file (${file.type || 'media'}) · ${(file.size / 1024).toFixed(0)} KB`,
            keywords: [file.name.split('.').pop() || 'media', 'local'],
            transcriptText: '',
            transcriptSegments: [],
            formats: [],
            extractorNote: 'Stored on user device',
          },
          {
            localAudioSamples,
            localSampleRate,
            eventType: 'upload',
            accessNodeMode: 'local-file',
          }
        );
        this.clientAnalysis = analyzed.analysis;
      }
    }

    this.resultsTab = 'library';
    this.localStatusMsg =
      fileArr.length > 1
        ? `Saved ${savedCount} files cleanly to your Device Library (0 server storage).`
        : `Saved ${fileArr[0]!.name} to Device Library & ready to convert -> ${this.localTargetFormat.toUpperCase()}.`;

    this.renderConverterSection();
    await this.refreshDeviceLibrary();
  }

  private async convertLocalFile(): Promise<void> {
    if (!this.currentUser) {
      this.requireGmailAuthThen(() => this.convertLocalFile());
      return;
    }
    if (!this.localFile || this.localConverting) return;
    this.localConverting = true;
    this.localStatusMsg = `Converting ${this.localFile.name} to ${this.localTargetFormat.toUpperCase()}...`;
    this.renderConverterSection();

    try {
      const baseName =
        this.localFile.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9\u0600-\u06FF _-]+/gi, '_') ||
        'converted';

      if (
        this.localFile.type.startsWith('image/') &&
        (this.localTargetFormat === 'png' ||
          this.localTargetFormat === 'jpg' ||
          this.localTargetFormat === 'webp')
      ) {
        const outBlob = await convertImageFileLocally(this.localFile, this.localTargetFormat);
        triggerBlobDownload(outBlob, `${baseName}.${this.localTargetFormat}`);
        this.localStatusMsg = `Converted locally on Canvas to ${this.localTargetFormat.toUpperCase()}!`;
        return;
      }

      const resp = await fetch('/api/media/convert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(this.localFile.name),
          'x-target-format': this.localTargetFormat,
          'x-title': encodeURIComponent(baseName),
          'x-artist': encodeURIComponent('BLUEDROP Studio'),
        },
        body: this.localFile,
      });
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Conversion failed (HTTP ${resp.status})`);
      }
      const outBlob = await resp.blob();
      const ext = this.localTargetFormat.startsWith('mp4-')
        ? 'mp4'
        : this.localTargetFormat.startsWith('mp3-')
          ? 'mp3'
          : this.localTargetFormat;
      triggerBlobDownload(outBlob, `${baseName}.${ext}`);
      this.localStatusMsg = `FFmpeg conversion complete: ${baseName}.${ext}`;
    } catch (err) {
      this.localStatusMsg = err instanceof Error ? err.message : 'Conversion failed.';
    } finally {
      this.localConverting = false;
      this.renderConverterSection();
    }
  }

  private renderShell(): void {
    if (this.shellMounted) return;
    this.shellMounted = true;
    const isRtl = this.lang === 'ar';

    this.root.innerHTML = `
      <div class="bd-app" id="bd-app-root" dir="${isRtl ? 'rtl' : 'ltr'}">
        <header class="bd-topbar" id="bd-topbar-slot"></header>
        <div class="bd-subbar" id="platforms"></div>
        <div class="bd-studio-shell">
          <aside class="bd-app-rail" id="bd-app-rail" aria-label="Studio sidebar"></aside>
          <main class="bd-workspace" id="downloader">
            <section class="bd-hero" id="bd-hero-slot"></section>
            <div id="bd-error-slot"></div>
            <div id="bd-inspector-slot"></div>
            <section class="bd-section" id="search-results"></section>
            <section class="bd-section" id="converter"></section>

            <!-- Bounded Interactive 3D Headphone Mascot Stage directly above Download Zone -->
            <section class="bd-section" aria-label="Interactive 3D Headphone Stage">
              <div id="bd-mascot-stage" class="bd-mascot-zone">
                <div class="bd-mascot-caption">
                  <span id="bd-mascot-title" style="color:var(--c1);">${escapeHtml(UI_COPY[this.lang].mascotStageTitle)}</span>
                  <span id="bd-mascot-hint">${escapeHtml(UI_COPY[this.lang].mascotStageHint)}</span>
                </div>
              </div>
            </section>

            <section class="bd-section" id="download-section"></section>
          </main>
        </div>
        <footer class="bd-footer" id="bd-footer-slot"></footer>
        <nav class="bd-mobile-nav" id="bd-mobile-nav" aria-label="Mobile studio navigation"></nav>
        <div id="bd-mini-dock-slot"></div>
        <div id="bd-now-playing-slot"></div>
        <div id="bd-folder-picker-slot"></div>
        <div id="bd-auth-gate-slot"></div>
      </div>
    `;

    this.renderTopbarNav();
    this.renderAppRail();
    this.renderMobileBottomNav();
    this.renderSubbar();
    this.renderHeroSection();
    this.renderErrorBanner();
    this.renderInspectorSection();
    this.renderResultsAndLibrary();
    this.renderConverterSection();
    this.renderDownloadSection();
    this.renderFooterSection();
    this.renderMiniDock();
    this.renderNowPlayingSheet();
    this.renderFolderPickerModal();
    this.renderAuthGateModal();
  }

  private syncMascotCaption(): void {
    const titleEl = document.getElementById('bd-mascot-title');
    const hintEl = document.getElementById('bd-mascot-hint');
    if (titleEl) titleEl.textContent = UI_COPY[this.lang].mascotStageTitle;
    if (hintEl) hintEl.textContent = UI_COPY[this.lang].mascotStageHint;
  }

  private mountVisualLayers(): void {
    const mascotHost = document.getElementById('bd-mascot-stage');
    if (mascotHost && !this.mascotStage) {
      this.mascotStage = new MascotStageController(mascotHost);
    }
  }

  private runHeroEntranceAnimation(): void {
    const heroCards = this.root.querySelectorAll<HTMLElement>('.bd-anim-block');
    if (heroCards.length > 0) {
      gsap.fromTo(
        heroCards,
        { y: 14, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.45,
          stagger: 0.06,
          ease: 'power3.out',
          clearProps: 'transform,opacity',
        }
      );
    }
    const odoEl = document.getElementById('bd-format-odo');
    if (odoEl && !this.formatOdometer) {
      this.formatOdometer = new Odometer(odoEl, '00');
      this.formatOdometer.roll(19, { laps: 1, dur: 0.75 });
    }
  }

  private renderTopbarNav(): void {
    const slot = document.getElementById('bd-topbar-slot');
    if (!slot) return;
    const copy = UI_COPY[this.lang];
    const user = this.currentUser;
    const initials = (user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase();

    slot.innerHTML = `
      <div class="bd-topbar-inner">
        <a href="/" class="bd-brand" data-nav-route="/">
          ${BLUEDROP_LOGO_SVG}
          <span>BLUEDROP</span>
        </a>
        <nav class="bd-nav" aria-label="Primary navigation">
          <a href="#downloader" class="bd-nav-link">${escapeHtml(copy.navDownloader)}</a>
          <a href="#search-results" class="bd-nav-link">${escapeHtml(copy.resultsTabLibrary)}</a>
          <a href="#converter" class="bd-nav-link">${escapeHtml(copy.navConverter)}</a>
          <a href="#download-section" class="bd-nav-link">${escapeHtml(copy.navInstall)}</a>
        </nav>
        <div class="bd-topbar-actions">
          ${
            user
              ? `
            <div class="bd-user-chip" title="${escapeHtml(user.email)}">
              ${
                user.photoUrl
                  ? `<img id="bd-topbar-avatar-img" class="bd-user-avatar" src="${escapeHtml(user.photoUrl)}" alt="${escapeHtml(user.displayName)}" referrerpolicy="no-referrer" />`
                  : `<span class="bd-user-avatar">${escapeHtml(initials)}</span>`
              }
              <div class="bd-user-meta">
                <span class="bd-user-name">${escapeHtml(user.displayName)}</span>
                <span class="bd-user-email">${escapeHtml(user.email)}</span>
              </div>
              <button type="button" id="bd-signout-btn" class="bd-mini-btn" style="padding:3px 7px;font-size:10px;">${escapeHtml(copy.signOutBtn)}</button>
            </div>
          `
              : `
            <button type="button" id="bd-signin-gmail-btn" class="bd-btn bd-btn-solar" style="min-height:40px;padding:8px 14px;" ${this.authLoading ? 'disabled' : ''}>
              ${renderVectorIcon('google')}
              <span>${this.authLoading ? '...' : escapeHtml(copy.signInGmailBtn)}</span>
            </button>
          `
          }
          <button type="button" id="bd-paste-cta" class="bd-btn bd-btn-ink">${escapeHtml(copy.ctaQuickPaste)}</button>
        </div>
      </div>
    `;
    slot.querySelector('[data-nav-route]')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.navigateSeoRoute(matchSeoPage('/'));
    });
    const avatarImg = document.getElementById('bd-topbar-avatar-img') as HTMLImageElement | null;
    avatarImg?.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'bd-user-avatar';
      span.textContent = initials;
      avatarImg.replaceWith(span);
    });
    document.getElementById('bd-signin-gmail-btn')?.addEventListener('click', () => {
      void this.triggerGmailSignIn();
    });
    document.getElementById('bd-signout-btn')?.addEventListener('click', async () => {
      await signOutUser();
      this.currentUser = null;
      this.renderTopbarNav();
      this.renderDownloadSection();
    });
    document.getElementById('bd-paste-cta')?.addEventListener('click', async () => {
      const input = document.getElementById('bd-search-input') as HTMLInputElement | null;
      try {
        const clip = await navigator.clipboard.readText();
        if (clip && clip.trim()) {
          if (input) input.value = clip.trim();
          await this.handleSearchOrUrlSubmit(clip.trim());
          return;
        }
      } catch {
        // Focus input if clipboard blocked
      }
      input?.focus();
      input?.select();
    });
  }

  private navigateStudioSection(nav: 'discover' | 'library' | 'converter' | 'install'): void {
    this.activeStudioNav = nav;
    this.renderAppRail();
    this.renderMobileBottomNav();
    if (nav === 'discover') {
      document.getElementById('bd-hero-slot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (nav === 'library') {
      this.resultsTab = 'library';
      this.renderResultsAndLibrary();
      document.getElementById('search-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (nav === 'converter') {
      document.getElementById('converter')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (nav === 'install') {
      document.getElementById('download-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private renderAppRail(): void {
    const slot = document.getElementById('bd-app-rail');
    if (!slot) return;
    const copy = UI_COPY[this.lang];
    this.saveFolders = listSaveFolders();

    slot.innerHTML = `
      <div class="bd-rail-section">
        <div class="bd-rail-heading">${escapeHtml(copy.railStudioHeading)}</div>
        <button type="button" class="bd-rail-item" data-rail-nav="discover" aria-current="${this.activeStudioNav === 'discover' ? 'true' : 'false'}">
          <span style="display:inline-flex;align-items:center;gap:8px;">${renderVectorIcon('discover')}<span>${escapeHtml(copy.navDownloader)}</span></span>
        </button>
        <button type="button" class="bd-rail-item" data-rail-nav="library" aria-current="${this.activeStudioNav === 'library' ? 'true' : 'false'}">
          <span style="display:inline-flex;align-items:center;gap:8px;">${renderVectorIcon('library')}<span>${escapeHtml(copy.resultsTabLibrary)}</span></span>
          <span class="bd-rail-count">${this.libraryItems.length}</span>
        </button>
        <button type="button" class="bd-rail-item" data-rail-nav="converter" aria-current="${this.activeStudioNav === 'converter' ? 'true' : 'false'}">
          <span style="display:inline-flex;align-items:center;gap:8px;">${renderVectorIcon('convert')}<span>${escapeHtml(copy.navConverter)}</span></span>
        </button>
        ${
          !this.isStandalone
            ? `<button type="button" class="bd-rail-item" data-rail-nav="install" aria-current="${this.activeStudioNav === 'install' ? 'true' : 'false'}">
                <span style="display:inline-flex;align-items:center;gap:8px;">${renderVectorIcon('app')}<span>${escapeHtml(copy.navInstall)}</span></span>
              </button>`
            : ''
        }
      </div>

      <div class="bd-rail-section">
        <button type="button" id="bd-rail-upload-btn" class="bd-btn bd-btn-solar" style="width:100%;justify-content:center;min-height:42px;">
          ${renderVectorIcon('upload')}
          <span>${escapeHtml(copy.libraryUploadBtn)}</span>
        </button>
        <input id="bd-rail-upload-input" type="file" accept="video/*,audio/*,image/*,.mp4,.webm,.mkv,.mov,.avi,.m4v,.mp3,.wav,.flac,.aac,.ogg,.m4a,.opus,.png,.jpg,.jpeg,.webp" multiple style="display:none;" />
      </div>

      <div class="bd-rail-section" style="border-top:1px solid var(--rule-dark);padding-top:14px;">
        <div class="bd-rail-heading">${escapeHtml(copy.railFoldersHeading)}</div>
        <button type="button" class="bd-rail-item" data-rail-folder="all" aria-current="${this.resultsTab === 'library' && this.libraryFolderFilter === 'all' ? 'true' : 'false'}">
          <span style="display:inline-flex;align-items:center;gap:8px;">${renderVectorIcon('folder')}<span>All Saved</span></span>
          <span class="bd-rail-count">${this.libraryItems.length}</span>
        </button>
        ${this.saveFolders
          .map((folder) => {
            const count = this.libraryItems.filter(
              (it) => (it.folderName || 'Favorites').toLowerCase() === folder.toLowerCase()
            ).length;
            const active =
              this.resultsTab === 'library' &&
              this.libraryFolderFilter.toLowerCase() === folder.toLowerCase();
            return `
              <button type="button" class="bd-rail-item" data-rail-folder="${escapeHtml(folder)}" aria-current="${active ? 'true' : 'false'}">
                <span style="display:inline-flex;align-items:center;gap:8px;min-width:0;">${renderVectorIcon('folder')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(folder)}</span></span>
                <span class="bd-rail-count">${count}</span>
              </button>
            `;
          })
          .join('')}
      </div>

      <div class="bd-rail-section" style="margin-top:auto;border-top:1px solid var(--rule-dark);padding-top:14px;">
        <div style="display:flex;gap:6px;">
          <button type="button" id="bd-rail-order-btn" class="bd-mini-btn" style="flex:1;justify-content:center;display:inline-flex;align-items:center;gap:5px;">
            ${this.playOrderMode === 'shuffle' ? renderVectorIcon('shuffle') : renderVectorIcon('order')}
            <span>${this.playOrderMode === 'shuffle' ? escapeHtml(copy.orderShuffle) : escapeHtml(copy.orderSequential)}</span>
          </button>
          <button type="button" id="bd-rail-play-queue" class="bd-mini-btn" style="background:var(--mint);color:var(--ink);border-color:var(--mint);display:inline-flex;align-items:center;gap:4px;">
            ${renderVectorIcon('play')}
            <span>PLAY</span>
          </button>
        </div>
        <div class="bd-mono-label" style="font-size:10px;color:var(--muted-bone);padding:4px 2px;">
          ${this.libraryItems.length} SAVED · ${this.deviceUsedMb} MB LOCAL
        </div>
      </div>
    `;

    slot.querySelectorAll<HTMLElement>('[data-rail-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nav = btn.dataset.railNav as 'discover' | 'library' | 'converter' | 'install';
        this.navigateStudioSection(nav);
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-rail-folder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.libraryFolderFilter = btn.dataset.railFolder || 'all';
        this.resultsTab = 'library';
        this.activeStudioNav = 'library';
        this.renderAppRail();
        this.renderMobileBottomNav();
        this.renderResultsAndLibrary();
        document.getElementById('search-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    const railUploadInput = document.getElementById('bd-rail-upload-input') as HTMLInputElement | null;
    document.getElementById('bd-rail-upload-btn')?.addEventListener('click', () => {
      railUploadInput?.click();
    });
    railUploadInput?.addEventListener('change', () => {
      if (railUploadInput.files && railUploadInput.files.length > 0) {
        void this.handleFilesUploadedToLibrary(railUploadInput.files);
      }
    });

    document.getElementById('bd-rail-order-btn')?.addEventListener('click', () => {
      this.playOrderMode = this.playOrderMode === 'shuffle' ? 'sequential' : 'shuffle';
      this.renderAppRail();
      this.renderResultsAndLibrary();
      this.renderNowPlayingSheet();
    });

    document.getElementById('bd-rail-play-queue')?.addEventListener('click', () => {
      const libQueue = this.getFilteredLibraryItems().filter((it) =>
        Boolean(it.localBlob || it.streamUrl || it.directAudioUrl || it.directVideoUrl)
      );
      if (libQueue.length > 0) {
        const startIdx = this.playOrderMode === 'shuffle' ? Math.floor(Math.random() * libQueue.length) : 0;
        const first = libQueue[startIdx];
        if (first) void this.playLibraryItemInBackground(first);
      } else if (this.searchResults.length > 0) {
        const startIdx =
          this.playOrderMode === 'shuffle' ? Math.floor(Math.random() * this.searchResults.length) : 0;
        const first = this.searchResults[startIdx];
        if (first) void this.playLiveSearchItem(first);
      }
    });
  }

  private renderMobileBottomNav(): void {
    const slot = document.getElementById('bd-mobile-nav');
    if (!slot) return;
    const copy = UI_COPY[this.lang];

    slot.innerHTML = `
      <button type="button" class="bd-mobile-nav-btn" data-mobile-nav="discover" aria-current="${this.activeStudioNav === 'discover' ? 'true' : 'false'}">
        ${renderVectorIcon('discover')}
        <span>${escapeHtml(copy.navDownloader)}</span>
      </button>
      <button type="button" class="bd-mobile-nav-btn" data-mobile-nav="library" aria-current="${this.activeStudioNav === 'library' ? 'true' : 'false'}">
        ${renderVectorIcon('library')}
        <span>${escapeHtml(copy.resultsTabLibrary)}</span>
      </button>
      <button type="button" class="bd-mobile-nav-btn" data-mobile-nav="converter" aria-current="${this.activeStudioNav === 'converter' ? 'true' : 'false'}">
        ${renderVectorIcon('convert')}
        <span>${escapeHtml(copy.navConverter)}</span>
      </button>
      <button type="button" class="bd-mobile-nav-btn" data-mobile-nav="upload" aria-current="false">
        ${renderVectorIcon('upload')}
        <span>${escapeHtml(copy.navUpload)}</span>
      </button>
    `;

    slot.querySelectorAll<HTMLElement>('[data-mobile-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.mobileNav;
        if (action === 'upload') {
          const picker =
            (document.getElementById('bd-lib-upload-input') as HTMLInputElement | null) ||
            (document.getElementById('bd-rail-upload-input') as HTMLInputElement | null);
          picker?.click();
          return;
        }
        if (action === 'discover' || action === 'library' || action === 'converter') {
          this.navigateStudioSection(action);
        }
      });
    });
  }

  private renderAuthGateModal(): void {
    const slot = document.getElementById('bd-auth-gate-slot');
    if (!slot) return;
    if (!this.authGateOpen || this.currentUser) {
      slot.innerHTML = '';
      return;
    }
    const copy = UI_COPY[this.lang];
    slot.innerHTML = `
      <div class="bd-folder-backdrop" id="bd-auth-gate-backdrop" role="dialog" aria-modal="true" aria-label="${escapeHtml(copy.authGateTitle)}">
        <div class="bd-auth-gate-modal">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
            <div>
              <div class="bd-mono-label" style="color:var(--ink);opacity:0.7;">BLUEDROP · GMAIL ACCOUNT</div>
              <h2 class="bd-h2" style="margin-top:6px;">${escapeHtml(copy.authGateTitle)}</h2>
            </div>
            <button type="button" id="bd-auth-gate-close" class="bd-mini-btn" style="background:var(--bone);color:var(--ink);border-color:var(--ink);font-size:15px;" aria-label="Close">×</button>
          </div>
          <p style="font-size:14.5px;line-height:1.55;">${escapeHtml(copy.authGateBody)}</p>
          ${
            this.authError
              ? `<div style="background:var(--c3);color:var(--ink);border:1.5px solid var(--ink);padding:10px 12px;font-size:13px;">${escapeHtml(this.authError)}</div>`
              : ''
          }
          <button type="button" id="bd-auth-gate-google-btn" class="bd-btn bd-btn-solar" style="width:100%;justify-content:center;" ${this.authLoading ? 'disabled' : ''}>
            ${renderVectorIcon('google')}
            <span>${this.authLoading ? '...' : escapeHtml(copy.authGateCta)}</span>
          </button>
        </div>
      </div>
    `;
    const closeGate = () => {
      this.authGateOpen = false;
      this.pendingAfterAuthAction = null;
      this.authError = '';
      this.renderAuthGateModal();
    };
    document.getElementById('bd-auth-gate-close')?.addEventListener('click', closeGate);
    document.getElementById('bd-auth-gate-backdrop')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'bd-auth-gate-backdrop') {
        closeGate();
      }
    });
    document.getElementById('bd-auth-gate-google-btn')?.addEventListener('click', () => {
      void this.triggerGmailSignIn();
    });
  }

  private renderSubbar(): void {
    const slot = document.getElementById('platforms');
    if (!slot) return;
    slot.innerHTML = `
      <div class="bd-container bd-subbar-inner">
        <div class="bd-seg-group" role="tablist" aria-label="Platform pages">
          ${SEO_PAGES.map(
            (p) => `
              <button
                type="button"
                class="bd-tab"
                data-seo-path="${p.path}"
                aria-pressed="${this.seoPage.path === p.path ? 'true' : 'false'}"
              >${escapeHtml(p.shortLabel)}</button>
            `
          ).join('')}
        </div>
        <div class="bd-seg-group" role="group" aria-label="Language">
          <button type="button" class="bd-tab" data-lang="en" aria-pressed="${this.lang === 'en'}">EN</button>
          <button type="button" class="bd-tab" data-lang="fr" aria-pressed="${this.lang === 'fr'}">FR</button>
          <button type="button" class="bd-tab" data-lang="ar" aria-pressed="${this.lang === 'ar'}">AR · الدارجة</button>
        </div>
      </div>
    `;
    slot.querySelectorAll<HTMLElement>('[data-seo-path]').forEach((el) => {
      el.addEventListener('click', () => {
        const path = el.dataset.seoPath || '/';
        this.navigateSeoRoute(matchSeoPage(path));
      });
    });
    slot.querySelectorAll<HTMLElement>('[data-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const l = btn.dataset.lang as UiLang;
        if (l) this.setLanguage(l);
      });
    });
  }

  private renderHeroSection(): void {
    const slot = document.getElementById('bd-hero-slot');
    if (!slot) return;
    const copy = UI_COPY[this.lang];

    const heroHeadline =
      this.seoPage.path === '/'
        ? copy.heroTitle
        : this.lang === 'ar'
          ? this.seoPage.arTitle
          : this.lang === 'fr'
            ? this.seoPage.frTitle
            : this.seoPage.headline;
    const heroDescription =
      this.seoPage.path === '/'
        ? copy.heroSubtitle
        : this.lang === 'ar'
          ? this.seoPage.arDescription
          : this.lang === 'fr'
            ? this.seoPage.frDescription
            : this.seoPage.description;

    slot.innerHTML = `
      <div class="bd-hero-grid">
        <div class="bd-hero-main bd-pixel-host bd-anim-block" id="bd-hero-pixel-host">
          <div>
            <div class="bd-kicker" style="color:${this.seoPage.accentHex}">${escapeHtml(this.seoPage.platformBadge)}</div>
            <h1 class="bd-h1" style="margin-top:12px;">${escapeHtml(heroHeadline)}</h1>
            <p class="bd-lead" style="margin-top:14px;">${escapeHtml(heroDescription)}</p>
          </div>

          <form id="bd-search-form" class="bd-search-box">
            <div class="bd-seg-group" role="group" aria-label="Media filter">
              <button type="button" class="bd-tab" data-filter="all" aria-pressed="${this.searchFilter === 'all'}">${escapeHtml(copy.searchAll)}</button>
              <button type="button" class="bd-tab" data-filter="music" aria-pressed="${this.searchFilter === 'music'}">${escapeHtml(copy.searchMusic)}</button>
              <button type="button" class="bd-tab" data-filter="video" aria-pressed="${this.searchFilter === 'video'}">${escapeHtml(copy.searchVideo)}</button>
            </div>
            <div class="bd-search-row">
              <input
                id="bd-search-input"
                class="bd-input"
                type="text"
                dir="auto"
                value="${escapeHtml(this.searchQuery)}"
                placeholder="${escapeHtml(copy.searchPlaceholder)}"
                aria-label="Media URL or search query"
              />
              <button type="submit" id="bd-search-submit-btn" class="bd-btn bd-btn-solar">${this.searching || this.inspecting ? 'Working...' : escapeHtml(copy.inspectBtn)}</button>
            </div>
            <div class="bd-quick-links">
              <span>QUICK TRY:</span>
              <button type="button" class="bd-link-btn" data-quick-url="https://www.tiktok.com/@tiktok/video/7106594312292453675">TikTok HD Sample</button>
              <button type="button" class="bd-link-btn" data-quick-url="https://www.dailymotion.com/video/x84sh87">Dailymotion Stream</button>
              <button type="button" class="bd-link-btn" data-quick-url="https://vimeo.com/76979871">Vimeo HD Sample</button>
              <button type="button" class="bd-link-btn" data-quick-search="ElGrandeToto">Music (ElGrandeToto)</button>
              <button type="button" class="bd-link-btn" data-quick-url="https://www.youtube.com/watch?v=aqz-KE-bpKQ">YouTube Link</button>
            </div>
          </form>
        </div>

        <div class="bd-hero-blocks">
          <div class="bd-block-solar bd-anim-block">
            <div class="bd-mono-label">OUTPUT FORMAT MATRIX · 0 ADS</div>
            <div style="display:flex;align-items:baseline;gap:14px;">
              <div class="bd-mega-num"><span id="bd-format-odo" data-v="19">19</span></div>
              <div class="bd-mono-label">VIDEO · AUDIO<br/>IMAGE · CAPTIONS</div>
            </div>
            <div class="bd-mono-label" style="border-top:1.5px solid var(--ink);padding-top:12px;">
              MP4 4K · WEBM · MKV · MOV · GIF · MP3 320K · WAV · FLAC · AAC · OGG · M4A · PNG · WEBP · SRT
            </div>
          </div>
          <div class="bd-block-rose bd-anim-block">
            <div class="bd-mono-label" style="margin-bottom:8px;">MEDIA SOURCES · ZERO ADS</div>
            <div class="bd-receipt-list">
              <div class="rc"><span>SOURCES</span><span class="ld"></span><span>YT · TIKTOK · IG · FB · DEEZER · AUDIUS</span></div>
              <div class="rc"><span>AUDIO ENGINE</span><span class="ld"></span><span>MP3 320K · WAV · FLAC · LYRICS</span></div>
              <div class="rc" id="bd-hero-vault-row"><span>DEVICE VAULT</span><span class="ld"></span><span id="bd-hero-vault-val">${this.libraryItems.length} SAVED · ${this.deviceUsedMb} MB</span></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const odoEl = document.getElementById('bd-format-odo');
    if (odoEl) {
      this.formatOdometer = new Odometer(odoEl, '00');
      this.formatOdometer.jump(19);
    }

    this.heroTrail?.destroy();
    this.heroTrail = null;
    const heroHost = document.getElementById('bd-hero-pixel-host');
    if (heroHost) {
      this.heroTrail = new PixelTrailController(heroHost, { cellSize: 24 });
    }

    slot.querySelectorAll<HTMLElement>('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = btn.dataset.filter as 'all' | 'music' | 'video';
        this.searchFilter = f;
        slot.querySelectorAll<HTMLElement>('[data-filter]').forEach((el) => {
          el.setAttribute('aria-pressed', el.dataset.filter === f ? 'true' : 'false');
        });
        if (this.searchQuery && !extractUrlFromInput(this.searchQuery)) {
          void this.performSearch(this.searchQuery, f);
        }
      });
    });

    document.getElementById('bd-search-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('bd-search-input') as HTMLInputElement | null;
      void this.handleSearchOrUrlSubmit(input?.value ?? '');
    });

    slot.querySelectorAll<HTMLElement>('[data-quick-url]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.quickUrl;
        if (url) {
          this.searchQuery = url;
          const inp = document.getElementById('bd-search-input') as HTMLInputElement | null;
          if (inp) inp.value = url;
          void this.inspectUrl(url);
        }
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-quick-search]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = btn.dataset.quickSearch;
        const f = (btn.dataset.quickFilter as 'all' | 'music' | 'video' | undefined) ?? this.searchFilter;
        if (q) {
          this.searchQuery = q;
          this.searchFilter = f;
          this.resultsTab = 'live';
          const inp = document.getElementById('bd-search-input') as HTMLInputElement | null;
          if (inp) inp.value = q;
          void this.performSearch(q, f);
        }
      });
    });
  }

  private renderSearchButtonState(): void {
    const btn = document.getElementById('bd-search-submit-btn');
    if (btn) {
      btn.textContent =
        this.searching || this.inspecting ? 'Working...' : UI_COPY[this.lang].inspectBtn;
    }
  }

  private renderErrorBanner(): void {
    const slot = document.getElementById('bd-error-slot');
    if (!slot) return;
    slot.innerHTML = this.searchError
      ? `<div class="bd-section"><div class="bd-block-paper" style="background:var(--c4);color:var(--ink);"><strong>Notice:</strong> ${escapeHtml(this.searchError)}</div></div>`
      : '';
  }

  private renderDownloadStatusHtml(): string {
    if (!this.downloadBusyFormat && !this.downloadStatusMsg) return '';
    return `
      <div style="background:var(--ink);border:1.5px solid var(--c1);padding:14px 16px;">
        <div class="bd-mono-label" style="color:var(--c1);margin-bottom:8px;">${escapeHtml(this.downloadStatusMsg)}</div>
        ${
          this.downloadBusyFormat
            ? `<div class="bd-progress-track"><div id="bd-dl-bar" class="bd-progress-fill" style="width:${this.downloadProgressPct}%"></div></div>`
            : ''
        }
      </div>
    `;
  }

  private updateDownloadUi(): void {
    const wrap = document.getElementById('bd-dl-status-wrap');
    if (wrap) wrap.innerHTML = this.renderDownloadStatusHtml();
    this.root.querySelectorAll<HTMLButtonElement>('[data-format-id]').forEach((btn) => {
      const id = btn.dataset.formatId;
      btn.disabled = Boolean(this.downloadBusyFormat);
      const labelEl = btn.querySelector<HTMLElement>('.bd-format-dl-state');
      if (labelEl) {
        const prefix = btn.dataset.cat === 'image' ? 'COVER ONLY' : 'DOWNLOAD';
        labelEl.innerHTML =
          this.downloadBusyFormat === id ? 'TRANSCODING...' : `${prefix} ${renderVectorIcon('down')}`;
      }
    });
  }

  private renderLyricsBoxHtml(compact = false): string {
    const copy = UI_COPY[this.lang];
    const lyr = this.activeLyrics;
    const pureText = lyr?.text ? this.stripThinkingTextClient(lyr.text) : '';
    const hasRealLyrics =
      Boolean(pureText) && !/^No sung lyrics found/i.test(pureText);

    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div>
          <div class="bd-mono-label" style="color:var(--c1);">${escapeHtml(copy.lyricsHeading)}</div>
          ${lyr?.source ? `<div class="bd-mono-label" style="font-size:10px;color:var(--muted-bone);margin-top:2px;">${escapeHtml(lyr.source)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <div class="bd-seg-group" role="group" aria-label="Lyrics translation language">
            <button type="button" class="bd-mini-btn" data-lyrics-lang="ary" aria-pressed="${this.aiLang === 'ary' ? 'true' : 'false'}">الدارجة</button>
            <button type="button" class="bd-mini-btn" data-lyrics-lang="ar" aria-pressed="${this.aiLang === 'ar' ? 'true' : 'false'}">العربية</button>
            <button type="button" class="bd-mini-btn" data-lyrics-lang="fr" aria-pressed="${this.aiLang === 'fr' ? 'true' : 'false'}">FR</button>
            <button type="button" class="bd-mini-btn" data-lyrics-lang="en" aria-pressed="${this.aiLang === 'en' ? 'true' : 'false'}">EN</button>
          </div>
          <button type="button" class="bd-mini-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1);" data-extract-lyrics="1" ${this.extractingLyrics ? 'disabled' : ''}>
            ${this.extractingLyrics ? '...' : escapeHtml(copy.extractLyricsBtn)}
          </button>
          ${
            hasRealLyrics
              ? `<button type="button" class="bd-mini-btn" data-translate-lyrics="1">${this.lyricsTranslating ? '...' : escapeHtml(copy.translateLyricsBtn)}</button>`
              : ''
          }
        </div>
      </div>
    `;

    let body = '';
    if (lyr?.loading || this.extractingLyrics) {
      body = `<div class="bd-lyrics-box"><div class="bd-mono-label" style="color:var(--c1);">LOADING LYRICS...</div></div>`;
    } else if (lyr?.synced && lyr.synced.length > 0) {
      body = `
        <div class="bd-lyrics-box" style="${compact ? 'max-height:200px;' : 'max-height:340px;'}">
          ${lyr.synced
            .map(
              (s, idx) =>
                `<div class="bd-lyric-line" data-lyric-idx="${idx}" dir="auto">${escapeHtml(s.line)}</div>`
            )
            .join('')}
        </div>
      `;
    } else if (pureText) {
      body = `
        <div class="bd-lyrics-box" style="${compact ? 'max-height:200px;' : 'max-height:340px;'};white-space:pre-wrap;font-size:14px;" dir="auto">${escapeHtml(pureText)}</div>
      `;
    } else {
      body = `<div class="bd-lyrics-box" style="color:var(--muted-bone);font-size:13px;">${escapeHtml(copy.noLyricsYet)}</div>`;
    }

    const cleanTranslation = this.lyricsTranslation
      ? this.stripThinkingTextClient(this.lyricsTranslation)
      : '';
    const translatedBlock = cleanTranslation
      ? `<div class="bd-ai-output" style="margin-top:8px;" dir="auto">
          <div class="bd-mono-label">TRANSLATED LYRICS</div>
          <div style="font-size:14px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(cleanTranslation)}</div>
         </div>`
      : '';

    return `<div style="margin-top:12px;">${header}${body}${translatedBlock}</div>`;
  }

  private renderLyricsPanels(): void {
    const inspLyricsEl = document.getElementById('bd-inspector-lyrics-wrap');
    if (inspLyricsEl) {
      inspLyricsEl.innerHTML = this.renderLyricsBoxHtml(true);
      this.wireLyricsButtons(inspLyricsEl);
    }
    const sheetLyricsEl = document.getElementById('bd-sheet-lyrics-wrap');
    if (sheetLyricsEl) {
      sheetLyricsEl.innerHTML = this.renderLyricsBoxHtml(false);
      this.wireLyricsButtons(sheetLyricsEl);
    }
    this.syncActiveLyricHighlight();
  }

  private wireLyricsButtons(scope: HTMLElement): void {
    scope.querySelectorAll<HTMLElement>('[data-lyrics-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextLang = btn.dataset.lyricsLang as 'ar' | 'ary' | 'fr' | 'en';
        if (!nextLang) return;
        this.aiLang = nextLang;
        this.root.querySelectorAll<HTMLElement>('[data-lyrics-lang]').forEach((el) => {
          el.setAttribute('aria-pressed', el.dataset.lyricsLang === nextLang ? 'true' : 'false');
        });
      });
    });
    scope.querySelectorAll<HTMLElement>('[data-translate-lyrics]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this.translateActiveLyrics();
      });
    });
    scope.querySelectorAll<HTMLElement>('[data-extract-lyrics]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this.extractPureLyricsWithAi();
      });
    });
  }

  private async translateActiveLyrics(): Promise<void> {
    const lyrText = this.activeLyrics?.text;
    const title = this.activeBgTrack?.title || this.inspectedMedia?.title || 'Track';
    const creator = this.activeBgTrack?.creator || this.inspectedMedia?.creator || 'Artist';
    if (!lyrText || this.lyricsTranslating) return;
    this.lyricsTranslating = true;
    this.renderLyricsPanels();
    try {
      const resp = await fetch('/api/ai-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'translate',
          targetLang: this.aiLang,
          media: {
            title,
            creator,
            platform: this.inspectedMedia?.platform || 'direct',
            sourceUrl: this.inspectedMedia?.sourceUrl || 'https://bluedrop.studio',
            transcriptText: lyrText.slice(0, 2200),
          },
        }),
      });
      const data = (await resp.json()) as AiMediaResponse;
      this.lyricsTranslation = this.stripThinkingTextClient(data.content || 'Translation ready.');
    } catch {
      this.lyricsTranslation = 'Could not translate lyrics right now.';
    } finally {
      this.lyricsTranslating = false;
      this.renderLyricsPanels();
    }
  }

  private async handleBookmarkTap(target: {
    id: string;
    title: string;
    creator: string;
    platform: MediaInspectResult['platform'];
    kind: MediaInspectResult['kind'];
    albumOrTag: string;
    durationSec: number;
    durationLabel: string;
    sourceUrl: string;
    streamUrl?: string;
    directVideoUrl?: string;
    directAudioUrl?: string;
    embedPlayerUrl?: string;
    thumbnailUrl?: string;
    description?: string;
    keywords?: string[];
    transcriptText?: string;
    extractorNote?: string;
    lyricsText?: string;
  }): Promise<void> {
    this.saveFolders = listSaveFolders();
    const existing = this.isSavedOnDevice(target.id, target.sourceUrl);
    const chosenFolder =
      existing?.folderName ||
      this.activeSaveFolder ||
      (target.kind === 'audio' ? 'Music' : 'Reels & Video');

    const savedRecord: DeviceLibraryItem = {
      id: target.id,
      title: target.title,
      creator: target.creator,
      platform: target.platform,
      kind: target.kind,
      category: inferCategoryFromFolder(chosenFolder, target.kind),
      folderName: chosenFolder,
      albumOrTag: target.albumOrTag || target.platform.toUpperCase(),
      durationSec: target.durationSec,
      durationLabel: target.durationLabel,
      sourceUrl: target.sourceUrl,
      streamUrl: target.streamUrl || existing?.streamUrl,
      directVideoUrl: target.directVideoUrl || existing?.directVideoUrl,
      directAudioUrl: target.directAudioUrl || existing?.directAudioUrl,
      embedPlayerUrl: target.embedPlayerUrl || existing?.embedPlayerUrl,
      thumbnailUrl: target.thumbnailUrl || existing?.thumbnailUrl,
      description: target.description || existing?.description,
      keywords: target.keywords || existing?.keywords,
      transcriptText: target.transcriptText || existing?.transcriptText,
      extractorNote: target.extractorNote || existing?.extractorNote,
      lyricsText: target.lyricsText || existing?.lyricsText,
      savedAt: existing?.savedAt || new Date().toISOString(),
      isolated: existing?.isolated,
    };
    await saveToDeviceLibrary(savedRecord);
    void syncLibraryItemToFirestore(savedRecord);

    this.folderPickerTarget = target;
    this.saveFeedbackBanner = `${UI_COPY[this.lang].savedToLabel}: ${chosenFolder}`;
    await this.refreshDeviceLibrary();
    this.renderInspectorSection();
    this.renderMiniDock();
    this.renderNowPlayingSheet();
    this.renderFolderPickerModal();
  }

  private renderFolderPickerModal(): void {
    const slot = document.getElementById('bd-folder-picker-slot');
    if (!slot) return;
    if (!this.folderPickerTarget) {
      slot.innerHTML = '';
      return;
    }
    const copy = UI_COPY[this.lang];
    const target = this.folderPickerTarget;
    const currentItem = this.isSavedOnDevice(target.id, target.sourceUrl);
    const currentFolder = currentItem?.folderName || this.activeSaveFolder || 'Favorites';
    this.saveFolders = listSaveFolders();

    slot.innerHTML = `
      <div class="bd-folder-backdrop" id="bd-folder-backdrop" role="dialog" aria-modal="true" aria-label="Choose save folder">
        <div class="bd-folder-modal">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div>
              <div class="bd-mono-label">INSTAGRAM-STYLE COLLECTION</div>
              <h3 style="font-size:18px;font-weight:600;margin-top:4px;" dir="auto">${escapeHtml(target.title)}</h3>
            </div>
            <button type="button" id="bd-folder-close" class="bd-mini-btn">×</button>
          </div>
          <div class="bd-mono-label" style="opacity:0.75;">${escapeHtml(copy.savedToLabel)} "${escapeHtml(currentFolder)}" — Choose or create folder:</div>
          <div class="bd-folder-list">
            ${this.saveFolders
              .map(
                (folder) => `
                <button
                  type="button"
                  class="bd-folder-option"
                  data-pick-folder="${escapeHtml(folder)}"
                  aria-selected="${currentFolder.toLowerCase() === folder.toLowerCase() ? 'true' : 'false'}"
                >
                  <span>${escapeHtml(folder)}</span>
                  <span>${currentFolder.toLowerCase() === folder.toLowerCase() ? renderVectorIcon('check') : renderVectorIcon('arrow-right')}</span>
                </button>
              `
              )
              .join('')}
          </div>
          <form id="bd-new-folder-form" style="display:flex;gap:6px;margin-top:4px;">
            <input
              id="bd-new-folder-input"
              class="bd-input"
              style="min-height:40px;padding:8px 10px;background:#fff;color:var(--ink);border-color:var(--ink);"
              type="text"
              dir="auto"
              placeholder="${escapeHtml(copy.newFolderPlaceholder)}"
            />
            <button type="submit" class="bd-btn bd-btn-ink" style="min-height:40px;padding:8px 12px;">${escapeHtml(copy.createFolderBtn)}</button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('bd-folder-close')?.addEventListener('click', () => {
      this.folderPickerTarget = null;
      this.renderFolderPickerModal();
    });
    document.getElementById('bd-folder-backdrop')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'bd-folder-backdrop') {
        this.folderPickerTarget = null;
        this.renderFolderPickerModal();
      }
    });

    slot.querySelectorAll<HTMLElement>('[data-pick-folder]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const folder = btn.dataset.pickFolder || 'Favorites';
        this.activeSaveFolder = folder;
        await updateDeviceLibraryItem(target.id, {
          folderName: folder,
          albumOrTag: folder,
          category: inferCategoryFromFolder(folder, target.kind),
        });
        this.saveFeedbackBanner = `${copy.savedToLabel}: ${folder}`;
        this.folderPickerTarget = null;
        await this.refreshDeviceLibrary();
        const updated = this.libraryItems.find((it) => it.id === target.id);
        if (updated) void syncLibraryItemToFirestore(updated);
        this.renderFolderPickerModal();
        this.renderInspectorSection();
      });
    });

    document.getElementById('bd-new-folder-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = document.getElementById('bd-new-folder-input') as HTMLInputElement | null;
      const name = inp?.value.trim() || '';
      if (!name) return;
      this.saveFolders = createSaveFolder(name);
      this.activeSaveFolder = name;
      await updateDeviceLibraryItem(target.id, {
        folderName: name,
        albumOrTag: name,
        category: inferCategoryFromFolder(name, target.kind),
      });
      this.saveFeedbackBanner = `${copy.savedToLabel}: ${name}`;
      this.folderPickerTarget = null;
      await this.refreshDeviceLibrary();
      const updated = this.libraryItems.find((it) => it.id === target.id);
      if (updated) void syncLibraryItemToFirestore(updated);
      this.renderFolderPickerModal();
      this.renderInspectorSection();
    });
  }

  private renderInspectorSection(): void {
    const slot = document.getElementById('bd-inspector-slot');
    if (!slot) return;
    const copy = UI_COPY[this.lang];

    if (this.inspecting && !this.inspectedMedia) {
      slot.innerHTML = `
        <section class="bd-section" id="inspector-stage">
          <div class="bd-block-paper" style="background:var(--ghost);color:var(--bone);border-color:var(--c1);">
            <div class="bd-mono-label" style="color:var(--c1);">${escapeHtml(copy.extractingLinkLabel)}</div>
            <div style="font-size:15px;margin-top:8px;word-break:break-all;color:var(--bone);">${escapeHtml(this.inspectingUrlLabel)}</div>
            <div class="bd-progress-track" style="margin-top:12px;"><div class="bd-progress-fill" style="width:65%"></div></div>
          </div>
        </section>
      `;
      return;
    }

    const m = this.inspectedMedia;
    if (!m) {
      slot.innerHTML = '';
      return;
    }

    const savedRec = this.isSavedOnDevice(m.id, m.sourceUrl);
    const progressPct =
      this.playerDurationSec > 0
        ? Math.min(100, (this.playerCurrentSec / this.playerDurationSec) * 100)
        : 0;

    slot.innerHTML = `
      <section class="bd-section" id="inspector-stage">
        <div class="bd-section-header">
          <div>
            <div class="bd-mono-label" style="color:var(--mint);margin-bottom:4px;display:inline-flex;align-items:center;gap:6px;">${renderVectorIcon('check')}<span>${escapeHtml(copy.uploadReadyBadge)}</span></div>
            <h2 class="bd-h2">${escapeHtml(m.title)}</h2>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="bd-mono-label" style="color:var(--c1);">${escapeHtml(m.platform.toUpperCase())} · ${escapeHtml(m.extractorNote)}</span>
            <button type="button" id="bd-inspector-bookmark-btn" class="bd-bookmark-btn" data-saved="${savedRec ? 'true' : 'false'}">
              ${renderBookmarkSvg(Boolean(savedRec))}
              <span>${savedRec ? `${escapeHtml(copy.savedToLabel)} ${escapeHtml(savedRec.folderName || 'Favorites')}` : escapeHtml(copy.saveBookmarkLabel)}</span>
            </button>
            <button type="button" id="bd-inspector-expand-btn" class="bd-mini-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1);">${escapeHtml(copy.expandPlayerLabel)}</button>
          </div>
        </div>

        <div class="bd-inspector-grid">
          <div class="bd-inspector-left">
            <div class="bd-media-thumb" id="bd-video-stage-box" style="border:1.5px solid var(--ink);">
              ${
                m.kind === 'video' && m.previewStreamUrl
                  ? `<video id="bd-preview-video" src="${escapeHtml(
                      m.previewStreamUrl.startsWith('http')
                        ? `/api/media/stream?url=${encodeURIComponent(m.previewStreamUrl)}`
                        : m.previewStreamUrl
                    )}" poster="${escapeHtml(m.thumbnailUrl)}" crossorigin="anonymous" playsinline controls preload="metadata" style="width:100%;height:100%;object-fit:cover;display:block;background:#111;"></video>`
                  : m.embedPlayerUrl
                    ? `<iframe id="bd-embed-frame" class="bd-embed-frame" src="${escapeHtml(m.embedPlayerUrl)}" title="${escapeHtml(m.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
                    : m.thumbnailUrl
                      ? `<img src="${escapeHtml(m.thumbnailUrl)}" alt="${escapeHtml(m.title)}" referrerpolicy="no-referrer" />`
                      : `<div style="height:100%;display:flex;align-items:center;justify-content:center;background:#111;color:#F4F03A;font-family:var(--font-mono);font-size:12px;">${escapeHtml(m.kind.toUpperCase())} STREAM</div>`
              }
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              ${
                m.kind === 'video' || m.embedPlayerUrl
                  ? `<button type="button" id="bd-fullscreen-btn" class="bd-mini-btn" style="background:var(--ink);color:var(--c1);border-color:var(--ink);">${renderVectorIcon('fullscreen')} <span>${escapeHtml(copy.fullscreenBtn)}</span></button>`
                  : ''
              }
              ${
                m.kind === 'video' && m.previewStreamUrl
                  ? `<button type="button" id="bd-pip-btn" class="bd-mini-btn">${escapeHtml(copy.pipBtn)}</button>`
                  : ''
              }
            </div>

            <div>
              <div class="bd-mono-label">${escapeHtml(m.platform.toUpperCase())} · ${escapeHtml(m.durationLabel)}</div>
              <h3 dir="auto" style="font-size:20px;font-weight:500;letter-spacing:-0.02em;margin-top:6px;">${escapeHtml(m.title)}</h3>
              <div style="font-size:14px;opacity:0.75;margin-top:4px;">${escapeHtml(m.creator)}</div>
            </div>

            ${
              m.previewStreamUrl
                ? `
              <div style="border-top:1.5px solid var(--ink);padding-top:12px;">
                <div class="bd-mono-label" style="margin-bottom:8px;">BLOCKS PLAYER &amp; STEM FILTER</div>
                <div class="bd-player">
                  <button type="button" id="bd-player-toggle" class="bd-player-btn">${this.playerPlaying ? 'PAUSE' : 'PLAY'}</button>
                  <div id="bd-player-track" class="bd-player-track" role="slider" aria-label="Seek preview" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressPct)}">
                    <div id="bd-player-fill" class="bd-player-fill" style="width:${progressPct}%"></div>
                  </div>
                  <span id="bd-player-time" class="bd-player-time">${formatClock(this.playerCurrentSec)} / ${formatClock(this.playerDurationSec)}</span>
                </div>
                <div class="bd-seg-group" style="margin-top:8px;">
                  <button type="button" class="bd-tab" style="color:var(--ink);border-color:var(--ink);${this.stemMode === 'full' ? 'background:var(--ink);color:var(--bone);' : ''}" data-stem="full">Full Mix</button>
                  <button type="button" class="bd-tab" style="color:var(--ink);border-color:var(--ink);${this.stemMode === 'instrumental' ? 'background:var(--ink);color:var(--bone);' : ''}" data-stem="instrumental">Instrumental (L-R)</button>
                  <button type="button" class="bd-tab" style="color:var(--ink);border-color:var(--ink);${this.stemMode === 'vocals' ? 'background:var(--ink);color:var(--bone);' : ''}" data-stem="vocals">Vocal Focus</button>
                </div>
              </div>
            `
                : ''
            }
          </div>

          <div class="bd-inspector-right bd-pixel-host" id="bd-inspector-right-host">
            <div id="bd-dl-status-wrap">${this.renderDownloadStatusHtml()}</div>

            <div class="bd-primary-dl-bar">
              ${
                m.kind === 'video'
                  ? `<button type="button" class="bd-btn bd-btn-solar" data-primary-dl="mp4-1080" ${this.downloadBusyFormat ? 'disabled' : ''}>${renderVectorIcon('download')} <span>${escapeHtml(copy.downloadVideoBtn)}</span></button>
                     <button type="button" class="bd-btn bd-btn-bone" style="background:var(--c2);color:var(--ink);border-color:var(--c2);" data-primary-dl="mp3-320" ${this.downloadBusyFormat ? 'disabled' : ''}>${renderVectorIcon('music')} <span>${escapeHtml(copy.downloadAudioBtn)}</span></button>`
                  : `<button type="button" class="bd-btn bd-btn-solar" style="background:var(--c2);color:var(--ink);border-color:var(--c2);" data-primary-dl="mp3-320" ${this.downloadBusyFormat ? 'disabled' : ''}>${renderVectorIcon('download')} <span>${escapeHtml(copy.downloadAudioBtn)}</span></button>
                     <button type="button" class="bd-btn bd-btn-bone" data-primary-dl="wav" ${this.downloadBusyFormat ? 'disabled' : ''}>${renderVectorIcon('download')} <span>WAV Lossless</span></button>`
              }
              <span class="bd-mono-label" style="color:var(--muted-bone);font-size:10px;">
                PNG/JPG/WEBP = Cover Art Only
              </span>
            </div>

            <div class="bd-format-grid">
              ${m.formats
                .map(
                  (f) => `
                  <button
                    type="button"
                    class="bd-format-tile"
                    data-cat="${f.category}"
                    data-format-id="${f.id}"
                    ${this.downloadBusyFormat ? 'disabled' : ''}
                  >
                    <div class="bd-format-ext">${escapeHtml(f.ext.toUpperCase())}</div>
                    <div class="bd-format-sub">${escapeHtml(f.quality)} · ${escapeHtml(f.codec)}</div>
                    <div class="bd-mono-label bd-format-dl-state" style="margin-top:auto;font-size:10px;display:inline-flex;align-items:center;gap:4px;">${this.downloadBusyFormat === f.id ? 'TRANSCODING...' : `${f.category === 'image' ? 'COVER ONLY' : 'DOWNLOAD'} ${renderVectorIcon('down')}`}</div>
                  </button>
                `
                )
                .join('')}
            </div>

            <div id="bd-inspector-lyrics-wrap" style="border-top:1px solid var(--rule-dark);padding-top:12px;">
              ${this.renderLyricsBoxHtml(true)}
            </div>

            ${
              m.playlistItems && m.playlistItems.length > 0
                ? `<div style="border-top:1px solid var(--rule-dark);padding-top:14px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                      <span class="bd-mono-label" style="color:var(--c1);">EXTRACTED TRACKLIST / ALBUM (${m.playlistItems.length})</span>
                      <button type="button" id="bd-save-playlist-btn" class="bd-mini-btn" style="background:var(--mint);color:var(--ink);border-color:var(--mint);">${renderVectorIcon('plus')} <span>Save All to Device</span></button>
                    </div>
                    <div class="bd-playlist-strip">
                      ${m.playlistItems
                        .map(
                          (item, idx) => `
                          <button type="button" class="bd-playlist-row" data-playlist-idx="${idx}">
                            <div style="min-width:0;">
                              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" dir="auto">${idx + 1}. ${escapeHtml(item.title)}</div>
                              <div class="bd-mono-label" style="font-size:10px;color:var(--muted-bone);">${escapeHtml(item.creator)} · ${escapeHtml(item.durationLabel)}</div>
                            </div>
                            <span class="bd-mono-label" style="color:var(--c1);font-size:10px;display:inline-flex;align-items:center;gap:4px;"><span>EXTRACT</span> ${renderVectorIcon('arrow-right')}</span>
                          </button>
                        `
                        )
                        .join('')}
                    </div>
                  </div>`
                : ''
            }
          </div>
        </div>
      </section>
    `;

    this.inspectorTrail?.destroy();
    this.inspectorTrail = null;
    const rightHost = document.getElementById('bd-inspector-right-host');
    if (rightHost) {
      this.inspectorTrail = new PixelTrailController(rightHost, { cellSize: 24 });
    }
    const inspLyricsWrap = document.getElementById('bd-inspector-lyrics-wrap');
    if (inspLyricsWrap) this.wireLyricsButtons(inspLyricsWrap);

    slot.querySelectorAll<HTMLElement>('[data-primary-dl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.primaryDl as TargetFormatId;
        const fmt =
          this.inspectedMedia?.formats.find((f) => f.id === targetId) ??
          this.inspectedMedia?.formats.find((f) => f.category === (targetId.startsWith('mp3') || targetId === 'wav' ? 'audio' : 'video'));
        if (fmt) void this.handleFormatDownload(fmt);
      });
    });

    document.getElementById('bd-inspector-bookmark-btn')?.addEventListener('click', () => {
      void this.handleBookmarkTap({
        id: m.id,
        title: m.title,
        creator: m.creator,
        platform: m.platform,
        kind: m.kind,
        albumOrTag: m.platform.toUpperCase(),
        durationSec: m.durationSec,
        durationLabel: m.durationLabel,
        sourceUrl: m.sourceUrl,
        streamUrl: m.previewStreamUrl || m.directAudioUrl || m.directVideoUrl,
        directVideoUrl: m.directVideoUrl,
        directAudioUrl: m.directAudioUrl,
        embedPlayerUrl: m.embedPlayerUrl,
        thumbnailUrl: m.thumbnailUrl,
        description: m.description,
        keywords: m.keywords,
        transcriptText: m.transcriptText,
        extractorNote: m.extractorNote,
        lyricsText: m.lyricsText,
      });
    });

    document.getElementById('bd-inspector-expand-btn')?.addEventListener('click', () => {
      if (!this.activeBgTrack) {
        this.activeBgTrack = {
          id: m.id,
          title: m.title,
          creator: m.creator,
          src: m.previewStreamUrl || m.directAudioUrl || '',
          artwork: m.thumbnailUrl || '/pwa-512x512.png',
          sourceUrl: m.sourceUrl,
          platform: m.platform,
          kind: m.kind,
          durationLabel: m.durationLabel,
        };
      }
      this.playerSheetExpanded = true;
      this.renderNowPlayingSheet();
    });

    slot.querySelectorAll<HTMLElement>('[data-format-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.formatId;
        const fmt = this.inspectedMedia?.formats.find((f) => f.id === id);
        if (fmt) void this.handleFormatDownload(fmt);
      });
    });

    // Fullscreen & Picture-in-Picture cinema handlers
    const stageBox = document.getElementById('bd-video-stage-box');
    const videoEl = document.getElementById('bd-preview-video') as HTMLVideoElement | null;
    document.getElementById('bd-fullscreen-btn')?.addEventListener('click', async () => {
      const target = (videoEl || stageBox) as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
        webkitEnterFullscreen?: () => void;
      };
      try {
        if (target?.requestFullscreen) {
          await target.requestFullscreen();
        } else if (target?.webkitRequestFullscreen) {
          await target.webkitRequestFullscreen();
        } else if (
          videoEl &&
          typeof (videoEl as unknown as { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen ===
            'function'
        ) {
          (videoEl as unknown as { webkitEnterFullscreen: () => void }).webkitEnterFullscreen();
        }
      } catch {
        // Fullscreen blocked by browser policy
      }
    });

    document.getElementById('bd-pip-btn')?.addEventListener('click', async () => {
      if (videoEl && document.pictureInPictureEnabled) {
        try {
          await videoEl.requestPictureInPicture();
        } catch {
          // ignore
        }
      }
    });

    // Play/pause & seek wired to either active video or persistent background audio
    const playBtn = document.getElementById('bd-player-toggle');
    const trackEl = document.getElementById('bd-player-track');

    if (videoEl) {
      videoEl.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
          this.playerDurationSec = videoEl.duration;
          this.updatePlayerProgressDom();
        }
      });
      videoEl.addEventListener('timeupdate', () => {
        this.playerCurrentSec = videoEl.currentTime;
        this.updatePlayerProgressDom();
      });
      videoEl.addEventListener('play', () => {
        this.playerPlaying = true;
        this.mascotStage?.setAudioActive(true);
        this.syncPlayButtonLabel();
        if (this.inspectedMedia) {
          void this.triggerClipBackgroundStudy({
            title: this.inspectedMedia.title,
            creator: this.inspectedMedia.creator,
            platform: this.inspectedMedia.platform,
            kind: this.inspectedMedia.kind,
            thumbnailUrl: this.inspectedMedia.thumbnailUrl,
            lyricsText: this.inspectedMedia.lyricsText,
            bpm: this.clientAnalysis?.bpm,
          });
        }
      });
      videoEl.addEventListener('pause', () => {
        this.playerPlaying = false;
        this.mascotStage?.setAudioActive(false);
        this.syncPlayButtonLabel();
      });
    }

    playBtn?.addEventListener('click', () => {
      void this.toggleActiveAudioPlayback();
    });

    trackEl?.addEventListener('click', (e) => {
      const rect = trackEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const activeEl: HTMLMediaElement | null = videoEl || this.bgAudio;
      if (activeEl) {
        const dur = activeEl.duration || this.playerDurationSec || 30;
        activeEl.currentTime = ratio * dur;
      }
    });

    slot.querySelectorAll<HTMLElement>('[data-stem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.stem as StemListeningMode;
        if (this.bgAudio) this.stemController.attach(this.bgAudio);
        this.stemMode = mode;
        this.stemController.setMode(mode);
        slot.querySelectorAll<HTMLElement>('[data-stem]').forEach((el) => {
          const active = el.dataset.stem === mode;
          el.style.background = active ? 'var(--ink)' : 'transparent';
          el.style.color = active ? 'var(--bone)' : 'var(--ink)';
        });
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-playlist-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number.parseInt(btn.dataset.playlistIdx ?? '-1', 10);
        const track = this.inspectedMedia?.playlistItems?.[idx];
        if (track?.sourceUrl) {
          void this.inspectUrl(track.sourceUrl, track);
        }
      });
    });

    document.getElementById('bd-save-playlist-btn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const tracks = this.inspectedMedia?.playlistItems ?? [];
      for (const t of tracks) {
        const trackItem: DeviceLibraryItem = {
          id: t.id,
          title: t.title,
          creator: t.creator,
          platform: t.platform,
          kind: t.kind,
          category: 'albums',
          albumOrTag: this.inspectedMedia?.title.slice(0, 32) || 'Album',
          durationSec: t.durationSec,
          durationLabel: t.durationLabel,
          sourceUrl: t.sourceUrl,
          streamUrl: t.previewStreamUrl,
          thumbnailUrl: t.thumbnailUrl,
          savedAt: new Date().toISOString(),
        };
        await saveToDeviceLibrary(trackItem);
        void syncLibraryItemToFirestore(trackItem);
      }
      btn.innerHTML = `${renderVectorIcon('check')} <span>Saved ${tracks.length} Tracks</span>`;
      await this.refreshDeviceLibrary();
    });
  }

  private renderResultsAndLibrary(): void {
    const slot = document.getElementById('search-results');
    if (!slot) return;
    const copy = UI_COPY[this.lang];
    this.saveFolders = listSaveFolders();
    const filteredLib = this.getFilteredLibraryItems();
    const libSearchLower = this.librarySearchQuery.trim().toLowerCase();
    const filteredLive = libSearchLower
      ? this.searchResults.filter(
          (item) =>
            item.title.toLowerCase().includes(libSearchLower) ||
            item.creator.toLowerCase().includes(libSearchLower) ||
            item.platform.toLowerCase().includes(libSearchLower)
        )
      : this.searchResults;

    slot.innerHTML = `
      <div class="bd-section-header">
        <div>
          <h2 class="bd-h2">Live Media Results &amp; Device Library</h2>
          <div class="bd-mono-label" style="color:var(--muted-bone);margin-top:4px;">
            STORED ON YOUR DEVICE ONLY (${this.libraryItems.length} SAVED · ${this.deviceUsedMb} MB LOCAL${this.saveFeedbackBanner ? ` · ${escapeHtml(this.saveFeedbackBanner)}` : ''})
          </div>
        </div>
        <div class="bd-seg-group">
          <button type="button" class="bd-tab" data-results-tab="live" aria-pressed="${this.resultsTab === 'live'}">${escapeHtml(copy.resultsTabAll)} (${filteredLive.length})</button>
          <button type="button" class="bd-tab" data-results-tab="library" aria-pressed="${this.resultsTab === 'library'}">${escapeHtml(copy.resultsTabLibrary)} (${this.libraryItems.length})</button>
          <button type="button" class="bd-tab" data-view-mode="grid" aria-pressed="${this.resultsViewMode === 'grid'}">${escapeHtml(copy.gridViewLabel)}</button>
          <button type="button" class="bd-tab" data-view-mode="list" aria-pressed="${this.resultsViewMode === 'list'}">${escapeHtml(copy.listViewLabel)}</button>
          <button type="button" id="bd-lib-upload-trigger" class="bd-btn bd-btn-solar" style="min-height:34px;padding:7px 14px;">${renderVectorIcon('plus')} <span>${escapeHtml(copy.libraryUploadBtn)}</span></button>
          <input id="bd-lib-upload-input" type="file" accept="video/*,audio/*,image/*,.mp4,.webm,.mkv,.mov,.avi,.m4v,.mp3,.wav,.flac,.aac,.ogg,.m4a,.opus,.png,.jpg,.jpeg,.webp" multiple style="display:none;" />
        </div>
      </div>

      <div class="bd-library-bar">
        <input
          id="bd-lib-search-input"
          class="bd-input"
          type="text"
          dir="auto"
          style="min-height:40px;padding:8px 12px;flex:1;min-width:200px;"
          value="${escapeHtml(this.librarySearchQuery)}"
          placeholder="${escapeHtml(copy.librarySearchPlaceholder)}"
        />
        <div class="bd-seg-group">
          <button type="button" class="bd-tab" data-lib-cat="all" aria-pressed="${this.libraryCategoryFilter === 'all'}">All</button>
          <button type="button" class="bd-tab" data-lib-cat="music" aria-pressed="${this.libraryCategoryFilter === 'music'}">Music</button>
          <button type="button" class="bd-tab" data-lib-cat="video" aria-pressed="${this.libraryCategoryFilter === 'video'}">Video</button>
          <button type="button" class="bd-tab" data-lib-cat="albums" aria-pressed="${this.libraryCategoryFilter === 'albums'}">Albums</button>
          <button type="button" class="bd-mini-btn" id="bd-isolate-toggle" aria-pressed="${this.isolatedOnly ? 'true' : 'false'}">Pinned</button>
        </div>

        <div class="bd-seg-group" style="width:100%;padding-top:6px;border-top:1px solid var(--rule-dark);align-items:center;">
          <span class="bd-mono-label" style="align-self:center;color:var(--c1);margin-inline-end:6px;">ORDER:</span>
          <button type="button" class="bd-mini-btn" data-play-order="sequential" aria-pressed="${this.playOrderMode === 'sequential' ? 'true' : 'false'}">${renderVectorIcon('order')} <span>${escapeHtml(copy.orderSequential)}</span></button>
          <button type="button" class="bd-mini-btn" data-play-order="shuffle" aria-pressed="${this.playOrderMode === 'shuffle' ? 'true' : 'false'}">${renderVectorIcon('shuffle')} <span>${escapeHtml(copy.orderShuffle)}</span></button>
          <button type="button" class="bd-mini-btn" id="bd-play-queue-btn" style="background:var(--mint);color:var(--ink);border-color:var(--mint);">${renderVectorIcon('play')} <span>${escapeHtml(copy.playQueueBtn)}</span></button>
        </div>

        <div class="bd-seg-group" style="width:100%;padding-top:6px;border-top:1px solid var(--rule-dark);">
          <span class="bd-mono-label" style="align-self:center;color:var(--c1);margin-inline-end:6px;">FOLDERS:</span>
          <button type="button" class="bd-mini-btn" data-folder-filter="all" aria-pressed="${this.libraryFolderFilter === 'all'}">All Folders</button>
          ${this.saveFolders
            .map(
              (f) =>
                `<button type="button" class="bd-mini-btn" data-folder-filter="${escapeHtml(f)}" aria-pressed="${this.libraryFolderFilter.toLowerCase() === f.toLowerCase()}">${escapeHtml(f)}</button>`
            )
            .join('')}
        </div>

        ${(() => {
          const artists = this.getAvailableLibraryArtists();
          if (artists.length === 0) return '';
          return `
            <div class="bd-seg-group" style="width:100%;padding-top:6px;border-top:1px solid var(--rule-dark);">
              <span class="bd-mono-label" style="align-self:center;color:var(--c2);margin-inline-end:6px;">ARTISTS:</span>
              <button type="button" class="bd-mini-btn" data-artist-filter="all" aria-pressed="${this.selectedArtistFilter === 'all' ? 'true' : 'false'}">${escapeHtml(copy.allArtistsLabel)}</button>
              ${artists
                .slice(0, 12)
                .map(
                  (a) =>
                    `<button type="button" class="bd-mini-btn" data-artist-filter="${escapeHtml(a.name)}" aria-pressed="${this.selectedArtistFilter.toLowerCase() === a.name.toLowerCase() ? 'true' : 'false'}">${escapeHtml(a.name)} (${a.count})</button>`
                )
                .join('')}
            </div>
          `;
        })()}
      </div>

      ${
        this.resultsTab === 'live'
          ? `
        <div class="${this.resultsViewMode === 'list' ? 'bd-results-list' : 'bd-results-grid'}">
          ${
            this.searching
              ? Array.from({ length: 6 })
                  .map(
                    () => `
                  <div class="bd-media-card" style="min-height:175px;opacity:0.45;">
                    <div class="bd-media-thumb"></div>
                    <div class="bd-media-body"><div class="bd-mono-label">LOADING...</div></div>
                  </div>
                `
                  )
                  .join('')
              : filteredLive
                  .map((item, idx) => {
                    const realIdx = this.searchResults.indexOf(item) >= 0 ? this.searchResults.indexOf(item) : idx;
                    const isPlayingTrack = this.activeBgTrack?.id === item.id;
                    const savedRec = this.isSavedOnDevice(item.id, item.sourceUrl);
                    if (this.resultsViewMode === 'list') {
                      return `
                        <div class="bd-list-row" data-playing="${isPlayingTrack ? 'true' : 'false'}">
                          <button type="button" data-result-index="${realIdx}" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;text-align:start;">
                            <div class="bd-list-thumb">
                              ${
                                item.thumbnailUrl
                                  ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" />`
                                  : `<span class="bd-mono-label" style="font-size:9px;">${escapeHtml(item.platform.slice(0, 4).toUpperCase())}</span>`
                              }
                            </div>
                            <div style="min-width:0;flex:1;">
                              <div class="bd-media-title" style="-webkit-line-clamp:1;" dir="auto">${escapeHtml(item.title)}</div>
                              <div class="bd-media-meta">${escapeHtml(item.creator)} · ${escapeHtml(item.platform.toUpperCase())} · ${escapeHtml(item.durationLabel)}</div>
                            </div>
                            ${isPlayingTrack ? `<span style="color:var(--c1);">${renderEqBarsHtml()}</span>` : ''}
                          </button>
                          <button type="button" class="bd-mini-btn" data-inspect-live-idx="${realIdx}" title="Formats & Download">${renderVectorIcon('down')}</button>
                          <button
                            type="button"
                            class="bd-bookmark-btn"
                            data-save-live-idx="${realIdx}"
                            data-saved="${savedRec ? 'true' : 'false'}"
                            aria-label="Save ${escapeHtml(item.title)}"
                          >${renderBookmarkSvg(Boolean(savedRec))}</button>
                        </div>
                      `;
                    }
                    return `
                      <div class="bd-media-card" data-playing="${isPlayingTrack ? 'true' : 'false'}" aria-current="${this.inspectedMedia?.id === item.id || isPlayingTrack ? 'true' : 'false'}">
                        <button
                          type="button"
                          style="text-align:start;display:flex;flex-direction:column;flex:1;"
                          data-result-index="${realIdx}"
                        >
                          <div class="bd-media-thumb">
                            ${
                              isPlayingTrack
                                ? `<div class="bd-playing-badge">${renderEqBarsHtml()}<span>${this.playerPlaying ? 'PLAYING' : 'PAUSED'}</span></div>`
                                : ''
                            }
                            ${
                              item.thumbnailUrl
                                ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" />`
                                : `<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:11px;">${escapeHtml(item.platform.toUpperCase())}</div>`
                            }
                          </div>
                          <div class="bd-media-body">
                            <div class="bd-media-meta">${escapeHtml(item.platform.toUpperCase())} · ${escapeHtml(item.durationLabel)}</div>
                            <div class="bd-media-title" dir="auto">${escapeHtml(item.title)}</div>
                            <div class="bd-media-meta" style="margin-top:auto;">${escapeHtml(item.creator)}</div>
                          </div>
                        </button>
                        <div class="bd-library-actions" style="padding:6px 10px 8px;">
                          <button type="button" class="bd-mini-btn" data-inspect-live-idx="${realIdx}"><span>Formats</span> ${renderVectorIcon('down')}</button>
                          <button
                            type="button"
                            class="bd-bookmark-btn"
                            data-save-live-idx="${realIdx}"
                            data-saved="${savedRec ? 'true' : 'false'}"
                            aria-label="Save ${escapeHtml(item.title)}"
                            title="${savedRec ? `${copy.savedToLabel} ${savedRec.folderName || 'Favorites'}` : copy.saveBookmarkLabel}"
                          >
                            ${renderBookmarkSvg(Boolean(savedRec))}
                            <span>${savedRec ? escapeHtml((savedRec.folderName || 'Saved').slice(0, 10)) : escapeHtml(copy.saveBookmarkLabel)}</span>
                          </button>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      `
          : `
        ${
          filteredLib.length === 0
            ? `<div class="bd-block-paper" style="background:var(--ghost);color:var(--bone);border-color:var(--rule-dark);">
                <div class="bd-mono-label" style="color:var(--c1);">ON-DEVICE LIBRARY IS EMPTY FOR THIS FILTER</div>
                <p style="font-size:14px;margin-top:8px;color:var(--muted-bone);">Tap the Save bookmark ribbon on any track or video, or paste a URL above to extract and auto-save it.</p>
               </div>`
            : `
          <div class="${this.resultsViewMode === 'list' ? 'bd-results-list' : 'bd-results-grid'}">
            ${filteredLib
              .map((item) => {
                const isPlayingTrack = this.activeBgTrack?.id === item.id;
                if (this.resultsViewMode === 'list') {
                  return `
                    <div class="bd-list-row" data-playing="${isPlayingTrack ? 'true' : 'false'}">
                      <button type="button" data-lib-play="${escapeHtml(item.id)}" style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;text-align:start;">
                        <div class="bd-list-thumb">
                          ${
                            item.thumbnailUrl
                              ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" />`
                              : `<span class="bd-mono-label" style="font-size:9px;color:var(--c1);">${escapeHtml(item.kind.toUpperCase())}</span>`
                          }
                        </div>
                        <div style="min-width:0;flex:1;">
                          <div class="bd-media-title" style="-webkit-line-clamp:1;" dir="auto">${escapeHtml(item.title)}</div>
                          <div class="bd-media-meta">${escapeHtml(item.folderName || 'Favorites')} · ${escapeHtml(item.creator)} · ${escapeHtml(item.durationLabel)}</div>
                        </div>
                        ${isPlayingTrack ? `<span style="color:var(--c1);">${renderEqBarsHtml()}</span>` : ''}
                      </button>
                      <button type="button" class="bd-mini-btn" data-lib-inspect="${escapeHtml(item.id)}" title="Formats & Download">${renderVectorIcon('down')}</button>
                      <button type="button" class="bd-bookmark-btn" data-lib-folder="${escapeHtml(item.id)}" data-saved="true">${renderBookmarkSvg(true)}</button>
                      <button type="button" class="bd-mini-btn" data-lib-del="${escapeHtml(item.id)}">Del</button>
                    </div>
                  `;
                }
                return `
                <div class="bd-media-card" data-playing="${isPlayingTrack ? 'true' : 'false'}" aria-current="${isPlayingTrack ? 'true' : 'false'}">
                  <button type="button" data-lib-play="${escapeHtml(item.id)}" style="text-align:start;display:flex;flex-direction:column;flex:1;">
                    <div class="bd-media-thumb">
                      ${
                        isPlayingTrack
                          ? `<div class="bd-playing-badge">${renderEqBarsHtml()}<span>${this.playerPlaying ? 'PLAYING' : 'PAUSED'}</span></div>`
                          : ''
                      }
                      ${
                        item.thumbnailUrl
                          ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" />`
                          : `<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:11px;color:var(--c1);">${escapeHtml(item.kind.toUpperCase())}</div>`
                      }
                    </div>
                    <div class="bd-media-body">
                      <div class="bd-media-meta">${escapeHtml(item.folderName || item.category.toUpperCase())} · ${escapeHtml(item.durationLabel)}</div>
                      <div class="bd-media-title" dir="auto">${escapeHtml(item.title)}</div>
                      <div class="bd-media-meta" style="margin-top:auto;">${escapeHtml(item.creator)}</div>
                    </div>
                  </button>
                  <div class="bd-library-actions" style="padding:6px 10px 8px;flex-wrap:wrap;">
                    <button type="button" class="bd-mini-btn" data-lib-inspect="${escapeHtml(item.id)}"><span>Formats</span> ${renderVectorIcon('down')}</button>
                    <button type="button" class="bd-mini-btn" data-lib-isolate="${escapeHtml(item.id)}" aria-pressed="${item.isolated ? 'true' : 'false'}">${item.isolated ? renderVectorIcon('pin') : 'Pin'}</button>
                    <button type="button" class="bd-bookmark-btn" data-lib-folder="${escapeHtml(item.id)}" data-saved="true">${renderBookmarkSvg(true)} <span>${escapeHtml((item.folderName || 'Folder').slice(0, 9))}</span></button>
                    <button type="button" class="bd-mini-btn" data-lib-del="${escapeHtml(item.id)}">Del</button>
                  </div>
                </div>
              `;
              })
              .join('')}
          </div>
        `
        }
      `
      }
    `;

    slot.querySelectorAll<HTMLElement>('[data-results-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextTab = btn.dataset.resultsTab as 'live' | 'library';
        this.resultsTab = nextTab;
        this.renderResultsAndLibrary();
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-view-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.resultsViewMode = btn.dataset.viewMode as 'grid' | 'list';
        this.renderResultsAndLibrary();
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-play-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.playOrderMode =
          btn.dataset.playOrder === 'shuffle' ? 'shuffle' : 'sequential';
        this.renderResultsAndLibrary();
        this.renderNowPlayingSheet();
      });
    });

    document.getElementById('bd-play-queue-btn')?.addEventListener('click', () => {
      const libQueue = this.getFilteredLibraryItems().filter((it) =>
        Boolean(it.localBlob || it.streamUrl || it.directAudioUrl || it.directVideoUrl)
      );
      if (this.resultsTab === 'library' && libQueue.length > 0) {
        const startIdx = this.playOrderMode === 'shuffle' ? Math.floor(Math.random() * libQueue.length) : 0;
        const first = libQueue[startIdx];
        if (first) void this.playLibraryItemInBackground(first);
        return;
      }
      if (this.searchResults.length > 0) {
        const startIdx =
          this.playOrderMode === 'shuffle' ? Math.floor(Math.random() * this.searchResults.length) : 0;
        const first = this.searchResults[startIdx];
        if (first) void this.playLiveSearchItem(first);
      } else if (libQueue.length > 0) {
        const first = libQueue[0];
        if (first) void this.playLibraryItemInBackground(first);
      }
    });

    slot.querySelectorAll<HTMLElement>('[data-artist-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedArtistFilter = btn.dataset.artistFilter || 'all';
        this.resultsTab = 'library';
        this.renderResultsAndLibrary();
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-folder-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.libraryFolderFilter = btn.dataset.folderFilter || 'all';
        this.resultsTab = 'library';
        this.renderResultsAndLibrary();
      });
    });

    const uploadInput = document.getElementById('bd-lib-upload-input') as HTMLInputElement | null;
    document.getElementById('bd-lib-upload-trigger')?.addEventListener('click', () => {
      uploadInput?.click();
    });
    uploadInput?.addEventListener('change', () => {
      if (uploadInput.files && uploadInput.files.length > 0) {
        void this.handleFilesUploadedToLibrary(uploadInput.files);
      }
    });

    const libSearchInput = document.getElementById('bd-lib-search-input') as HTMLInputElement | null;
    libSearchInput?.addEventListener('input', () => {
      this.librarySearchQuery = libSearchInput.value;
      const cursor = libSearchInput.selectionStart ?? libSearchInput.value.length;
      this.renderResultsAndLibrary();
      const restored = document.getElementById('bd-lib-search-input') as HTMLInputElement | null;
      if (restored) {
        restored.focus();
        restored.setSelectionRange(cursor, cursor);
      }
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.libraryCategoryFilter = btn.dataset.libCat as 'all' | LibraryCategory;
        this.resultsTab = 'library';
        this.renderResultsAndLibrary();
      });
    });

    document.getElementById('bd-isolate-toggle')?.addEventListener('click', () => {
      this.isolatedOnly = !this.isolatedOnly;
      this.resultsTab = 'library';
      this.renderResultsAndLibrary();
    });

    // Tapping a card plays immediately Spotify-style!
    slot.querySelectorAll<HTMLElement>('[data-result-index]').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = Number.parseInt(card.dataset.resultIndex ?? '-1', 10);
        const item = this.searchResults[idx];
        if (item) void this.playLiveSearchItem(item);
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-inspect-live-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number.parseInt(btn.dataset.inspectLiveIdx ?? '-1', 10);
        const item = this.searchResults[idx];
        if (item?.sourceUrl) void this.inspectUrl(item.sourceUrl, item);
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-save-live-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number.parseInt(btn.dataset.saveLiveIdx ?? '-1', 10);
        const item = this.searchResults[idx];
        if (!item) return;
        void this.handleBookmarkTap({
          id: item.id,
          title: item.title,
          creator: item.creator,
          platform: item.platform,
          kind: item.kind,
          albumOrTag: item.genreOrTag || item.platform.toUpperCase(),
          durationSec: item.durationSec,
          durationLabel: item.durationLabel,
          sourceUrl: item.sourceUrl,
          streamUrl: item.previewStreamUrl,
          thumbnailUrl: item.thumbnailUrl,
        });
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-play]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.libPlay;
        const item = this.libraryItems.find((it) => it.id === id);
        if (item) void this.playLibraryItemInBackground(item);
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-inspect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.libInspect;
        const item = this.libraryItems.find((it) => it.id === id);
        if (!item) return;
        if (item.sourceUrl && !item.sourceUrl.startsWith('local://')) {
          void this.inspectUrl(item.sourceUrl, {
            id: item.id,
            title: item.title,
            creator: item.creator,
            platform: item.platform,
            kind: item.kind,
            durationSec: item.durationSec,
            durationLabel: item.durationLabel,
            thumbnailUrl: item.thumbnailUrl || '',
            sourceUrl: item.sourceUrl,
            previewStreamUrl: item.streamUrl || item.directAudioUrl || item.directVideoUrl,
          });
        }
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-folder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.libFolder;
        const item = this.libraryItems.find((it) => it.id === id);
        if (!item) return;
        this.folderPickerTarget = {
          id: item.id,
          title: item.title,
          creator: item.creator,
          platform: item.platform,
          kind: item.kind,
          albumOrTag: item.albumOrTag,
          durationSec: item.durationSec,
          durationLabel: item.durationLabel,
          sourceUrl: item.sourceUrl,
          streamUrl: item.streamUrl,
          directVideoUrl: item.directVideoUrl,
          directAudioUrl: item.directAudioUrl,
          embedPlayerUrl: item.embedPlayerUrl,
          thumbnailUrl: item.thumbnailUrl,
          description: item.description,
          keywords: item.keywords,
          transcriptText: item.transcriptText,
          extractorNote: item.extractorNote,
          lyricsText: item.lyricsText,
        };
        this.renderFolderPickerModal();
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-isolate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.libIsolate;
        const item = this.libraryItems.find((it) => it.id === id);
        if (!item) return;
        await updateDeviceLibraryItem(item.id, { isolated: !item.isolated });
        void syncLibraryItemToFirestore({ ...item, isolated: !item.isolated });
        await this.refreshDeviceLibrary();
      });
    });

    slot.querySelectorAll<HTMLElement>('[data-lib-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.libDel;
        if (!id) return;
        await removeFromDeviceLibrary(id);
        void deleteLibraryItemFromFirestore(id);
        await this.refreshDeviceLibrary();
      });
    });
  }

  private renderConverterSection(): void {
    const slot = document.getElementById('converter');
    if (!slot) return;
    const copy = UI_COPY[this.lang];

    slot.innerHTML = `
      <div class="bd-block-paper" style="background:var(--ghost);color:var(--bone);border-color:var(--rule-dark);">
        <div class="bd-section-header">
          <div>
            <div class="bd-kicker">FFMPEG + CLIENT CANVAS / WORKER</div>
            <h2 class="bd-h2" style="margin-top:6px;">${escapeHtml(copy.localDropTitle)}</h2>
          </div>
          <span class="bd-mono-label" style="color:var(--mint);">ANY VIDEO, AUDIO, OR IMAGE</span>
        </div>
        <p class="bd-lead" style="margin-bottom:18px;">${escapeHtml(copy.localDropSub)}</p>

        <div id="bd-dropzone" class="bd-dropzone bd-pixel-host">
          <input id="bd-local-file-input" type="file" accept="video/*,audio/*,image/*,.mp4,.webm,.mkv,.mov,.avi,.m4v,.mp3,.wav,.flac,.aac,.ogg,.m4a,.opus,.png,.jpg,.jpeg,.webp" multiple style="display:none;" />
          <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
            <button type="button" id="bd-pick-file-btn" class="bd-btn bd-btn-solar">${escapeHtml(copy.localPickFile)}</button>
            <span class="bd-mono-label" style="color:var(--muted-bone);">${this.localFile ? escapeHtml(this.localFile.name) : 'DRAG & DROP OR PICK FILES / ALBUMS (SAVED ON YOUR DEVICE)'}</span>
          </div>

          <div style="width:100%;margin-top:6px;">
            <div class="bd-mono-label" style="margin-bottom:8px;">TARGET OUTPUT FORMAT:</div>
            <div class="bd-seg-group">
              ${LOCAL_CONVERT_TARGETS.map(
                (t) => `
                  <button
                    type="button"
                    class="bd-tab"
                    data-local-format="${t.id}"
                    aria-pressed="${this.localTargetFormat === t.id}"
                  >${escapeHtml(t.label)}</button>
                `
              ).join('')}
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:8px;">
            <button type="button" id="bd-local-convert-btn" class="bd-btn bd-btn-bone" ${!this.localFile || this.localConverting ? 'disabled' : ''}>
              ${this.localConverting ? 'CONVERTING...' : `CONVERT TO ${this.localTargetFormat.toUpperCase()}`}
            </button>
            ${this.localStatusMsg ? `<span class="bd-mono-label" style="color:var(--c1);">${escapeHtml(this.localStatusMsg)}</span>` : ''}
          </div>
        </div>
      </div>
    `;

    this.dropzoneTrail?.destroy();
    this.dropzoneTrail = null;
    const dropzone = document.getElementById('bd-dropzone');
    if (dropzone) {
      this.dropzoneTrail = new PixelTrailController(dropzone, { cellSize: 22 });
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          void this.handleFilesUploadedToLibrary(e.dataTransfer.files);
        }
      });
    }

    const fileInput = document.getElementById('bd-local-file-input') as HTMLInputElement | null;
    document.getElementById('bd-pick-file-btn')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        void this.handleFilesUploadedToLibrary(fileInput.files);
      }
    });

    slot.querySelectorAll<HTMLElement>('[data-local-format]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.localTargetFormat = btn.dataset.localFormat as TargetFormatId;
        this.renderConverterSection();
      });
    });

    document.getElementById('bd-local-convert-btn')?.addEventListener('click', () => {
      void this.convertLocalFile();
    });
  }

  private renderDownloadSection(): void {
    const slot = document.getElementById('download-section');
    if (!slot) return;
    const copy = UI_COPY[this.lang];
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    const isIos = /iphone|ipad|ipod/.test(ua);

    slot.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:6px;">
        <div class="bd-block-mint">
          <div class="bd-mono-label">PWA · DESKTOP · TABLET · iOS · ANDROID</div>
          <h2 class="bd-h2" style="margin-top:8px;">${escapeHtml(copy.installTitle)}</h2>
          <p style="font-size:15px;line-height:1.55;margin:12px 0 18px;">${escapeHtml(copy.installBody)}</p>
          ${
            this.isStandalone
              ? `<div class="bd-mono-label" style="display:inline-flex;align-items:center;gap:8px;padding:10px 14px;background:var(--ink);color:var(--c1);border:1.5px solid var(--ink);">
                  ${renderVectorIcon('check')}
                  <span>ACTIVE ON THIS DEVICE</span>
                </div>`
              : `<button type="button" id="bd-install-pwa-btn" class="bd-btn bd-btn-ink">
                  ${escapeHtml(copy.installPwaBtn)}
                </button>`
          }
          ${
            this.installNotice
              ? `<div class="bd-mono-label" style="margin-top:12px;color:var(--ink);">${escapeHtml(this.installNotice)}</div>`
              : ''
          }
        </div>
        <div class="bd-block-paper">
          <div class="bd-mono-label" style="margin-bottom:10px;">PLATFORM &amp; MEDIA ENGINE</div>
          <div class="rc"><span>SEARCH SOURCES</span><span class="ld"></span><span>INVIDIOUS · AUDIUS · ARCHIVE</span></div>
          <div class="rc"><span>EXTRACTOR</span><span class="ld"></span><span>COBALT · TIKWM · BANDCAMP · X</span></div>
          <div class="rc"><span>CONVERTER</span><span class="ld"></span><span>FFMPEG + CLIENT CANVAS</span></div>
          <div class="rc"><span>DEVICE LIBRARY</span><span class="ld"></span><span>INDEXEDDB · MEDIA SESSION</span></div>
          <div class="rc"><span>AUDIO ENGINE</span><span class="ld"></span><span>BACKGROUND + LOCK SCREEN</span></div>
        </div>
      </div>

      <div class="bd-device-grid">
        <div class="bd-device-card">
          <div>
            <div class="bd-mono-label" style="color:var(--c1);">WINDOWS · MAC · LINUX</div>
            <h3 style="font-size:18px;font-weight:500;margin-top:6px;">Desktop App</h3>
            <p style="font-size:13px;color:var(--muted-bone);margin-top:6px;">Standalone windowed app with keyboard shortcuts, full-screen 4K cinema view &amp; background playback.</p>
          </div>
          <button type="button" class="bd-btn bd-btn-solar" data-device-install="desktop">Download Desktop</button>
        </div>

        <div class="bd-device-card">
          <div>
            <div class="bd-mono-label" style="color:var(--mint);">ANDROID PHONE &amp; TAB</div>
            <h3 style="font-size:18px;font-weight:500;margin-top:6px;">Android WebAPK</h3>
            <p style="font-size:13px;color:var(--muted-bone);margin-top:6px;">Lock-screen audio controls, background queue playback, and local IndexedDB storage.</p>
          </div>
          <button type="button" class="bd-btn bd-btn-bone" data-device-install="android">Download Android</button>
        </div>

        <div class="bd-device-card">
          <div>
            <div class="bd-mono-label" style="color:var(--c2);">IPHONE &amp; IPAD (iOS)</div>
            <h3 style="font-size:18px;font-weight:500;margin-top:6px;">iOS Home Screen</h3>
            <p style="font-size:13px;color:var(--muted-bone);margin-top:6px;">180px retina icon &amp; native Safari AirPlay / full-screen video player.</p>
          </div>
          <button type="button" class="bd-btn bd-btn-bone" data-device-install="ios">${isIos ? 'Install on iPhone / iPad' : 'iOS Setup Guide'}</button>
        </div>

        <div class="bd-device-card">
          <div>
            <div class="bd-mono-label" style="color:var(--blue);">ALL VIEWPORTS</div>
            <h3 style="font-size:18px;font-weight:500;margin-top:6px;">Tablet &amp; Wide</h3>
            <p style="font-size:13px;color:var(--muted-bone);margin-top:6px;">Adaptive split grid from 390px phones to 1024px tablets and 1920px studio monitors.</p>
          </div>
          <button type="button" class="bd-btn bd-btn-outline" data-device-install="tablet">Install Tablet App</button>
        </div>
      </div>
    `;

    const handleDeviceTrigger = async (target: string) => {
      if (this.deferredPrompt) {
        await this.deferredPrompt.prompt();
        await this.deferredPrompt.userChoice;
        this.deferredPrompt = null;
        this.renderDownloadSection();
        this.renderAppRail();
        return;
      }
      if (target === 'ios') {
        this.installNotice = copy.iosGuideText;
      } else {
        this.installNotice = `Ready on ${target.toUpperCase()}: Open browser menu -> "Install BLUEDROP" or "Add to Home Screen".`;
      }
      this.renderDownloadSection();
    };

    document.getElementById('bd-install-pwa-btn')?.addEventListener('click', () => {
      this.requireGmailAuthThen(() => handleDeviceTrigger(isIos ? 'ios' : 'desktop'));
    });
    slot.querySelectorAll<HTMLElement>('[data-device-install]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.deviceInstall || 'desktop';
        this.requireGmailAuthThen(() => handleDeviceTrigger(target));
      });
    });
  }

  private renderFooterSection(): void {
    const slot = document.getElementById('bd-footer-slot');
    if (!slot) return;
    slot.innerHTML = `
      <div class="bd-container bd-footer-inner">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong style="font-size:16px;letter-spacing:-0.01em;">BLUEDROP</strong>
          <span class="bd-mono-label" style="color:var(--muted-bone);">100% Ad-Free Media Studio</span>
        </div>
        <div class="bd-seg-group">
          ${SEO_PAGES.slice(1)
            .map(
              (p) =>
                `<button type="button" class="bd-link-btn" data-seo-path="${p.path}">${escapeHtml(p.shortLabel)}</button>`
            )
            .join('')}
        </div>
        <div class="bd-mono-label" style="color:var(--c1);">ZERO ADS · ON-DEVICE VAULT</div>
      </div>
    `;
    slot.querySelectorAll<HTMLElement>('[data-seo-path]').forEach((el) => {
      el.addEventListener('click', () => {
        const path = el.dataset.seoPath || '/';
        this.navigateSeoRoute(matchSeoPage(path));
      });
    });
  }

  private renderMiniDock(): void {
    const slot = document.getElementById('bd-mini-dock-slot');
    if (!slot) return;
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('has-mini-dock', Boolean(this.activeBgTrack));
    }
    if (!this.activeBgTrack || this.playerSheetExpanded) {
      slot.innerHTML = '';
      return;
    }
    const copy = UI_COPY[this.lang];
    const t = this.activeBgTrack;
    const dur = this.playerDurationSec || 30;
    const pct = Math.min(100, (this.playerCurrentSec / dur) * 100);
    const savedRec = this.isSavedOnDevice(t.id, t.sourceUrl);

    slot.innerHTML = `
      <div class="bd-mini-dock" role="region" aria-label="Background audio player">
        <div class="bd-mini-progress-edge">
          <div id="bd-mini-progress-fill" class="bd-mini-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="bd-mini-dock-inner">
          <button type="button" id="bd-dock-expand-tap" style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;text-align:start;">
            <div class="bd-list-thumb" style="width:40px;height:40px;">
              ${t.artwork ? `<img src="${escapeHtml(t.artwork)}" alt="" referrerpolicy="no-referrer" />` : `<span class="bd-mono-label" style="font-size:9px;color:var(--c1);">${renderVectorIcon('music')}</span>`}
            </div>
            <div class="bd-mini-dock-meta">
              <div class="bd-mini-dock-title" dir="auto">${escapeHtml(t.title)}</div>
              <div class="bd-mono-label" style="font-size:10px;color:var(--muted-bone);display:flex;align-items:center;gap:6px;">
                ${this.playerPlaying ? `<span style="color:var(--c1);">${renderEqBarsHtml()}</span>` : ''}
                <span>${escapeHtml(t.creator)}</span>
              </div>
            </div>
          </button>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <button type="button" class="bd-bookmark-btn" id="bd-dock-bookmark" data-saved="${savedRec ? 'true' : 'false'}" aria-label="Save track">${renderBookmarkSvg(Boolean(savedRec))}</button>
            <button type="button" class="bd-mini-btn" style="background:var(--c1);color:var(--ink);border-color:var(--c1);" id="bd-dock-toggle">${this.playerPlaying ? 'PAUSE' : 'PLAY'}</button>
            <button type="button" class="bd-mini-btn" id="bd-dock-next">NEXT</button>
            <button type="button" class="bd-mini-btn" id="bd-dock-open-sheet"><span class="bd-hide-mobile">${escapeHtml(copy.expandPlayerLabel)}</span><span class="bd-show-mobile-inline">${renderVectorIcon('up')}</span></button>
            <button type="button" class="bd-mini-btn" id="bd-dock-close">×</button>
          </div>
        </div>
      </div>
    `;

    const openSheet = () => {
      this.playerSheetExpanded = true;
      this.renderMiniDock();
      this.renderNowPlayingSheet();
    };
    document.getElementById('bd-dock-expand-tap')?.addEventListener('click', openSheet);
    document.getElementById('bd-dock-open-sheet')?.addEventListener('click', openSheet);
    document.getElementById('bd-dock-bookmark')?.addEventListener('click', () => {
      void this.handleBookmarkTap({
        id: t.id,
        title: t.title,
        creator: t.creator,
        platform: t.platform || 'direct',
        kind: t.kind || 'audio',
        albumOrTag: (t.platform || 'AUDIO').toUpperCase(),
        durationSec: Math.round(this.playerDurationSec || 30),
        durationLabel: t.durationLabel || formatClock(this.playerDurationSec || 30),
        sourceUrl: t.sourceUrl || t.src,
        streamUrl: t.src,
        thumbnailUrl: t.artwork,
        lyricsText: this.activeLyrics?.text,
      });
    });
    document.getElementById('bd-dock-toggle')?.addEventListener('click', () => {
      void this.toggleActiveAudioPlayback();
    });
    document.getElementById('bd-dock-next')?.addEventListener('click', () => {
      void this.playNextInQueue(1);
    });
    document.getElementById('bd-dock-close')?.addEventListener('click', () => {
      this.bgAudio?.pause();
      this.activeBgTrack = null;
      this.playerPlaying = false;
      this.playerSheetExpanded = false;
      this.mascotStage?.setAudioActive(false);
      this.renderMiniDock();
      this.renderNowPlayingSheet();
      this.renderResultsAndLibrary();
    });
  }

  private renderNowPlayingSheet(): void {
    const slot = document.getElementById('bd-now-playing-slot');
    if (!slot) return;
    if (!this.playerSheetExpanded || !this.activeBgTrack) {
      slot.innerHTML = '';
      return;
    }

    const copy = UI_COPY[this.lang];
    const t = this.activeBgTrack;
    const savedRec = this.isSavedOnDevice(t.id, t.sourceUrl);
    const dur = this.playerDurationSec || 30;
    const pct = Math.min(100, (this.playerCurrentSec / dur) * 100);

    slot.innerHTML = `
      <div class="bd-now-playing-sheet" role="dialog" aria-modal="true" aria-label="Now Playing Studio">
        <div class="bd-sheet-topbar">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="color:var(--c1);">${renderEqBarsHtml()}</span>
            <span class="bd-mono-label" style="color:var(--c1);">NOW PLAYING · SPOTIFY STUDIO</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" id="bd-sheet-bookmark" class="bd-bookmark-btn" data-saved="${savedRec ? 'true' : 'false'}">
              ${renderBookmarkSvg(Boolean(savedRec))}
              <span>${savedRec ? escapeHtml(savedRec.folderName || 'Saved') : escapeHtml(copy.saveBookmarkLabel)}</span>
            </button>
            <button type="button" id="bd-sheet-minimize" class="bd-btn bd-btn-solar" style="min-height:36px;padding:6px 14px;">${escapeHtml(copy.minimizePlayerLabel)}</button>
          </div>
        </div>

        <div class="bd-sheet-grid">
          <div style="background:var(--ghost);border:1.5px solid var(--rule-dark);padding:20px;display:flex;flex-direction:column;gap:14px;">
            <div class="bd-media-thumb" style="aspect-ratio:16/10;border:1px solid var(--rule-dark);">
              ${
                t.artwork
                  ? `<img src="${escapeHtml(t.artwork)}" alt="${escapeHtml(t.title)}" referrerpolicy="no-referrer" />`
                  : `<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);color:var(--c1);">BLUEDROP AUDIO</div>`
              }
            </div>
            <div>
              <div class="bd-mono-label" style="color:var(--c1);">${escapeHtml((t.platform || 'audio').toUpperCase())} · ${escapeHtml(t.durationLabel || formatClock(dur))}</div>
              <h2 dir="auto" style="font-size:24px;font-weight:500;letter-spacing:-0.02em;margin-top:4px;">${escapeHtml(t.title)}</h2>
              <div style="font-size:15px;color:var(--muted-bone);margin-top:4px;">${escapeHtml(t.creator)}</div>
            </div>

            <div class="bd-player" style="border-color:var(--rule-dark);">
              <button type="button" id="bd-sheet-prev" class="bd-mini-btn">PREV</button>
              <button type="button" id="bd-sheet-play-toggle" class="bd-player-btn">${this.playerPlaying ? 'PAUSE' : 'PLAY'}</button>
              <button type="button" id="bd-sheet-next" class="bd-mini-btn">NEXT</button>
              <div id="bd-sheet-player-track" class="bd-player-track">
                <div id="bd-sheet-player-fill" class="bd-player-fill" style="width:${pct}%"></div>
              </div>
              <span id="bd-sheet-player-time" class="bd-player-time">${formatClock(this.playerCurrentSec)} / ${formatClock(dur)}</span>
            </div>

            <div class="bd-seg-group">
              <button type="button" class="bd-tab" data-sheet-stem="full" aria-pressed="${this.stemMode === 'full'}">Full Mix</button>
              <button type="button" class="bd-tab" data-sheet-stem="instrumental" aria-pressed="${this.stemMode === 'instrumental'}">Instrumental</button>
              <button type="button" class="bd-tab" data-sheet-stem="vocals" aria-pressed="${this.stemMode === 'vocals'}">Vocals</button>
              <button type="button" id="bd-sheet-order-toggle" class="bd-mini-btn" aria-pressed="${this.playOrderMode === 'shuffle' ? 'true' : 'false'}">${this.playOrderMode === 'shuffle' ? `${renderVectorIcon('shuffle')} <span>${escapeHtml(copy.orderShuffle)}</span>` : `${renderVectorIcon('order')} <span>${escapeHtml(copy.orderSequential)}</span>`}</button>
              ${
                t.sourceUrl
                  ? `<button type="button" id="bd-sheet-open-formats" class="bd-btn bd-btn-bone" style="min-height:34px;padding:6px 12px;"><span>Download Formats</span> ${renderVectorIcon('down')}</button>`
                  : ''
              }
            </div>
          </div>

          <div id="bd-sheet-lyrics-wrap" style="background:var(--ghost);border:1.5px solid var(--rule-dark);padding:20px;">
            ${this.renderLyricsBoxHtml(false)}
          </div>
        </div>
      </div>
    `;

    const sheetLyricsWrap = document.getElementById('bd-sheet-lyrics-wrap');
    if (sheetLyricsWrap) this.wireLyricsButtons(sheetLyricsWrap);

    document.getElementById('bd-sheet-order-toggle')?.addEventListener('click', () => {
      this.playOrderMode = this.playOrderMode === 'shuffle' ? 'sequential' : 'shuffle';
      this.renderNowPlayingSheet();
      this.renderResultsAndLibrary();
    });

    document.getElementById('bd-sheet-minimize')?.addEventListener('click', () => {
      this.playerSheetExpanded = false;
      this.renderNowPlayingSheet();
      this.renderMiniDock();
    });
    document.getElementById('bd-sheet-bookmark')?.addEventListener('click', () => {
      void this.handleBookmarkTap({
        id: t.id,
        title: t.title,
        creator: t.creator,
        platform: t.platform || 'direct',
        kind: t.kind || 'audio',
        albumOrTag: (t.platform || 'AUDIO').toUpperCase(),
        durationSec: Math.round(this.playerDurationSec || 30),
        durationLabel: t.durationLabel || formatClock(this.playerDurationSec || 30),
        sourceUrl: t.sourceUrl || t.src,
        streamUrl: t.src,
        thumbnailUrl: t.artwork,
        lyricsText: this.activeLyrics?.text,
      });
    });
    document.getElementById('bd-sheet-play-toggle')?.addEventListener('click', () => {
      void this.toggleActiveAudioPlayback();
    });
    document.getElementById('bd-sheet-prev')?.addEventListener('click', () => {
      void this.playNextInQueue(-1);
    });
    document.getElementById('bd-sheet-next')?.addEventListener('click', () => {
      void this.playNextInQueue(1);
    });
    document.getElementById('bd-sheet-player-track')?.addEventListener('click', (e) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (this.bgAudio) {
        const d = this.bgAudio.duration || this.playerDurationSec || 30;
        this.bgAudio.currentTime = ratio * d;
      }
    });
    slot.querySelectorAll<HTMLElement>('[data-sheet-stem]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.sheetStem as StemListeningMode;
        if (this.bgAudio) this.stemController.attach(this.bgAudio);
        this.stemMode = mode;
        this.stemController.setMode(mode);
        slot.querySelectorAll<HTMLElement>('[data-sheet-stem]').forEach((el) => {
          el.setAttribute('aria-pressed', el.dataset.sheetStem === mode ? 'true' : 'false');
        });
      });
    });
    document.getElementById('bd-sheet-open-formats')?.addEventListener('click', () => {
      this.playerSheetExpanded = false;
      this.renderNowPlayingSheet();
      this.renderMiniDock();
      if (t.sourceUrl && (!this.inspectedMedia || this.inspectedMedia.id !== t.id)) {
        void this.inspectUrl(t.sourceUrl);
      } else {
        document.getElementById('inspector-stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
}
