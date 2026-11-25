import { describe, expect, it } from 'vitest';
import {
  buildDefaultFormatMatrix,
  detectPlatform,
  extractYouTubeVideoId,
  formatIdToExtension,
  isSafeExternalHttpUrl,
  runFfmpegTranscode,
} from '../server/media.js';
import { handleAiMediaAction, passesSafetyFilter } from '../server/mahsooda.js';
import type { ServerConfig } from '../server/config.js';

describe('BLUEDROP Media Engine', () => {
  it('validates external HTTP URLs and blocks loopback/private SSRF targets', () => {
    expect(isSafeExternalHttpUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ')?.hostname).toBe(
      'www.youtube.com'
    );
    expect(isSafeExternalHttpUrl('http://127.0.0.1:3000/secret')).toBeNull();
    expect(isSafeExternalHttpUrl('http://localhost:8080/admin')).toBeNull();
    expect(isSafeExternalHttpUrl('http://192.168.1.10/local')).toBeNull();
    expect(isSafeExternalHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('detects platforms and extracts 11-char YouTube video IDs cleanly', () => {
    expect(detectPlatform('https://youtu.be/aqz-KE-bpKQ')).toBe('youtube');
    expect(detectPlatform('https://www.tiktok.com/@user/video/123')).toBe('tiktok');
    expect(detectPlatform('https://www.instagram.com/reel/abc')).toBe('instagram');
    expect(detectPlatform('https://vimeo.com/76979871')).toBe('vimeo');
    expect(detectPlatform('https://www.dailymotion.com/video/x84sh87')).toBe('dailymotion');
    expect(detectPlatform('https://www.reddit.com/r/music/comments/abc/track/')).toBe('reddit');
    expect(detectPlatform('https://audius.co/artist/track')).toBe('audius');
    expect(detectPlatform('https://artist.bandcamp.com/track/demo')).toBe('bandcamp');
    expect(detectPlatform('https://archive.org/details/sample')).toBe('archive');
    expect(detectPlatform('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe('spotify');
    expect(extractYouTubeVideoId('https://youtu.be/aqz-KE-bpKQ')).toBe('aqz-KE-bpKQ');
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/jfKfPfyJRdk')).toBe(
      'jfKfPfyJRdk'
    );
  });

  it('builds complete format matrix for video, audio, image, and subtitle exports', () => {
    const formats = buildDefaultFormatMatrix({
      kind: 'video',
      hasTranscript: true,
      hasThumbnail: true,
    });
    const ids = formats.map((f) => f.id);
    expect(ids).toContain('mp4-4k');
    expect(ids).toContain('webm');
    expect(ids).toContain('mp3-320');
    expect(ids).toContain('wav');
    expect(ids).toContain('flac');
    expect(ids).toContain('png');
    expect(ids).toContain('srt');
    expect(formatIdToExtension('mp3-320')).toBe('mp3');
    expect(formatIdToExtension('mp4-4k')).toBe('mp4');
  });

  it('transcodes generated WAV audio into 320kbps MP3 via real FFmpeg', async () => {
    // Minimal 44-byte silent PCM WAV buffer + 0.1s samples
    const sampleRate = 8000;
    const numSamples = 800;
    const dataBytes = numSamples * 2;
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataBytes, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataBytes, 40);

    const out = await runFfmpegTranscode({
      inputBuffer: wav,
      inputExt: 'wav',
      targetFormat: 'mp3-320',
      title: 'Test Tone',
      artist: 'BLUEDROP',
    });
    expect(out.ext).toBe('mp3');
    expect(out.mimeType).toBe('audio/mpeg');
    expect(out.outputBuffer.byteLength).toBeGreaterThan(200);
  });

  it('enforces safety filter on distilled knowledge cards', () => {
    expect(passesSafetyFilter('Lo-fi instrumental guitar beat 2025')).toBe(true);
    expect(passesSafetyFilter('explicit nsfw spam stream')).toBe(false);
  });

  it('provides clean offline Darija translation, watch study, and Suno Taste DNA fallback', async () => {
    const offlineConfig: ServerConfig = {
      port: 3000,
      host: '127.0.0.1',
      modelName: 'gemini-4-neon',
      apiKey: null,
      hasApiKey: false,
      aiBaseUrl: 'https://example.invalid',
      aiApiKey: null,
      aiModelName: 'HEYUKA',
      hasExternalAiKey: false,
    };
    const res = await handleAiMediaAction(
      {
        action: 'translate',
        targetLang: 'ary',
        media: {
          title: 'Gnawa Acoustic Session',
          creator: 'Maalem Studio',
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
          description: 'Traditional acoustic session recorded live.',
        },
      },
      offlineConfig
    );
    expect(res.ok).toBe(true);
    expect(res.providerMode).toBe('local-analyzer');
    expect(res.content).toContain('Gnawa Acoustic Session');

    const watchRes = await handleAiMediaAction(
      {
        action: 'watch',
        targetLang: 'ary',
        media: {
          title: '2 Hour Documentary',
          creator: 'Archive',
          platform: 'vimeo',
          sourceUrl: 'https://vimeo.com/76979871',
          durationSec: 7200,
          clientTelemetry: {
            bpm: 118,
            dominantColors: ['#111111', '#F4F03A'],
            accessNode: 'device-edge:test',
            frameCount: 4,
          },
        },
      },
      offlineConfig
    );
    expect(watchRes.ok).toBe(true);
    expect(watchRes.content).toContain('Captured 4 visual frame(s)');

    const dnaRes = await handleAiMediaAction(
      {
        action: 'taste_dna',
        targetLang: 'ary',
        media: {
          title: 'Casablanca Bass Groove',
          creator: 'Indie Beatmaker',
          platform: 'audius',
          sourceUrl: 'https://audius.co/test/track',
          keywords: ['gnawa', 'bass', 'electronic'],
          clientTelemetry: {
            bpm: 122,
            dominantColors: ['#111111', '#6E8BFF'],
          },
        },
      },
      offlineConfig
    );
    expect(dnaRes.ok).toBe(true);
    expect(dnaRes.heading).toContain('Suno DNA');
    expect(dnaRes.content).toContain('122 BPM');
  });

  it('parses timestamped LRC synced lyrics cleanly', async () => {
    const { parseLrcSyncedLines } = await import('../server/media.js');
    const lines = parseLrcSyncedLines(
      '[00:12.50] First lyric line\n[01:05.00] Chorus line\n[invalid] ignore'
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ timeSec: 12.5, line: 'First lyric line' });
    expect(lines[1]).toEqual({ timeSec: 65, line: 'Chorus line' });
  });

  it('strips AI thinking tags and preambles so only pure lyrics remain', async () => {
    const { stripAiThinkingAndMeta, extractPureLyricsOnly } = await import('../server/mahsooda.js');
    const dirty = `<think>First I should listen to the verse and verify the chorus lines.</think>
Here are the lyrics for the track:
\`\`\`
Walking down the Casablanca street
Bassline heavy under every beat
\`\`\`
Note: Transcribed cleanly.`;
    expect(stripAiThinkingAndMeta(dirty)).not.toContain('<think>');
    expect(stripAiThinkingAndMeta(dirty)).not.toContain('First I should');

    const pure = extractPureLyricsOnly(dirty);
    expect(pure).toBe('Walking down the Casablanca street\nBassline heavy under every beat');

    const withLrc = extractPureLyricsOnly(
      '[00:12.40] Walking down the Casablanca street\n[00:16.10] Bassline heavy under every beat'
    );
    expect(withLrc).toBe('Walking down the Casablanca street\nBassline heavy under every beat');
  });

  it('returns clean offline lyrics action without hallucinated chatter', async () => {
    const offlineConfig: ServerConfig = {
      port: 3000,
      host: '127.0.0.1',
      modelName: 'gemini-4-hydrogen',
      apiKey: null,
      hasApiKey: false,
      aiBaseUrl: 'https://example.invalid',
      aiApiKey: null,
      aiModelName: 'HEYUKA',
      hasExternalAiKey: false,
    };

    const withTranscript = await handleAiMediaAction(
      {
        action: 'lyrics',
        targetLang: 'ary',
        media: {
          title: 'Test Vocal',
          creator: 'Artist',
          platform: 'audius',
          sourceUrl: 'https://audius.co/artist/test-vocal',
          transcriptText: '<thought>checking lines</thought>\nLine one\nLine two',
        },
      },
      offlineConfig
    );
    expect(withTranscript.ok).toBe(true);
    expect(withTranscript.content).toBe('Line one\nLine two');

    const emptyLyrics = await handleAiMediaAction(
      {
        action: 'lyrics',
        targetLang: 'ary',
        media: {
          title: 'Instrumental Beat',
          creator: 'Producer',
          platform: 'audius',
          sourceUrl: 'https://audius.co/producer/beat',
        },
      },
      offlineConfig
    );
    expect(emptyLyrics.ok).toBe(true);
    expect(emptyLyrics.content).toBe('No sung lyrics found for this clip.');
  });

  it('infers correct library category when saving into Music, Reels & Video, or Favorites folders', async () => {
    const { inferCategoryFromFolder } = await import('../src/media/device-library.js');
    expect(inferCategoryFromFolder('Music', 'video')).toBe('music');
    expect(inferCategoryFromFolder('Reels & Video', 'video')).toBe('video');
    expect(inferCategoryFromFolder('Albums', 'audio')).toBe('albums');
    expect(inferCategoryFromFolder('Favorites', 'audio')).toBe('favorites');
    expect(inferCategoryFromFolder('Workout', 'audio')).toBe('music');
    expect(inferCategoryFromFolder('Workout', 'video')).toBe('video');
  });

  it('transcodes generated A/V MP4 cleanly through EVERY video, audio, and image format button', { timeout: 60000 }, async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluedrop-fixture-'));
    const sampleMp4 = path.join(tmpDir, 'fixture.mp4');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=12',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
          sampleMp4,
        ]);
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fixture exit ${code}`))));
      });
      const inputBuffer = await fs.promises.readFile(sampleMp4);

      const videoFormats = ['mp4-4k', 'mp4-1080', 'mp4-720', 'webm', 'mkv', 'mov', 'gif'] as const;
      const audioFormats = ['mp3-320', 'mp3-192', 'wav', 'flac', 'aac', 'ogg', 'm4a'] as const;
      const imageFormats = ['png', 'jpg', 'webp'] as const;

      for (const fmt of [...videoFormats, ...audioFormats, ...imageFormats]) {
        const res = await runFfmpegTranscode({
          inputBuffer,
          inputExt: 'mp4',
          targetFormat: fmt,
          title: 'تجربة بلودروب 2026',
          artist: 'BLUEDROP',
        });
        expect(res.outputBuffer.byteLength, `Format ${fmt} produced empty buffer`).toBeGreaterThan(250);
        expect(res.ext.length).toBeGreaterThan(1);
        expect(res.mimeType.length).toBeGreaterThan(5);
      }
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('serves POST /api/media/convert over HTTP with UTF-8 Arabic filename in RFC 5987 Content-Disposition', { timeout: 30000 }, async () => {
    const { createAskHttpServer } = await import('../server/index.js');

    const offlineConfig: ServerConfig = {
      port: 0,
      host: '127.0.0.1',
      modelName: 'gemini-4-hydrogen',
      apiKey: null,
      hasApiKey: false,
      aiBaseUrl: 'https://example.invalid',
      aiApiKey: null,
      aiModelName: 'HEYUKA',
      hasExternalAiKey: false,
    };

    // Minimal valid WAV fixture (0.1s mono PCM)
    const sampleRate = 8000;
    const numSamples = 800;
    const dataBytes = numSamples * 2;
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataBytes, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataBytes, 40);

    const server = createAskHttpServer({ config: offlineConfig });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as import('node:net').AddressInfo;

    try {
      const resp = await fetch(`http://127.0.0.1:${addr.port}/api/media/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-name': encodeURIComponent('موسيقى مغربية.wav'),
          'x-target-format': 'mp3-320',
          'x-title': encodeURIComponent('أغنية مغربية تجربة'),
          'x-artist': encodeURIComponent('BLUEDROP Studio'),
        },
        body: wav,
      });

      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('audio/mpeg');
      const disp = resp.headers.get('content-disposition') || '';
      expect(disp).toContain("filename*=UTF-8''");
      const buf = Buffer.from(await resp.arrayBuffer());
      expect(buf.byteLength).toBeGreaterThan(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds complete multilingual ad-free SEO metadata, hreflang alternates, robots.txt, and sitemap.xml', async () => {
    const {
      SEO_PAGES,
      MULTILINGUAL_SEO_KEYWORDS,
      buildRobotsTxt,
      buildRouteSeoHeadHtml,
      buildSeoJsonLdObject,
      buildSitemapXml,
      matchSeoPage,
    } = await import('../src/media/seo-pages.js');

    expect(SEO_PAGES.length).toBeGreaterThanOrEqual(8);
    expect(MULTILINGUAL_SEO_KEYWORDS).toContain('BLUEDROP');
    expect(MULTILINGUAL_SEO_KEYWORDS).toContain('بلو دروب');
    expect(MULTILINGUAL_SEO_KEYWORDS).toContain('تحميل فيديو بدون إشهارات');
    expect(MULTILINGUAL_SEO_KEYWORDS).toContain('télécharger vidéo sans pub');

    const arHead = buildRouteSeoHeadHtml('/youtube-to-mp3', 'https://bluedrop.example', 'ar');
    expect(arHead).toContain('بدون إشهارات');
    expect(arHead).toContain('rel="canonical" href="https://bluedrop.example/youtube-to-mp3"');
    expect(arHead).toContain('hreflang="ar"');
    expect(arHead).toContain('hreflang="x-default"');

    const jsonLd = buildSeoJsonLdObject(matchSeoPage('/'), 'https://bluedrop.example', 'en');
    const graph = jsonLd['@graph'] as Array<{ '@type': string }>;
    expect(graph.some((n) => n['@type'] === 'FAQPage')).toBe(true);
    expect(graph.some((n) => n['@type'] === 'WebSite')).toBe(true);
    expect(graph.some((n) => n['@type'] === 'WebApplication')).toBe(true);

    const robots = buildRobotsTxt('https://bluedrop.example');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Sitemap: https://bluedrop.example/sitemap.xml');

    const sitemap = buildSitemapXml('https://bluedrop.example');
    expect(sitemap).toContain('https://bluedrop.example/youtube-to-mp4');
    expect(sitemap).toContain('https://bluedrop.example/tiktok-downloader');
    expect(sitemap).toContain('https://bluedrop.example/music-player');
    expect(sitemap).toContain('xhtml:link rel="alternate" hreflang="ar"');
  });

  it('excludes all 29s/30s iTunes/Deezer snippet previews from full-length search results', async () => {
    const { searchMedia } = await import('../server/media.js');
    const res = await searchMedia('Daft Punk', 'music');
    for (const item of res.items) {
      expect(item.id.startsWith('itunes-')).toBe(false);
      expect(item.id.startsWith('deezer-')).toBe(false);
      expect(item.previewStreamUrl || '').not.toContain('dzcdn.net');
      expect(item.previewStreamUrl || '').not.toContain('mzstatic.com');
      if (item.kind === 'audio' && item.durationSec > 0) {
        expect(item.durationSec).toBeGreaterThanOrEqual(40);
      }
    }
  }, 20000);

  it('transcodes disk-to-disk via runFfmpegFileToTempFile without holding big files in RAM', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { runFfmpegFileToTempFile } = await import('../server/media.js');

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bluedrop-disk-'));
    const sampleMp4 = path.join(tmpDir, 'longfixture.mp4');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
          sampleMp4,
        ]);
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });

      const out = await runFfmpegFileToTempFile({
        inputPath: sampleMp4,
        targetFormat: 'mp3-320',
        title: 'Full Session',
        artist: 'BLUEDROP',
      });
      try {
        expect(out.ext).toBe('mp3');
        expect(out.sizeBytes).toBeGreaterThan(500);
        expect(fs.existsSync(out.outputPath)).toBe(true);
      } finally {
        await out.cleanup();
      }
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});




