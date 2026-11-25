/**
 * Shared Global Multilingual Ad-Free SEO Registry, XML Sitemap, Robots.txt & Schema.org JSON-LD (`src/media/seo-pages.ts`)
 *
 * Used seamlessly by both:
 * - Client browser (`src/media/app.ts`) for dynamic SPA navigation (`applySeoHeadMetadata`)
 * - Server HTTP layer (`server.ts`) for SSR per-route SEO meta injection, `/sitemap.xml`, and `/robots.txt`
 */

export type SeoLangCode = 'en' | 'fr' | 'ar';

export interface SeoRoutePage {
  path: string;
  shortLabel: string;
  platformBadge: string;
  pageTitle: string;
  headline: string;
  description: string;
  arTitle: string;
  arDescription: string;
  frTitle: string;
  frDescription: string;
  sampleUrl: string;
  sampleSearch: string;
  accentHex: string;
  schemaType: 'VideoObject' | 'AudioObject' | 'WebApplication';
}

export const MULTILINGUAL_SEO_KEYWORDS = [
  'BLUEDROP',
  'بلو دروب',
  'BLUEDROP video downloader',
  'BLUEDROP music',
  'download video no ads',
  'ad-free video downloader',
  'free video downloader no popups',
  'youtube to mp4 4k',
  'youtube to mp3 320kbps',
  'tiktok downloader no watermark',
  'instagram reels downloader',
  'facebook video downloader hd',
  'listen to music online free no ads',
  'تحميل فيديو بدون إشهارات',
  'تحميل فيديو مجانا',
  'تحميل فيديوهات يوتيوب بدون إعلانات',
  'تحميل تيك توك بدون علامة مائية',
  'تحميل فيديو فيسبوك و انستغرام',
  'استمع إلى الموسيقى بدون إشهارات',
  'تطبيق موسيقى مجاني بدون اعلانات',
  'télécharger vidéo sans pub',
  'télécharger musique mp3 gratuit sans publicité',
  'écouter de la musique gratuit sans pub',
  'descargar videos gratis sin anuncios',
  'escuchar musica gratis sin publicidad',
  'baixar videos sem anuncios',
  'ouvir musica gratis sem anuncios',
  'video herunterladen ohne werbung',
  'reklamsız video indir',
  'बिना विज्ञापन वीडियो डाउनलोड',
  'unduh video tanpa iklan',
  '動画 ダウンロード 広告なし',
  '광고 없는 동영상 다운로드',
  'скачать видео без рекламы',
  'scarica video senza pubblicità',
  '无广告视频下载',
].join(', ');

export const HREFLANG_LOCALES: ReadonlyArray<{ hreflang: string; langQuery: string }> = [
  { hreflang: 'x-default', langQuery: '' },
  { hreflang: 'en', langQuery: 'lang=en' },
  { hreflang: 'ar', langQuery: 'lang=ar' },
  { hreflang: 'fr', langQuery: 'lang=fr' },
  { hreflang: 'es', langQuery: 'lang=en&gl=es' },
  { hreflang: 'pt', langQuery: 'lang=en&gl=pt' },
  { hreflang: 'de', langQuery: 'lang=en&gl=de' },
  { hreflang: 'tr', langQuery: 'lang=en&gl=tr' },
  { hreflang: 'hi', langQuery: 'lang=en&gl=hi' },
  { hreflang: 'id', langQuery: 'lang=en&gl=id' },
  { hreflang: 'ja', langQuery: 'lang=en&gl=ja' },
  { hreflang: 'ko', langQuery: 'lang=en&gl=ko' },
  { hreflang: 'ru', langQuery: 'lang=en&gl=ru' },
  { hreflang: 'it', langQuery: 'lang=en&gl=it' },
  { hreflang: 'zh', langQuery: 'lang=en&gl=zh' },
];

export const SEO_PAGES: readonly SeoRoutePage[] = [
  {
    path: '/',
    shortLabel: 'Universal Studio',
    platformBadge: '100% AD-FREE · ZERO POPUPS · 1,700+ SOURCES',
    pageTitle: 'BLUEDROP — Free Ad-Free Video & Music Downloader',
    headline: 'Any video, song, or frame. Zero ads forever.',
    description:
      '100% ad-free video & music downloader for YouTube, TikTok, Instagram, Facebook & SoundCloud. Save 4K MP4, 320kbps MP3, WAV, FLAC with zero popups.',
    arTitle: 'بلو دروب BLUEDROP — تحميل الفيديو والموسيقى بدون إشهارات',
    arDescription:
      'تحميل فيديوهات يوتيوب، تيك توك، فيسبوك وإنستغرام بأعلى جودة 4K MP4 أو MP3 320k والاستماع للموسيقى مجاناً 100% بدون أي إشهارات أو نوافذ مزعجة.',
    frTitle: 'BLUEDROP — Télécharger Vidéo & Musique Sans Pub',
    frDescription:
      'Téléchargeur vidéo et musique 100% sans publicité pour YouTube, TikTok, Instagram, Facebook & SoundCloud en 4K MP4, MP3 320kbps, WAV et FLAC.',
    sampleUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    sampleSearch: 'Daft Punk Instant Crush',
    accentHex: '#F4F03A',
    schemaType: 'WebApplication',
  },
  {
    path: '/youtube-to-mp4',
    shortLabel: 'YouTube to MP4',
    platformBadge: 'YOUTUBE · 4K / 1080P MP4 · 0 ADS',
    pageTitle: 'YouTube to MP4 4K No Ads — BLUEDROP Downloader',
    headline: 'YouTube to MP4 in 4K & 1080p. Zero ads.',
    description:
      'Download and convert YouTube videos to crisp 4K, 1080p, or 720p MP4, WEBM, MKV, and MOV with FFmpeg. 100% free with zero ads or redirects.',
    arTitle: 'تحميل فيديو يوتيوب MP4 بجودة 4K بدون إشهارات — بلو دروب',
    arDescription:
      'حوّل وحمّل فيديوهات يوتيوب مباشرة بصيغة MP4 4K و 1080p و WEBM و MOV مجاناً 100% بدون أي إشهارات أو إعلانات منبثقة عبر بلو دروب.',
    frTitle: 'YouTube en MP4 4K Sans Pub — BLUEDROP Studio',
    frDescription:
      'Convertissez et téléchargez vos vidéos YouTube en MP4 4K, 1080p, WEBM ou MOV avec FFmpeg, gratuitement et 100% sans aucune publicité.',
    sampleUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    sampleSearch: '4K nature documentary',
    accentHex: '#FF5A14',
    schemaType: 'VideoObject',
  },
  {
    path: '/youtube-to-mp3',
    shortLabel: 'YouTube to MP3',
    platformBadge: 'AUDIO MASTER · 320KBPS MP3 / WAV / FLAC · 0 ADS',
    pageTitle: 'YouTube to MP3 320kbps Ad-Free — BLUEDROP',
    headline: 'Extract 320kbps MP3, WAV & FLAC. Zero ads.',
    description:
      'Convert any YouTube video, mix, or song into studio 320kbps MP3, lossless WAV, or FLAC with embedded cover art and zero ads or wait timers.',
    arTitle: 'تحويل يوتيوب إلى MP3 320kbps بدون إشهارات — بلو دروب',
    arDescription:
      'استخرج وحمّل الصوتيات من يوتيوب والموسيقى بجودة MP3 320kbps و WAV و FLAC مجاناً وبدون أي إشهارات مع كلمات الأغاني والمشغل الدائم.',
    frTitle: 'YouTube en MP3 320kbps Sans Pub — BLUEDROP',
    frDescription:
      'Extrayez vos vidéos YouTube et musiques en MP3 320kbps, WAV ou FLAC sans perte avec pochette intégrée et zéro publicité ni pop-up.',
    sampleUrl: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    sampleSearch: 'Lofi hip hop beats',
    accentHex: '#FFA8E4',
    schemaType: 'AudioObject',
  },
  {
    path: '/tiktok-downloader',
    shortLabel: 'TikTok No Watermark',
    platformBadge: 'TIKTOK · HD MP4 NO WATERMARK · 0 ADS',
    pageTitle: 'TikTok Downloader No Watermark & No Ads — BLUEDROP',
    headline: 'Save TikTok videos & sounds without watermarks.',
    description:
      'Download TikTok HD MP4 videos without watermark and extract MP3 audio tracks fast on any device. 100% ad-free with zero popups.',
    arTitle: 'تحميل فيديو تيك توك بدون علامة مائية وبدون إشهارات — بلو دروب',
    arDescription:
      'حمّل فيديوهات تيك توك بجودة HD بدون علامة مائية أو استخرج الصوت بصيغة MP3 على الهاتف والحاسوب مجاناً 100% بدون إعلانات مزعجة.',
    frTitle: 'Télécharger TikTok Sans Filigrane & Sans Pub — BLUEDROP',
    frDescription:
      'Téléchargez des vidéos TikTok HD sans filigrane en MP4 ou MP3 audio rapidement sur mobile et PC, 100% gratuit et sans aucune publicité.',
    sampleUrl: 'https://www.tiktok.com/@tiktok/video/7106594312292453675',
    sampleSearch: 'Moroccan Gnawa music',
    accentHex: '#6BE8F2',
    schemaType: 'VideoObject',
  },
  {
    path: '/instagram-reels-downloader',
    shortLabel: 'Instagram Reels',
    platformBadge: 'INSTAGRAM · REELS / AUDIO / COVERS · 0 ADS',
    pageTitle: 'Instagram Reels Downloader Zero Ads — BLUEDROP',
    headline: 'Download Instagram Reels, audio & HD covers.',
    description:
      'Save Instagram Reels videos in HD MP4, extract MP3 audio, or export crisp PNG and WEBP frames completely free with zero ads or popups.',
    arTitle: 'تحميل ريلز انستغرام HD بدون إشهارات — بلو دروب',
    arDescription:
      'تحميل فيديوهات ريلز إنستغرام (Instagram Reels) أو الصوتيات والصور بجودة عالية MP4 و MP3 مجاناً وبدون إشهارات عبر بلو دروب.',
    frTitle: 'Télécharger Instagram Reels Sans Pub — BLUEDROP',
    frDescription:
      'Enregistrez vos Reels Instagram en vidéo MP4 HD, audio MP3 ou captures PNG et WEBP gratuitement et 100% sans publicité.',
    sampleUrl: 'https://www.instagram.com/',
    sampleSearch: 'Acoustic guitar session',
    accentHex: '#A9A2E0',
    schemaType: 'VideoObject',
  },
  {
    path: '/facebook-video-downloader',
    shortLabel: 'Facebook HD',
    platformBadge: 'FACEBOOK & X · HD MP4 & MP3 · 0 ADS',
    pageTitle: 'Facebook & X Video Downloader No Ads — BLUEDROP',
    headline: 'Download Facebook & X videos fast with zero ads.',
    description:
      'Save public Facebook, fb.watch, and X / Twitter videos in HD MP4, WEBM, or MP3 320kbps directly to your phone or desktop with zero ads.',
    arTitle: 'تحميل فيديو فيسبوك و X مجاناً بدون إشهارات — بلو دروب',
    arDescription:
      'حمّل فيديوهات فيسبوك (Facebook & fb.watch) وتويتر X بأعلى جودة MP4 أو حولها إلى صوت MP3 بدون إشهارات وبدون نوافذ منبثقة.',
    frTitle: 'Télécharger Vidéo Facebook & X Sans Pub — BLUEDROP',
    frDescription:
      'Téléchargez vos vidéos Facebook, fb.watch et X / Twitter en MP4 HD, WEBM ou audio MP3 320kbps rapidement et 100% sans publicité.',
    sampleUrl: 'https://vimeo.com/76979871',
    sampleSearch: 'Electronic synthwave',
    accentHex: '#B9F0C6',
    schemaType: 'VideoObject',
  },
  {
    path: '/music-player',
    shortLabel: 'Listen Free',
    platformBadge: 'MUSIC STREAMING · LYRICS · 0 ADS FOREVER',
    pageTitle: 'Listen to Music Free Without Ads — BLUEDROP Player',
    headline: 'Stream music & synced lyrics with zero ads.',
    description:
      'Listen to full songs free without ads across SoundCloud, Audius, Deezer & YouTube, organize folders, and read synced track lyrics cleanly.',
    arTitle: 'استمع إلى الموسيقى مجاناً بدون إشهارات — بلو دروب',
    arDescription:
      'استمع إلى الموسيقى والأغاني مجاناً مع كلمات الأغاني (Lyrics) وحفظ البلاي ليست وتشغيل الخلفية 100% بدون أي إشهارات.',
    frTitle: 'Écouter de la Musique Sans Pub — BLUEDROP Studio',
    frDescription:
      'Écoutez vos morceaux préférés avec paroles synchronisées, dossiers personnalisés et lecture en arrière-plan 100% sans publicité.',
    sampleUrl: 'https://audius.co/',
    sampleSearch: 'ElGrandeToto',
    accentHex: '#6E8BFF',
    schemaType: 'AudioObject',
  },
  {
    path: '/download',
    shortLabel: 'Install App (PWA)',
    platformBadge: 'PWA · DESKTOP · ANDROID · IOS · 0 ADS',
    pageTitle: 'Install BLUEDROP App Zero Ads (PWA & Desktop)',
    headline: 'Install ad-free BLUEDROP on every screen.',
    description:
      'Install BLUEDROP free ad-free video downloader and background music app on Windows, macOS, Linux, Android, and iPhone with offline vault sync.',
    arTitle: 'تثبيت تطبيق بلو دروب بدون إشهارات للكمبيوتر والهاتف',
    arDescription:
      'ثبّت تطبيق بلو دروب (BLUEDROP) للتحميل وتشغيل الموسيقى بدون إشهارات على أندرويد، آيفون، ويندوز وماك بضغطة واحدة.',
    frTitle: 'Installer l’App BLUEDROP Sans Pub (PC & Mobile)',
    frDescription:
      'Installez l’application BLUEDROP 100% sans publicité sur Windows, Mac, Android et iPhone pour télécharger et écouter hors-ligne.',
    sampleUrl: '',
    sampleSearch: 'Chill electronic',
    accentHex: '#D7F246',
    schemaType: 'WebApplication',
  },
];

export const SEO_FAQ_ITEMS = [
  {
    q: 'Is BLUEDROP 100% ad-free with zero popups?',
    a: 'Yes. BLUEDROP is permanently 100% ad-free: zero banner ads, zero popups, zero misleading download buttons, and zero tracking redirects.',
  },
  {
    q: 'Which platforms can I download videos and music from?',
    a: 'You can inspect, stream, and download from YouTube, TikTok, Instagram Reels, Facebook, X (Twitter), SoundCloud, Audius, Bandcamp, Vimeo, Dailymotion, Reddit, Streamable, and Archive.org in 4K MP4, 320kbps MP3, WAV, FLAC, WEBM, MKV, MOV, GIF, PNG, and SRT.',
  },
  {
    q: 'Can I listen to music and view pure track lyrics without ads?',
    a: 'Yes. BLUEDROP includes a continuous background music player with lock-screen Media Session controls, folders/playlists, vocal isolation, and synced track lyrics in their original language with zero audio interruptions.',
  },
  {
    q: 'هل موقع وتطبيق بلو دروب BLUEDROP بدون إشهارات ومجاني بالكامل؟',
    a: 'نعم، بلو دروب مجاني 100% وبدون أي إشهارات أو نوافذ منبثقة. يمكنك تحميل الفيديو من يوتيوب، تيك توك، فيسبوك، وإنستغرام والاستماع إلى الموسيقى وكلمات الأغاني بجودة عالية على جميع الأجهزة.',
  },
] as const;

export function matchSeoPage(pathname: string): SeoRoutePage {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return SEO_PAGES.find((p) => p.path === clean) ?? SEO_PAGES[0]!;
}

export function getLocalizedSeoFields(
  page: SeoRoutePage,
  lang?: string | null
): { title: string; description: string; localeCode: string } {
  if (lang === 'ar' || lang === 'ary') {
    return { title: page.arTitle, description: page.arDescription, localeCode: 'ar_MA' };
  }
  if (lang === 'fr') {
    return { title: page.frTitle, description: page.frDescription, localeCode: 'fr_FR' };
  }
  return { title: page.pageTitle, description: page.description, localeCode: 'en_US' };
}

export function buildSeoJsonLdObject(
  page: SeoRoutePage,
  origin: string,
  lang?: string | null
): Record<string, unknown> {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const { title, description } = getLocalizedSeoFields(page, lang);
  const canonicalUrl = `${cleanOrigin}${page.path === '/' ? '/' : page.path}`;

  const graph: Array<Record<string, unknown>> = [
    {
      '@type': 'WebSite',
      name: 'BLUEDROP',
      alternateName: ['بلو دروب', 'BLUEDROP Studio', 'BLUEDROP Downloader'],
      url: `${cleanOrigin}/`,
      inLanguage: ['en', 'ar', 'fr', 'es', 'pt', 'de', 'tr', 'hi', 'id', 'ja', 'ko', 'ru', 'it', 'zh'],
      potentialAction: {
        '@type': 'SearchAction',
        target: `${cleanOrigin}/?url={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@type': page.schemaType === 'WebApplication' ? 'WebApplication' : 'SoftwareApplication',
      name: title,
      description,
      url: canonicalUrl,
      image: `${cleanOrigin}/pwa-512x512.png`,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web, Android, iOS, Windows, macOS, Linux',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      featureList: [
        '100% Ad-Free & Zero Popups',
        'YouTube to 4K MP4 & 320kbps MP3',
        'TikTok Downloader Without Watermark',
        'Instagram Reels & Facebook HD Downloader',
        'Background Music Player & Synced Lyrics',
        'Lossless WAV, FLAC, WEBM, MKV, MOV & Cover Art Export',
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: SEO_FAQ_ITEMS.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.a,
        },
      })),
    },
  ];

  if (page.schemaType === 'VideoObject' || page.schemaType === 'AudioObject') {
    graph.push({
      '@type': page.schemaType,
      name: title,
      description,
      thumbnailUrl: `${cleanOrigin}/pwa-512x512.png`,
      contentUrl: canonicalUrl,
    });
  }

  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  };
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildRouteSeoHeadHtml(
  pathname: string,
  origin: string,
  lang?: string | null
): string {
  const page = matchSeoPage(pathname);
  const cleanOrigin = origin.replace(/\/+$/, '');
  const { title, description, localeCode } = getLocalizedSeoFields(page, lang);
  const canonicalPath = page.path === '/' ? '/' : page.path;
  const canonicalUrl = `${cleanOrigin}${canonicalPath}`;
  const ogImageUrl = `${cleanOrigin}/pwa-512x512.png`;
  const jsonLd = JSON.stringify(buildSeoJsonLdObject(page, cleanOrigin, lang)).replace(
    /</g,
    '\\u003c'
  );

  const hreflangLinks = HREFLANG_LOCALES.map((loc) => {
    const href = loc.langQuery ? `${canonicalUrl}?${loc.langQuery}` : canonicalUrl;
    return `    <link rel="alternate" hreflang="${loc.hreflang}" href="${escapeAttr(href)}" />`;
  }).join('\n');

  return [
    `    <title>${escapeAttr(title)}</title>`,
    `    <meta name="description" content="${escapeAttr(description)}" />`,
    `    <meta name="keywords" content="${escapeAttr(MULTILINGUAL_SEO_KEYWORDS)}" />`,
    `    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />`,
    `    <link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`,
    hreflangLinks,
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:site_name" content="BLUEDROP" />`,
    `    <meta property="og:locale" content="${localeCode}" />`,
    `    <meta property="og:url" content="${escapeAttr(canonicalUrl)}" />`,
    `    <meta property="og:title" content="${escapeAttr(title)}" />`,
    `    <meta property="og:description" content="${escapeAttr(description)}" />`,
    `    <meta property="og:image" content="${escapeAttr(ogImageUrl)}" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <meta name="twitter:title" content="${escapeAttr(title)}" />`,
    `    <meta name="twitter:description" content="${escapeAttr(description)}" />`,
    `    <meta name="twitter:image" content="${escapeAttr(ogImageUrl)}" />`,
    `    <script id="bluedrop-jsonld" type="application/ld+json">${jsonLd}</script>`,
  ].join('\n');
}

export function buildRobotsTxt(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${cleanOrigin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function buildSitemapXml(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const nowIso = new Date().toISOString().slice(0, 10);
  const urls = SEO_PAGES.map((page) => {
    const loc = `${cleanOrigin}${page.path === '/' ? '/' : page.path}`;
    const priority = page.path === '/' ? '1.0' : page.path === '/download' ? '0.8' : '0.9';
    const alternates = HREFLANG_LOCALES.map((locDef) => {
      const href = locDef.langQuery ? `${loc}?${locDef.langQuery}` : loc;
      return `    <xhtml:link rel="alternate" hreflang="${locDef.hreflang}" href="${escapeAttr(href)}" />`;
    }).join('\n');
    return `  <url>
    <loc>${escapeAttr(loc)}</loc>
    <lastmod>${nowIso}</lastmod>
    <changefreq>${page.path === '/download' ? 'weekly' : 'daily'}</changefreq>
    <priority>${priority}</priority>
${alternates}
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

function upsertHeadMeta(
  selector: string,
  createTag: 'meta' | 'link',
  attrs: Record<string, string>
): void {
  if (typeof document === 'undefined') return;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement(createTag);
    document.head.appendChild(el);
  }
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
}

export function applySeoHeadMetadata(page: SeoRoutePage, lang?: string): void {
  if (typeof document === 'undefined') return;
  const origin = window.location.origin;
  const { title, description, localeCode } = getLocalizedSeoFields(page, lang);
  const canonicalUrl = `${origin}${page.path === '/' ? '/' : page.path}`;
  const ogImageUrl = `${origin}/pwa-512x512.png`;

  document.title = title;

  upsertHeadMeta('meta[name="description"]', 'meta', { name: 'description', content: description });
  upsertHeadMeta('meta[name="keywords"]', 'meta', {
    name: 'keywords',
    content: MULTILINGUAL_SEO_KEYWORDS,
  });
  upsertHeadMeta('meta[name="robots"]', 'meta', {
    name: 'robots',
    content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
  });
  upsertHeadMeta('link[rel="canonical"]', 'link', { rel: 'canonical', href: canonicalUrl });

  upsertHeadMeta('meta[property="og:type"]', 'meta', { property: 'og:type', content: 'website' });
  upsertHeadMeta('meta[property="og:site_name"]', 'meta', {
    property: 'og:site_name',
    content: 'BLUEDROP',
  });
  upsertHeadMeta('meta[property="og:locale"]', 'meta', {
    property: 'og:locale',
    content: localeCode,
  });
  upsertHeadMeta('meta[property="og:url"]', 'meta', { property: 'og:url', content: canonicalUrl });
  upsertHeadMeta('meta[property="og:title"]', 'meta', { property: 'og:title', content: title });
  upsertHeadMeta('meta[property="og:description"]', 'meta', {
    property: 'og:description',
    content: description,
  });
  upsertHeadMeta('meta[property="og:image"]', 'meta', { property: 'og:image', content: ogImageUrl });

  upsertHeadMeta('meta[name="twitter:card"]', 'meta', {
    name: 'twitter:card',
    content: 'summary_large_image',
  });
  upsertHeadMeta('meta[name="twitter:title"]', 'meta', { name: 'twitter:title', content: title });
  upsertHeadMeta('meta[name="twitter:description"]', 'meta', {
    name: 'twitter:description',
    content: description,
  });
  upsertHeadMeta('meta[name="twitter:image"]', 'meta', {
    name: 'twitter:image',
    content: ogImageUrl,
  });

  // Refresh hreflang alternates for current canonical route
  document.head
    .querySelectorAll('link[rel="alternate"][hreflang]')
    .forEach((node) => node.remove());
  for (const locDef of HREFLANG_LOCALES) {
    const link = document.createElement('link');
    link.setAttribute('rel', 'alternate');
    link.setAttribute('hreflang', locDef.hreflang);
    link.setAttribute(
      'href',
      locDef.langQuery ? `${canonicalUrl}?${locDef.langQuery}` : canonicalUrl
    );
    document.head.appendChild(link);
  }

  let ldScript = document.getElementById('bluedrop-jsonld') as HTMLScriptElement | null;
  if (!ldScript) {
    ldScript = document.createElement('script');
    ldScript.id = 'bluedrop-jsonld';
    ldScript.type = 'application/ld+json';
    document.head.appendChild(ldScript);
  }
  ldScript.textContent = JSON.stringify(buildSeoJsonLdObject(page, origin, lang));
}
