/**
 * Multilingual Dictionary & Directionality (`src/media/i18n.ts`)
 * Supports English (en), French (fr), and Arabic / Darija (ar) with auto dir.
 * Strictly zero emojis and zero exposed AI/telemetry labels — lyrics-only user output.
 */

export type UiLang = 'en' | 'fr' | 'ar';

export interface UiCopy {
  navDownloader: string;
  navConverter: string;
  navSeo: string;
  navInstall: string;
  navUpload: string;
  railStudioHeading: string;
  railFoldersHeading: string;
  ctaQuickPaste: string;
  heroTitle: string;
  heroSubtitle: string;
  searchPlaceholder: string;
  inspectBtn: string;
  searchAll: string;
  searchMusic: string;
  searchVideo: string;
  localDropTitle: string;
  localDropSub: string;
  localPickFile: string;
  formatsHeading: string;
  preparingStream: string;
  downloadReady: string;
  mascotStageTitle: string;
  mascotStageHint: string;
  installTitle: string;
  installBody: string;
  installPwaBtn: string;
  resultsTabAll: string;
  resultsTabLibrary: string;
  librarySearchPlaceholder: string;
  libraryUploadBtn: string;
  fullscreenBtn: string;
  pipBtn: string;
  iosGuideText: string;
  lyricsHeading: string;
  noLyricsYet: string;
  translateLyricsBtn: string;
  saveBookmarkLabel: string;
  savedToLabel: string;
  newFolderPlaceholder: string;
  createFolderBtn: string;
  gridViewLabel: string;
  listViewLabel: string;
  expandPlayerLabel: string;
  minimizePlayerLabel: string;
  extractingLinkLabel: string;
  uploadReadyBadge: string;
  orderSequential: string;
  orderShuffle: string;
  playQueueBtn: string;
  allArtistsLabel: string;
  extractLyricsBtn: string;
  downloadVideoBtn: string;
  downloadAudioBtn: string;
  signInGmailBtn: string;
  signOutBtn: string;
  authGateTitle: string;
  authGateBody: string;
  authGateCta: string;
}

export const UI_COPY: Record<UiLang, UiCopy> = {
  en: {
    navDownloader: 'Discover',
    navConverter: 'Converter',
    navSeo: 'Platforms',
    navInstall: 'Apps',
    navUpload: 'Upload',
    railStudioHeading: 'MUSIC & MEDIA STUDIO',
    railFoldersHeading: 'PLAYLISTS & FOLDERS',
    ctaQuickPaste: 'Paste URL',
    heroTitle: 'Any video, song, or frame. Zero ads.',
    heroSubtitle:
      '100% ad-free downloader & music player for YouTube, TikTok, Instagram, Facebook, SoundCloud, Audius, Bandcamp & X. Save 4K MP4, 320kbps MP3, WAV, FLAC, or PNG with zero popups.',
    searchPlaceholder: 'Paste media URL or search any song, artist, or video...',
    inspectBtn: 'Extract & Search',
    searchAll: 'All Media',
    searchMusic: 'Music & Audio',
    searchVideo: 'Video & Reels',
    localDropTitle: 'Local Any-Format Studio',
    localDropSub:
      'Drop any video, audio, or image from your PC, Mac, or phone to convert cleanly or save straight to your device library.',
    localPickFile: 'Choose File(s) from Device',
    formatsHeading: 'Format Matrix — Click Any Format to Download',
    preparingStream: 'Preparing clean high-speed stream...',
    downloadReady: 'Download started.',
    mascotStageTitle: 'DROPY · HEADPHONE STUDIO BOT',
    mascotStageHint: 'STEER INSIDE BOX · WALL RICOCHET ON EXIT',
    installTitle: 'Install BLUEDROP App on Every Device',
    installBody:
      'Music-app experience on Desktop, Tablet, iOS & Android with lock-screen background playback, playlists, local file uploads, and full-screen cinema view.',
    installPwaBtn: 'Install App Now',
    resultsTabAll: 'Discovery',
    resultsTabLibrary: 'My Library',
    librarySearchPlaceholder: 'Filter by title, artist name, folder, or tag...',
    libraryUploadBtn: 'Upload Media',
    fullscreenBtn: 'Full Screen',
    pipBtn: 'PiP Window',
    iosGuideText: 'iPhone / iPad: Tap Safari Share button -> Add to Home Screen.',
    lyricsHeading: 'Lyrics',
    noLyricsYet: 'No lyrics loaded yet — tap Extract Lyrics for this track.',
    translateLyricsBtn: 'Translate Lyrics (Darija / AR / FR)',
    saveBookmarkLabel: 'Save',
    savedToLabel: 'Saved to',
    newFolderPlaceholder: 'New playlist or folder name...',
    createFolderBtn: 'Create Folder',
    gridViewLabel: 'Grid',
    listViewLabel: 'List',
    expandPlayerLabel: 'Player & Lyrics',
    minimizePlayerLabel: 'Minimize',
    extractingLinkLabel: 'EXTRACTING MEDIA LINK & STREAM...',
    uploadReadyBadge: 'READY IN YOUR DEVICE LIBRARY',
    orderSequential: 'In Order',
    orderShuffle: 'Shuffle',
    playQueueBtn: 'Play Queue',
    allArtistsLabel: 'All Artists',
    extractLyricsBtn: 'Extract Lyrics',
    downloadVideoBtn: 'Download Video (MP4)',
    downloadAudioBtn: 'Download Audio (MP3)',
    signInGmailBtn: 'Sign in with Gmail',
    signOutBtn: 'Sign out',
    authGateTitle: 'Sign in with Gmail to Download & Install',
    authGateBody:
      'Sign in once with your Google / Gmail account to unlock all format downloads, app installation across devices, and permanent profile & library sync.',
    authGateCta: 'Continue with Gmail',
  },
  fr: {
    navDownloader: 'Explorer',
    navConverter: 'Convertir',
    navSeo: 'Plateformes',
    navInstall: 'Installer',
    navUpload: 'Importer',
    railStudioHeading: 'STUDIO MUSIQUE & MÉDIA',
    railFoldersHeading: 'PLAYLISTS & DOSSIERS',
    ctaQuickPaste: 'Coller Lien',
    heroTitle: 'Chaque vidéo, musique ou image. 100% sans pub.',
    heroSubtitle:
      'Téléchargeur vidéo & lecteur musical sans publicité pour YouTube, TikTok, Instagram, Facebook, SoundCloud, Audius et X. Convertissez en MP4 4K, MP3 320kbps, WAV, FLAC ou PNG sans pop-up.',
    searchPlaceholder: 'Collez une URL ou cherchez une musique, un artiste, une vidéo...',
    inspectBtn: 'Extraire & Chercher',
    searchAll: 'Tout Média',
    searchMusic: 'Musique & Audio',
    searchVideo: 'Vidéo & Reels',
    localDropTitle: 'Studio Local Multi-Formats',
    localDropSub:
      'Importez vos vidéos, pistes audio ou images depuis PC, Mac ou mobile pour conversion FFmpeg et sauvegarde locale.',
    localPickFile: 'Choisir fichier(s)',
    formatsHeading: 'Matrice de Formats — Cliquez pour Télécharger',
    preparingStream: 'Préparation du flux haute vitesse...',
    downloadReady: 'Téléchargement lancé.',
    mascotStageTitle: 'DROPY · PERSONNAGE CASQUE 3D',
    mascotStageHint: 'SUIT LE CURSEUR · REBONDIT SUR LES MURS',
    installTitle: 'Installer BLUEDROP sur Tous Vos Appareils',
    installBody:
      'Expérience application musicale complète (PC, Mac, Tablette, iOS & Android) avec lecture en arrière-plan, playlists et mode plein écran.',
    installPwaBtn: 'Installer l’App',
    resultsTabAll: 'Découvrir',
    resultsTabLibrary: 'Bibliothèque',
    librarySearchPlaceholder: 'Filtrer par titre, nom d’artiste, dossier ou tag...',
    libraryUploadBtn: 'Importer Média',
    fullscreenBtn: 'Plein Écran',
    pipBtn: 'Fenêtre PiP',
    iosGuideText: 'iPhone / iPad : Touchez Partager dans Safari -> Sur l’écran d’accueil.',
    lyricsHeading: 'Paroles',
    noLyricsYet: 'Aucune parole chargée — touchez Extraire Paroles.',
    translateLyricsBtn: 'Traduire Paroles (Darija / AR / FR)',
    saveBookmarkLabel: 'Enregistrer',
    savedToLabel: 'Dossier',
    newFolderPlaceholder: 'Nouvelle playlist ou dossier...',
    createFolderBtn: 'Créer Dossier',
    gridViewLabel: 'Grille',
    listViewLabel: 'Liste',
    expandPlayerLabel: 'Lecteur & Paroles',
    minimizePlayerLabel: 'Réduire',
    extractingLinkLabel: 'EXTRACTION DU LIEN & FLUX EN COURS...',
    uploadReadyBadge: 'PRÊT DANS VOTRE BIBLIOTHÈQUE',
    orderSequential: 'Dans l’ordre',
    orderShuffle: 'Aléatoire',
    playQueueBtn: 'Tout Lire',
    allArtistsLabel: 'Tous Artistes',
    extractLyricsBtn: 'Extraire Paroles',
    downloadVideoBtn: 'Télécharger Vidéo (MP4)',
    downloadAudioBtn: 'Télécharger Audio (MP3)',
    signInGmailBtn: 'Connexion Gmail',
    signOutBtn: 'Déconnexion',
    authGateTitle: 'Connectez-vous avec Gmail pour Télécharger',
    authGateBody:
      'Validez votre compte Gmail pour débloquer tous les formats, l’installation de l’application et la synchronisation de votre bibliothèque.',
    authGateCta: 'Continuer avec Gmail',
  },
  ar: {
    navDownloader: 'اكتشف',
    navConverter: 'تحويل',
    navSeo: 'المنصات',
    navInstall: 'التطبيق',
    navUpload: 'رفع ملف',
    railStudioHeading: 'استوديو الموسيقى والفيديو',
    railFoldersHeading: 'البلاي ليست والملفات',
    ctaQuickPaste: 'لصق الرابط',
    heroTitle: 'أي فيديو، موسيقى، أو صورة. مجاناً وبدون إشهارات.',
    heroSubtitle:
      'لصق رابط من يوتيوب، تيك توك، إنستغرام، فيسبوك، ساوندكلاود، أوديوس أو X. حمّل بصيغ MP4 4K و MP3 320kbps و WAV و FLAC أو اسمع للموسيقى مباشرة 100% بدون أي إشهارات.',
    searchPlaceholder: 'لصق رابط الفيديو أو قلب على سمية الأغنية أو الفنان...',
    inspectBtn: 'استخراج وبحث',
    searchAll: 'الكل',
    searchMusic: 'موسيقى وصوت',
    searchVideo: 'فيديو وريلز',
    localDropTitle: 'محوّل الملفات المحلي والمكتبة',
    localDropSub:
      'حط أي فيديو، موسيقى، أو صورة من الحاسوب أو الهاتف باش يتحوّل أو يتسجّل فـ مكتبتك الخاصة.',
    localPickFile: 'اختيار ملف(ات) من الجهاز',
    formatsHeading: 'جدول الصيغ — اضغط على أي صيغة للتحميل الفوري',
    preparingStream: 'جاري تجهيز رابط التحميل السريع...',
    downloadReady: 'بدأ التحميل.',
    mascotStageTitle: 'DROPY · شخصية الكاسك 3D',
    mascotStageHint: 'كتبع الماوس وكتضرب فالحواف وترجع',
    installTitle: 'حمّل تطبيق BLUEDROP على جميع أجهزتك',
    installBody:
      'تجربة تطبيق موسيقى كامل (الحاسوب، التابلت، آيفون iOS وأندرويد) مع تشغيل الموسيقى فاش تخرج من التطبيق وتنظيم القوائم وتكبير الشاشة.',
    installPwaBtn: 'تثبيت التطبيق الآن',
    resultsTabAll: 'اكتشاف',
    resultsTabLibrary: 'مكتبتي',
    librarySearchPlaceholder: 'كتب سمية الفنان أو الأغنية أو الملف باش يطلع لك...',
    libraryUploadBtn: 'رفع ملف للمكتبة',
    fullscreenBtn: 'تكبير الشاشة',
    pipBtn: 'نافذة عائمة',
    iosGuideText: 'في آيفون / آيباد: ضغط على زر المشاركة في Safari ثم أضف إلى الشاشة الرئيسية.',
    lyricsHeading: 'الكلمات (Lyrics)',
    noLyricsYet: 'ما كاينينش كلمات دابا — كليكي على استخراج الكلمات.',
    translateLyricsBtn: 'ترجمة الكلمات (دارجة / عربية / فرنسية)',
    saveBookmarkLabel: 'حفظ',
    savedToLabel: 'تسجّل فـ',
    newFolderPlaceholder: 'سمية بلاي ليست أو ملف جديد...',
    createFolderBtn: 'إنشاء ملف',
    gridViewLabel: 'شبكة',
    listViewLabel: 'لائحة',
    expandPlayerLabel: 'المشغّل والكلمات',
    minimizePlayerLabel: 'تصغير',
    extractingLinkLabel: 'جاري استخراج الرابط والمعلومات...',
    uploadReadyBadge: 'محفوظ فـ مكتبتك على الجهاز',
    orderSequential: 'بالترتيب',
    orderShuffle: 'مخربقة',
    playQueueBtn: 'تشغيل اللائحة',
    allArtistsLabel: 'كاع الفنانين',
    extractLyricsBtn: 'استخراج الكلمات',
    downloadVideoBtn: 'تحميل الفيديو (MP4)',
    downloadAudioBtn: 'تحميل الموسيقى (MP3)',
    signInGmailBtn: 'تسجيل الدخول بـ Gmail',
    signOutBtn: 'خروج',
    authGateTitle: 'سجّل الدخول بـ Gmail باش تفتح التحميل والتثبيت',
    authGateBody:
      'أكد حساب Gmail ديالك مرة وحدة باش تحمل كاع الصيغ (فيديو، موسيقى، صورة، أو التطبيق)، وتبقى مكتبتك وصورتك مسجلين دائماً.',
    authGateCta: 'المتابعة بحساب Gmail',
  },
};
