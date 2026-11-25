/**
 * Server-Side Proxy for HEYUKA / mahsooda AI Media Vision, Study & Taste Genome (`server/mahsooda.ts`)
 *
 * Keeps `AI_API_KEY`, `AI_BASE_URL`, and `GEMINI_API_KEY` strictly on the server.
 * Uses `@google/genai` SDK (`gemini-4-hydrogen` / `gemini-3.5-transcribe`) with `ThinkingLevel.LOW`
 * and strips all internal reasoning / thinking tags before returning text to the client.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type {
  AiMediaRequest,
  AiMediaResponse,
  MahsoodaKnowledgeCard,
} from '../contracts/index.js';
import type { ServerConfig } from './config.js';
import { isSafeExternalHttpUrl } from './media.js';

const BLOCKED_TERMS = [
  'nsfw',
  'porn',
  'xxx',
  'hentai',
  'explicit',
  'onlyfans',
  'casino-spam',
];

const TASTE_VAULT_PATH = path.resolve(process.cwd(), 'data', 'mahsooda_taste_vault.json');

interface LearnedEntry {
  title: string;
  creator?: string;
  platform: string;
  kind: string;
  eventType: string;
  chosenFormat?: string;
  accessNodeMode?: string;
  bpm?: number | null;
  moodTags?: string[];
  keywords: string[];
  storedAt: string;
  forwarded: boolean;
}

export interface TasteGenomeSummary {
  totalObservations: number;
  avgBpm: number | null;
  dominantMoods: string[];
  topGenres: string[];
  topCreators: string[];
  preferredFormats: string[];
  platforms: string[];
  musicSynthesisSeed: string;
}

let learnedVault: LearnedEntry[] = [];
let evolutionGeneration = 0;

function loadTasteVaultFromDisk(): void {
  try {
    if (!fs.existsSync(TASTE_VAULT_PATH)) return;
    const raw = fs.readFileSync(TASTE_VAULT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      evolutionGeneration?: number;
      entries?: LearnedEntry[];
    };
    if (typeof parsed.evolutionGeneration === 'number') {
      evolutionGeneration = parsed.evolutionGeneration;
    }
    if (Array.isArray(parsed.entries)) {
      learnedVault = parsed.entries.slice(-250);
    }
  } catch {
    // Non-fatal if vault file missing or corrupt
  }
}

function persistTasteVaultToDisk(): void {
  try {
    const dir = path.dirname(TASTE_VAULT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      TASTE_VAULT_PATH,
      JSON.stringify(
        {
          evolutionGeneration,
          updatedAt: new Date().toISOString(),
          entries: learnedVault.slice(-250),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // Non-fatal on read-only environments
  }
}

loadTasteVaultFromDisk();

/**
 * Removes any internal chain-of-thought, <think>/<thought> XML blocks,
 * or leading "Thinking Process:" / "Reasoning:" sections so users never see AI chatter.
 */
export function stripAiThinkingAndMeta(raw: string): string {
  if (!raw) return '';
  let clean = raw
    // Complete XML reasoning tags
    .replace(/<(think|thought|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, '')
    // Bracketed think blocks
    .replace(/\[THINK\][\s\S]*?\[\/THINK\]/gi, '')
    // Unclosed <think> or <thought> tail
    .replace(/<(think|thought|thinking|reasoning)>[\s\S]*$/gi, '')
    .trim();

  // Strip leading "Thinking Process:" / "Reasoning:" / "Thought:" paragraphs
  clean = clean.replace(
    /^(?:#{1,4}\s*)?(?:Thinking Process|Internal Reasoning|Reasoning|Thought Process|Chain of Thought)\s*:[\s\S]*?(?=\n\n[^\s]|\n#{1,3}\s|$)/i,
    ''
  );

  // Also strip leading markdown bullet/numbered thinking headers if followed by blank line
  const lines = clean.split(/\r?\n/);
  const filteredLines: string[] = [];
  let skippingThinkingBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^(?:Thinking Process|Reasoning|Thought|Analysis|Let me analyze|Let's think)\s*:/i.test(
        trimmed
      )
    ) {
      skippingThinkingBlock = true;
      continue;
    }
    if (skippingThinkingBlock) {
      if (trimmed === '' || /^\d+\.\s+\*\*/.test(trimmed) || /^[-*]\s+/.test(trimmed)) {
        continue;
      }
      skippingThinkingBlock = false;
    }
    filteredLines.push(line);
  }

  return filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Cleans model output down to ONLY the sung/spoken lyrics lines — zero preambles,
 * zero thinking chatter, zero markdown code fences, zero explanations.
 */
export function extractPureLyricsOnly(raw: string): string {
  let clean = stripAiThinkingAndMeta(raw);
  if (!clean) return '';

  // Remove markdown code fences
  clean = clean.replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/gm, '').replace(/```$/gm, '').trim();

  const lines = clean.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') {
        kept.push('');
      }
      continue;
    }
    // Drop conversational AI preambles & disclaimers
    if (
      /^(?:here (?:are|is) the (?:lyrics|transcribed|sung)|sure[,!.]|certainly[,!.]|below (?:are|is) the lyrics|okay[,!.]|of course[,!.]|note:|disclaimer:|إليك (?:كلمات|الكلمات)|هذه هي الكلمات|ملاحظة:|voici les paroles)/i.test(
        trimmed
      )
    ) {
      continue;
    }
    // Drop pure markdown headings like "### Lyrics"
    if (/^#{1,4}\s*(?:lyrics|paroles|الكلمات|summary|analysis|opinion)\b/i.test(trimmed)) {
      continue;
    }
    // Drop trailing AI meta commentary lines ("I hope this helps", "This track explores...")
    if (
      /^(?:this song (?:is about|explores|reflects)|hope this helps|let me know if|translated (?:cleanly|by)|transcription note:)/i.test(
        trimmed
      )
    ) {
      continue;
    }
    kept.push(line.replace(/^\*\*|\*\*$/g, '').trimEnd());
  }

  while (kept.length > 0 && kept[kept.length - 1] === '') {
    kept.pop();
  }
  return kept.join('\n').trim();
}

function countTopValues(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const clean = raw.trim();
    if (!clean || clean.length < 2) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export function buildTasteGenome(): TasteGenomeSummary {
  const bpms = learnedVault
    .map((e) => e.bpm)
    .filter((b): b is number => typeof b === 'number' && Number.isFinite(b) && b >= 45 && b <= 220);
  const avgBpm =
    bpms.length > 0 ? Math.round(bpms.reduce((acc, v) => acc + v, 0) / bpms.length) : null;

  const dominantMoods = countTopValues(
    learnedVault.flatMap((e) => e.moodTags ?? []),
    5
  );
  const topGenres = countTopValues(
    learnedVault.flatMap((e) => e.keywords ?? []),
    6
  );
  const topCreators = countTopValues(
    learnedVault.map((e) => e.creator ?? '').filter(Boolean),
    4
  );
  const preferredFormats = countTopValues(
    learnedVault.map((e) => e.chosenFormat ?? '').filter(Boolean),
    4
  );
  const platforms = countTopValues(
    learnedVault.map((e) => e.platform).filter(Boolean),
    6
  );

  const moodText = dominantMoods.length > 0 ? dominantMoods.join(', ') : 'atmospheric, rhythmic groove';
  const genreText = topGenres.length > 0 ? topGenres.join(', ') : 'electronic fusion, North African percussion, deep bass';
  const bpmPart = avgBpm ? `${avgBpm} BPM` : '116 BPM';
  const musicSynthesisSeed = `Suno Blueprint -> Style: ${genreText} | Mood: ${moodText} | Tempo: ${bpmPart} | Mix: warm analog low-end, crisp transient percussion, stereo hooks`;

  return {
    totalObservations: learnedVault.length,
    avgBpm,
    dominantMoods,
    topGenres,
    topCreators,
    preferredFormats,
    platforms,
    musicSynthesisSeed,
  };
}

export function getLearnedVaultSummary(): {
  sessionCardsCount: number;
  evolutionGeneration: number;
  recentTopics: string[];
  recentEvents: Array<{ title: string; eventType: string; format?: string; platform: string }>;
  tasteGenome: TasteGenomeSummary;
} {
  const recentTopics = Array.from(
    new Set(learnedVault.flatMap((v) => v.keywords).slice(-14))
  ).slice(0, 8);
  const recentEvents = learnedVault.slice(-5).reverse().map((v) => ({
    title: v.title,
    eventType: v.eventType,
    format: v.chosenFormat,
    platform: v.platform,
  }));
  return {
    sessionCardsCount: learnedVault.length,
    evolutionGeneration,
    recentTopics,
    recentEvents,
    tasteGenome: buildTasteGenome(),
  };
}

export function passesSafetyFilter(text: string): boolean {
  const lower = text.toLowerCase();
  return !BLOCKED_TERMS.some((term) => lower.includes(term));
}

function buildLocalFallbackAiResponse(
  req: AiMediaRequest,
  externalStatus?: string
): AiMediaResponse {
  const { action, targetLang = 'ary', media } = req;
  const baseText = [media.transcriptText, media.description].filter(Boolean).join('\n\n').trim();
  const sentences = baseText
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);

  if (action === 'lyrics') {
    const cleaned = media.transcriptText ? extractPureLyricsOnly(media.transcriptText) : '';
    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: 'Lyrics',
      content: cleaned || 'No sung lyrics found for this clip.',
    };
  }

  if (action === 'separate') {
    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: 'Client DSP Stem Isolation Ready',
      content:
        'Web Audio Mid/Side phase cancellation and vocal bandpass filters are armed on your device. Switch between Full Mix, Instrumental (Center-Cancel), and Vocal Focus directly in the player below with zero server load.',
      stemMode: {
        vocalGain: 1.0,
        instrumentalMode: 'mid-side-cancel',
        description: 'Client-side Web Audio Mid/Side + 300Hz–3.4kHz vocal isolation active.',
      },
    };
  }

  if (action === 'taste_dna') {
    const genome = buildTasteGenome();
    const bpmVal = media.clientTelemetry?.bpm ?? genome.avgBpm ?? 116;
    const colors = media.clientTelemetry?.dominantColors?.join(', ') || '#111111, #F4F03A';
    const tags = (media.keywords && media.keywords.length > 0 ? media.keywords : genome.topGenres)
      .slice(0, 5)
      .join(', ');
    const moods = genome.dominantMoods.length > 0 ? genome.dominantMoods.join(', ') : 'Dynamic, Club, Studio';

    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: `Music Synthesis Blueprint (Suno DNA) — ${media.title}`,
      content:
        targetLang === 'ary'
          ? `بناءً على الذوق اللي تعلّمو HEYUKA من ${genome.totalObservations || 1} عملية استماع وتحميل:\n• الستايل الموصى به (Style Prompt): ${tags || 'Fusion, Electronic, Groove'}, ${moods}, ${bpmVal} BPM, ألوان بصرية [${colors}].\n• التوزيع الصوتي (Arrangement): Intro 8 bars بباص دافئ، Drop بإيقاع سريع وميلودي واضحة، Bridge فيه صوت معزول، وOutro سينمائي جاهز للمزج أو التوليد فـ Suno.`
          : `Collective Taste DNA distilled across ${genome.totalObservations || 1} device observations:\n• Style Tags: ${tags || 'Electronic Fusion, Percussion, Groove'}\n• Target Tempo & Color: ${bpmVal} BPM · Palette [${colors}]\n• Mood Curve: ${moods}\n• Structure for Future Generation: [Intro 8 bars] -> [Verse / Groove Lock] -> [High-Energy Hook] -> [Stem Breakdown] -> [Outro]`,
      bullets: [
        `Suno Prompt Seed: ${genome.musicSynthesisSeed}`,
        `Reference Track: ${media.title} (${media.creator} · ${media.platform.toUpperCase()})`,
        `Preferred Export Formats Learned: ${genome.preferredFormats.join(', ') || 'MP3-320, MP4-1080'}`,
      ],
    };
  }

  if (action === 'watch') {
    const framesCount = media.imageDataUrls?.length ?? media.clientTelemetry?.frameCount ?? 0;
    const bpmText = media.clientTelemetry?.bpm ? `${media.clientTelemetry.bpm} BPM` : 'Adaptive';
    const colorsText = media.clientTelemetry?.dominantColors?.join(', ') || '#111111, #F4F03A';
    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: `Device Body & Provenance Study — ${media.title}`,
      content: `Source: ${media.platform.toUpperCase()} (${media.sourceUrl}). Captured ${framesCount} visual frame(s), audio tempo ${bpmText}, palette [${colorsText}]. Ready for format conversion and multimodal analysis.`,
      bullets: [
        `Origin: ${media.creator} on ${media.platform.toUpperCase()}`,
        `Visual frames perceived by device body: ${framesCount}`,
        ...(sentences.slice(0, 2)),
      ],
    };
  }

  if (action === 'transcript') {
    if (media.transcriptText && media.transcriptText.trim().length > 0) {
      return {
        ok: true,
        action,
        providerMode: 'local-analyzer',
        externalStatus,
        heading: `Extracted Transcript — ${media.title}`,
        content: extractPureLyricsOnly(media.transcriptText) || media.transcriptText.trim(),
      };
    }
    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: 'Audio Metadata & Client Inspection',
      content: `No embedded caption track was published by ${media.platform.toUpperCase()} for "${media.title}". Play or upload the audio file locally to run client-side spectral & rhythm extraction.`,
    };
  }

  if (action === 'translate') {
    const cleaned = media.transcriptText ? extractPureLyricsOnly(media.transcriptText) : '';
    const fallbackDesc = media.description ? extractPureLyricsOnly(media.description) : '';
    return {
      ok: true,
      action,
      providerMode: 'local-analyzer',
      externalStatus,
      heading: 'Translated Lyrics',
      content: cleaned || (fallbackDesc ? `${media.title}\n${fallbackDesc}` : media.title),
    };
  }

  const bullets =
    sentences.length > 0
      ? sentences.slice(0, 4)
      : [
          `Source: ${media.platform.toUpperCase()} · Creator: ${media.creator}`,
          ...(media.keywords && media.keywords.length > 0
            ? [`Keywords: ${media.keywords.slice(0, 6).join(', ')}`]
            : []),
          'Ready for MP4 / MP3 / WAV / FLAC / Image conversion via local & FFmpeg pipeline.',
        ];

  return {
    ok: true,
    action: 'summarize',
    providerMode: 'local-analyzer',
    externalStatus,
    heading: `Summary — ${media.title}`,
    content:
      sentences[0] ||
      media.description?.slice(0, 260) ||
      `${media.title} by ${media.creator} (${media.platform}).`,
    bullets,
  };
}

function buildCandidateModelIds(config: ServerConfig, hasImages: boolean): string[] {
  const configured = config.aiModelName.trim();
  const upper = configured.toUpperCase();
  const baseList: string[] = [];

  if (hasImages) {
    baseList.push('heyuka-vision', 'heyuka-omni', 'heyuka-core');
  } else {
    baseList.push('heyuka-omni', 'heyuka-core', 'heyuka-vision');
  }

  if (upper !== 'HEYUKA' && upper !== 'MAHSOODA' && configured.length > 0) {
    return Array.from(new Set([configured, ...baseList]));
  }
  return Array.from(new Set([...baseList, configured]));
}

async function callExternalAiChat(
  prompt: string,
  systemInstruction: string,
  config: ServerConfig,
  imageDataUrls: string[] = []
): Promise<{ text: string | null; modelUsed?: string; statusNote: string }> {
  if (!config.aiApiKey) {
    return { text: null, statusNote: 'no-external-key' };
  }

  const base = config.aiBaseUrl.replace(/\/+$/, '');
  const candidateUrls = /\/(chat\/completions|generate|chat)$/i.test(base)
    ? [base]
    : /\/v1$/i.test(base)
      ? [`${base}/chat/completions`]
      : [`${base}/chat/completions`, `${base}/v1/chat/completions`];

  const cleanImages = imageDataUrls
    .filter((u) => typeof u === 'string' && (u.startsWith('data:image/') || u.startsWith('https://')))
    .slice(0, 5);

  const modelCandidates = buildCandidateModelIds(config, cleanImages.length > 0);
  let lastStatus = 'unreachable';
  let primaryStatus: string | null = null;

  for (const endpoint of Array.from(new Set(candidateUrls))) {
    for (const modelId of modelCandidates) {
      try {
        const userContent =
          cleanImages.length > 0
            ? [
                { type: 'text', text: prompt },
                ...cleanImages.map((url) => ({
                  type: 'image_url',
                  image_url: { url },
                })),
              ]
            : prompt;

        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.aiApiKey}`,
            'X-API-Key': config.aiApiKey,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              {
                role: 'system',
                content: systemInstruction,
              },
              { role: 'user', content: userContent },
            ],
            temperature: 0.25,
            max_tokens: 900,
          }),
          signal: AbortSignal.timeout(4500),
        });

        lastStatus = `HTTP ${resp.status} (${modelId})`;
        if (!primaryStatus) primaryStatus = lastStatus;
        if (!resp.ok) {
          console.warn(`[AI-Proxy] ${endpoint} (${modelId}) -> HTTP ${resp.status}`);
          if (resp.status === 401 || resp.status === 403 || resp.status >= 500) {
            break;
          }
          continue;
        }

        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string }; text?: string }>;
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          reply?: string;
          content?: string;
          output?: string;
          text?: string;
          answer?: string;
          response?: string;
          result?: string;
          message?: string;
        };

        const rawText =
          data.choices?.[0]?.message?.content?.trim() ||
          data.choices?.[0]?.text?.trim() ||
          data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
          data.reply?.trim() ||
          data.response?.trim() ||
          data.answer?.trim() ||
          data.result?.trim() ||
          data.content?.trim() ||
          data.output?.trim() ||
          data.text?.trim() ||
          data.message?.trim() ||
          null;

        const cleaned = rawText ? stripAiThinkingAndMeta(rawText) : null;
        if (cleaned) {
          return { text: cleaned, modelUsed: modelId, statusNote: `OK (${modelId})` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'network-error';
        lastStatus = msg;
        if (!primaryStatus) primaryStatus = lastStatus;
        console.warn(`[AI-Proxy] ${endpoint} (${modelId}) failed:`, lastStatus);
        // Stop waiting immediately on timeout or network failure so Gemini responds fast
        break;
      }
    }
  }
  return { text: null, statusNote: primaryStatus || lastStatus };
}

async function fetchSafeInlineAudio(
  audioUrl?: string
): Promise<{ mimeType: string; data: string } | null> {
  if (!audioUrl) return null;
  const safe = isSafeExternalHttpUrl(audioUrl);
  if (!safe) return null;
  // Do not inline HLS playlists cleanly as single binary
  if (safe.pathname.toLowerCase().endsWith('.m3u8')) return null;

  try {
    const resp = await fetch(safe.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const lenHeader = Number.parseInt(resp.headers.get('content-length') ?? '0', 10);
    if (lenHeader > 12 * 1024 * 1024) return null;

    const arrBuf = await resp.arrayBuffer();
    if (arrBuf.byteLength === 0 || arrBuf.byteLength > 12 * 1024 * 1024) return null;

    const rawCt = (resp.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    let mimeType = 'audio/mpeg';
    if (rawCt && (rawCt.startsWith('audio/') || rawCt === 'video/mp4')) {
      mimeType = rawCt;
    } else if (/\.mp4($|\?)/i.test(safe.pathname)) {
      mimeType = 'video/mp4';
    } else if (/\.wav($|\?)/i.test(safe.pathname)) {
      mimeType = 'audio/wav';
    } else if (/\.m4a($|\?)/i.test(safe.pathname)) {
      mimeType = 'audio/mp4';
    } else if (/\.ogg($|\?)/i.test(safe.pathname)) {
      mimeType = 'audio/ogg';
    }
    return {
      mimeType,
      data: Buffer.from(arrBuf).toString('base64'),
    };
  } catch {
    return null;
  }
}

async function callGeminiSdk(
  prompt: string,
  systemInstruction: string,
  config: ServerConfig,
  options: {
    imageDataUrls?: string[];
    audioUrl?: string;
    preferTranscribe?: boolean;
  } = {}
): Promise<{ text: string | null; modelUsed?: string }> {
  if (!config.apiKey) return { text: null };

  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: 15000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: prompt }];

  for (const u of (options.imageDataUrls ?? []).slice(0, 4)) {
    const m = u.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (m?.[1] && m[2]) {
      parts.push({
        inlineData: {
          mimeType: m[1],
          data: m[2],
        },
      });
    }
  }

  let hasAudioInline = false;
  if (options.preferTranscribe && options.audioUrl) {
    const inlineAudio = await fetchSafeInlineAudio(options.audioUrl);
    if (inlineAudio) {
      parts.push({ inlineData: inlineAudio });
      hasAudioInline = true;
    }
  }

  const candidateModels = hasAudioInline
    ? ['gemini-3.5-transcribe', 'gemini-4-hydrogen']
    : ['gemini-4-hydrogen'];

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          systemInstruction,
          ...(model === 'gemini-4-hydrogen'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      });
      const raw = response.text?.trim();
      const cleaned = raw ? stripAiThinkingAndMeta(raw) : '';
      if (cleaned) {
        return { text: cleaned, modelUsed: model };
      }
    } catch (err) {
      console.warn(
        `[GeminiSDK] ${model} failed:`,
        err instanceof Error ? err.message : 'unknown error'
      );
    }
  }
  return { text: null };
}

export async function handleAiMediaAction(
  req: AiMediaRequest,
  config: ServerConfig
): Promise<AiMediaResponse> {
  const { action, targetLang = 'ary', media } = req;

  if (action === 'separate' && config.aiApiKey) {
    try {
      const resp = await fetch(`${config.aiBaseUrl}/audio/separate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
          'X-API-Key': config.aiApiKey,
        },
        body: JSON.stringify({
          sourceUrl: media.sourceUrl,
          title: media.title,
        }),
        signal: AbortSignal.timeout(4500),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { message?: string };
        return {
          ok: true,
          action,
          providerMode: 'mahsooda',
          modelUsed: config.aiModelName,
          heading: `${config.aiModelName} Audio Stem Separation`,
          content:
            stripAiThinkingAndMeta(data.message || '') ||
            'Remote stem separation triggered alongside real-time client Web Audio Mid/Side DSP isolation.',
          stemMode: {
            vocalGain: 1.0,
            instrumentalMode: 'mid-side-cancel',
            description: `${config.aiModelName} + Client Web Audio Mid/Side DSP active.`,
          },
        };
      }
    } catch {
      // Fall back to client DSP guidance
    }
  }

  if (action === 'separate') {
    return buildLocalFallbackAiResponse(req);
  }

  const isStrictLyrics = action === 'lyrics';
  const genome = buildTasteGenome();
  const telemetryLine = media.clientTelemetry
    ? `Client-Device Body Telemetry: frames=${media.clientTelemetry.frameCount ?? media.imageDataUrls?.length ?? 0}, bpm=${media.clientTelemetry.bpm ?? 'n/a'}, rmsDb=${media.clientTelemetry.rmsDb ?? 'n/a'}, palette=${(media.clientTelemetry.dominantColors ?? []).join(',')}, accessNode=${media.clientTelemetry.accessNode ?? 'browser'}`
    : '';

  const contextBlock = [
    `Source URL: ${media.sourceUrl}`,
    `Platform: ${media.platform}`,
    `Title: ${media.title}`,
    `Creator: ${media.creator}`,
    media.durationSec ? `Duration: ${media.durationSec} seconds` : '',
    !isStrictLyrics ? telemetryLine : '',
    !isStrictLyrics
      ? `Collective User Taste Genome: observations=${genome.totalObservations}, avgBpm=${genome.avgBpm ?? 'n/a'}, moods=[${genome.dominantMoods.join(', ')}], genres=[${genome.topGenres.join(', ')}], formats=[${genome.preferredFormats.join(', ')}]`
      : '',
    !isStrictLyrics && media.collectiveVisualHint
      ? `Collective Visual & Clip Brain Hint: ${media.collectiveVisualHint.slice(0, 420)}`
      : '',
    media.description ? `Description: ${media.description.slice(0, 900)}` : '',
    media.transcriptText ? `Transcript: ${media.transcriptText.slice(0, 4200)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const langHint =
    targetLang === 'ary'
      ? 'Respond primarily in natural Moroccan Darija (الدارجة المغربية) with clear technical terms.'
      : targetLang === 'ar'
        ? 'Respond in Modern Standard Arabic.'
        : targetLang === 'fr'
          ? 'Respond in French.'
          : 'Respond in English.';

  let systemInstruction =
    'You are a concise multimodal video and audio analyst. Output ONLY the final clean answer. Never output internal thinking steps, meta-commentary, or <think> tags.';
  let prompt = '';

  if (action === 'lyrics') {
    systemInstruction =
      'You extract ONLY the exact sung/spoken lyrics line by line. Zero thinking text, zero intros, zero commentary, zero fabricated lyrics. CRITICAL: Preserve the EXACT original sung language and script (e.g., Arabic/Darija in Arabic script if sung in Arabic, French in French, English in English, Spanish in Spanish) — never auto-translate lyrics here. If no audio track or captions exist and you cannot verify exact lyrics, reply strictly with: NO_LYRICS_FOUND';
    prompt = media.audioUrl
      ? `Transcribe verbatim ONLY the exact sung or spoken lyrics from this audio track in its original sung language, line by line, with zero commentary or preamble:\nTitle: ${media.title}\nArtist: ${media.creator}`
      : media.transcriptText?.trim()
        ? `Extract and format ONLY the spoken/sung lyric lines from this transcript in their original language, line by line, removing timestamps and chatter:\n\n${media.transcriptText.slice(0, 4200)}`
        : `Return strictly NO_LYRICS_FOUND because neither an audio stream nor transcript captions are attached for ${media.title}.`;
  } else if (action === 'watch') {
    prompt = `Watch and study the attached media frames and telemetry as a multimodal video analyst. ${langHint} Cover: (1) Visual scene observation from the keyframes, (2) Source provenance & format/duration context, (3) Core takeaway & key topics distilled.\n\n${contextBlock}`;
  } else if (action === 'taste_dna') {
    prompt = `Act as a music producer & Suno-style AI composer training on the user's Collective Taste Genome plus this reference media. ${langHint} Produce a concrete Music Synthesis Blueprint with: (1) Style Tags & Sonic Palette, (2) Recommended BPM, Key & Instrumentation, (3) Arrangement Structure [Intro / Verse / Chorus / Bridge / Outro].\n\n${contextBlock}`;
  } else if (action === 'summarize') {
    prompt = `Summarize this video/audio in 4 crisp bullet points and a 2-sentence overview:\n\n${contextBlock}`;
  } else if (action === 'transcript') {
    systemInstruction =
      'You format exact spoken transcripts cleanly into readable lines and paragraphs. Zero internal reasoning, zero <think> blocks, zero extra chatter.';
    prompt = media.audioUrl && !media.transcriptText?.trim()
      ? `Transcribe verbatim what is spoken or sung in the attached audio track:\nTitle: ${media.title}\nCreator: ${media.creator}`
      : `Clean, punctuate, and format ONLY the spoken transcript lines from this media context:\n\n${contextBlock}`;
  } else if (action === 'translate') {
    const langName =
      targetLang === 'ary'
        ? 'Moroccan Darija (الدارجة المغربية)'
        : targetLang === 'ar'
          ? 'Modern Standard Arabic'
          : targetLang === 'fr'
            ? 'French'
            : 'English';
    prompt = `Translate the exact lyrics/text below into ${langName}. Output ONLY the translated lines with zero preamble:\n\n${contextBlock}`;
  }

  const images = isStrictLyrics ? [] : Array.isArray(media.imageDataUrls) ? media.imageDataUrls : [];

  // If action === 'lyrics' without audioUrl and without transcriptText, never hallucinate fake lyrics!
  if (action === 'lyrics' && !media.audioUrl && !media.transcriptText?.trim()) {
    return buildLocalFallbackAiResponse(req);
  }

  // For strict lyrics or direct audio transcription, run Gemini SDK directly first when API key is set
  if ((action === 'lyrics' || (action === 'transcript' && media.audioUrl)) && config.apiKey) {
    const geminiDirect = await callGeminiSdk(prompt, systemInstruction, config, {
      audioUrl: media.audioUrl,
      preferTranscribe: true,
    });
    if (geminiDirect.text) {
      const sanitized =
        action === 'lyrics' ? extractPureLyricsOnly(geminiDirect.text) : geminiDirect.text;
      if (sanitized && !/^NO_LYRICS_FOUND$/i.test(sanitized)) {
        return {
          ok: true,
          action,
          providerMode: 'gemini',
          modelUsed: geminiDirect.modelUsed,
          heading: action === 'lyrics' ? 'Lyrics' : 'Audio Transcript',
          content: sanitized,
        };
      }
      if (action === 'lyrics' && /^NO_LYRICS_FOUND$/i.test(sanitized)) {
        return buildLocalFallbackAiResponse(req);
      }
    }
  }

  const external = await callExternalAiChat(prompt, systemInstruction, config, images);
  if (external.text) {
    const sanitized =
      action === 'lyrics' || action === 'translate'
        ? extractPureLyricsOnly(external.text)
        : external.text;
    if (action === 'lyrics' && /^NO_LYRICS_FOUND$/i.test(sanitized)) {
      return buildLocalFallbackAiResponse(req, external.statusNote);
    }
    if (sanitized) {
      return {
        ok: true,
        action,
        providerMode: 'mahsooda',
        modelUsed: external.modelUsed || config.aiModelName,
        externalStatus: external.statusNote,
        heading:
          action === 'lyrics'
            ? 'Lyrics'
            : action === 'watch'
              ? `${external.modelUsed || config.aiModelName} Watch & Study`
              : action === 'taste_dna'
                ? `${external.modelUsed || config.aiModelName} Music Synthesis DNA`
                : action === 'summarize'
                  ? `${external.modelUsed || config.aiModelName} Summary`
                  : action === 'translate'
                    ? 'Translated Lyrics'
                    : `${external.modelUsed || config.aiModelName} Transcript`,
        content: sanitized,
      };
    }
  }

  const gemini = await callGeminiSdk(prompt, systemInstruction, config, {
    imageDataUrls: images,
    audioUrl: media.audioUrl,
    preferTranscribe: action === 'lyrics' || action === 'transcript',
  });
  if (gemini.text) {
    const sanitized =
      action === 'lyrics' || action === 'translate'
        ? extractPureLyricsOnly(gemini.text)
        : gemini.text;
    if (action === 'lyrics' && /^NO_LYRICS_FOUND$/i.test(sanitized)) {
      return buildLocalFallbackAiResponse(req, external.statusNote);
    }
    if (sanitized) {
      return {
        ok: true,
        action,
        providerMode: 'gemini',
        modelUsed: gemini.modelUsed,
        externalStatus: external.statusNote,
        heading:
          action === 'lyrics'
            ? 'Lyrics'
            : action === 'watch'
              ? `Multimodal Vision Study (${gemini.modelUsed || 'Gemini'})`
              : action === 'taste_dna'
                ? `Suno Music Synthesis DNA`
                : action === 'summarize'
                  ? `AI Summary`
                  : action === 'translate'
                    ? 'Translated Lyrics'
                    : `AI Transcript`,
        content: sanitized,
      };
    }
  }

  return buildLocalFallbackAiResponse(req, external.statusNote);
}

export async function ingestMahsoodaKnowledge(
  card: MahsoodaKnowledgeCard,
  config: ServerConfig
): Promise<{
  ok: boolean;
  stored: boolean;
  forwardedToCloud: boolean;
  evolutionGeneration: number;
  reason?: string;
}> {
  const safeKeywords = Array.isArray(card.keywords) ? card.keywords : [];
  const safeMoodTags = Array.isArray(card.moodTags) ? card.moodTags : [];
  const safeTranscriptExcerpt = typeof card.transcriptExcerpt === 'string' ? card.transcriptExcerpt : '';
  const safeTitle = typeof card.title === 'string' ? card.title : 'Untitled Media';
  const safeCreator = typeof card.creator === 'string' ? card.creator : '';
  const safePassed = card.safetyPassed !== false;
  const combinedText = `${safeTitle} ${safeTranscriptExcerpt} ${safeKeywords.join(' ')}`;
  if (!safePassed || !passesSafetyFilter(combinedText)) {
    return {
      ok: false,
      stored: false,
      forwardedToCloud: false,
      evolutionGeneration,
      reason: 'Filtered by safety gate',
    };
  }

  let forwardedToCloud = false;
  if (config.aiApiKey) {
    const base = config.aiBaseUrl.replace(/\/+$/, '');
    try {
      const resp = await fetch(`${base}/memory/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
          'X-API-Key': config.aiApiKey,
        },
        body: JSON.stringify({
          model: 'heyuka-omni',
          source: 'bluedrop-device-body',
          eventType: card.eventType ?? 'inspect',
          chosenFormat: card.chosenFormat,
          accessNodeMode: card.accessNodeMode ?? 'server',
          visualFrameCount: card.visualFrameCount ?? 0,
          knowledge: {
            ...card,
            title: safeTitle,
            keywords: safeKeywords,
            moodTags: safeMoodTags,
            transcriptExcerpt: safeTranscriptExcerpt,
          },
        }),
        signal: AbortSignal.timeout(4500),
      });
      forwardedToCloud = resp.ok;
    } catch {
      forwardedToCloud = false;
    }
  }

  evolutionGeneration += 1;
  learnedVault.push({
    title: safeTitle.slice(0, 100),
    creator: safeCreator.slice(0, 60),
    platform: card.platform || 'direct',
    kind: card.kind || 'video',
    eventType: card.eventType ?? 'inspect',
    chosenFormat: card.chosenFormat,
    accessNodeMode: card.accessNodeMode,
    bpm: typeof card.bpm === 'number' && Number.isFinite(card.bpm) ? card.bpm : null,
    moodTags: safeMoodTags.slice(0, 5),
    keywords: safeKeywords.slice(0, 8),
    storedAt: new Date().toISOString(),
    forwarded: forwardedToCloud,
  });
  if (learnedVault.length > 250) {
    learnedVault.shift();
  }
  persistTasteVaultToDisk();

  return {
    ok: true,
    stored: true,
    forwardedToCloud,
    evolutionGeneration,
  };
}
