/**
 * Localized copy for the generated Quick Tools landing pages.
 *
 * These pages are intentionally static and JS-free. The copy is generic enough
 * to apply to every converter/editor while still giving each locale a complete
 * page instead of a title and a handful of links.
 */

export interface QuickCopy {
  howTitle: string;
  steps: [string, string, string];
  formatsTitle: string;
  formatsBody: string;
  privacyTitle: string;
  privacyBody: string;
  faqTitle: string;
  faqs: Array<{ q: string; a: string }>;
  relatedTitle: string;
  languageTitle: string;
  home: string;
  guidesTitle: string;
  useCases: string;
  languages: string;
  allTools: string;
  imageAlt: string;
  proof: [string, string, string, string];
}

const COPY: Record<string, QuickCopy> = {
  en: {
    howTitle: 'How it works',
    steps: [
      'Choose a file from your device.',
      'Adjust the format, quality, or range.',
      'Process it locally and download the result.',
    ],
    formatsTitle: 'Supported formats',
    formatsBody:
      'Common audio, video, and image formats are handled in the browser. Anything the browser cannot decode falls back to the bundled local converter.',
    privacyTitle: 'Private by design',
    privacyBody:
      'Your file is decoded and processed in this tab. Nothing is uploaded, and the result is created on your device.',
    faqTitle: 'Questions',
    faqs: [
      { q: 'Is my file uploaded?', a: 'No. The file stays on this device and is never sent to a server.' },
      { q: 'Does this work offline?', a: 'The app shell is cached after the first visit. Model-based tools need their model downloaded once.' },
      { q: 'Is there a file-size limit?', a: 'Large files depend on available device memory. For very long media, use a desktop browser with enough free RAM.' },
    ],
    relatedTitle: 'Related tools',
    languageTitle: 'Language',
    home: 'Home',
    guidesTitle: 'Guides',
    useCases: 'Use cases',
    languages: 'Languages',
    allTools: 'All tools',
    imageAlt: 'LocalScribe app interface',
    proof: ['0 bytes uploaded', 'Local processing', 'No account', 'Offline after first visit'],
  },
  pt: {
    howTitle: 'Como funciona',
    steps: [
      'Escolha um arquivo do seu dispositivo.',
      'Ajuste o formato, a qualidade ou o intervalo.',
      'Processe localmente e baixe o resultado.',
    ],
    formatsTitle: 'Formatos compatíveis',
    formatsBody:
      'Formatos comuns de áudio, vídeo e imagem são processados no navegador. O que o navegador não conseguir decodificar usa o conversor local incluído.',
    privacyTitle: 'Privado por padrão',
    privacyBody:
      'Seu arquivo é decodificado e processado nesta aba. Nada é enviado, e o resultado é criado no seu dispositivo.',
    faqTitle: 'Perguntas',
    faqs: [
      { q: 'Meu arquivo é enviado?', a: 'Não. O arquivo fica neste dispositivo e nunca é enviado a um servidor.' },
      { q: 'Funciona offline?', a: 'A estrutura do app fica em cache após a primeira visita. Ferramentas com modelos precisam baixar o modelo uma vez.' },
      { q: 'Existe limite de tamanho?', a: 'Arquivos grandes dependem da memória disponível. Para mídias muito longas, use um navegador de desktop com RAM suficiente.' },
    ],
    relatedTitle: 'Ferramentas relacionadas',
    languageTitle: 'Idioma',
    home: 'Início',
    guidesTitle: 'Guias',
    useCases: 'Casos de uso',
    languages: 'Idiomas',
    allTools: 'Todas as ferramentas',
    imageAlt: 'Interface do LocalScribe',
    proof: ['0 bytes enviados', 'Processamento local', 'Sem conta', 'Offline após a primeira visita'],
  },
  es: {
    howTitle: 'Cómo funciona',
    steps: [
      'Elige un archivo de tu dispositivo.',
      'Ajusta el formato, la calidad o el intervalo.',
      'Procésalo localmente y descarga el resultado.',
    ],
    formatsTitle: 'Formatos compatibles',
    formatsBody:
      'Los formatos comunes de audio, vídeo e imagen se procesan en el navegador. Lo que el navegador no puede decodificar usa el conversor local incluido.',
    privacyTitle: 'Privado por diseño',
    privacyBody:
      'Tu archivo se decodifica y procesa en esta pestaña. No se sube nada y el resultado se crea en tu dispositivo.',
    faqTitle: 'Preguntas',
    faqs: [
      { q: '¿Se sube mi archivo?', a: 'No. El archivo permanece en este dispositivo y nunca se envía a un servidor.' },
      { q: '¿Funciona sin conexión?', a: 'La estructura de la app se guarda en caché tras la primera visita. Las herramientas con modelos necesitan descargar el modelo una vez.' },
      { q: '¿Hay un límite de tamaño?', a: 'Los archivos grandes dependen de la memoria disponible. Para medios muy largos, usa un navegador de escritorio con suficiente RAM.' },
    ],
    relatedTitle: 'Herramientas relacionadas',
    languageTitle: 'Idioma',
    home: 'Inicio',
    guidesTitle: 'Guías',
    useCases: 'Casos de uso',
    languages: 'Idiomas',
    allTools: 'Todas las herramientas',
    imageAlt: 'Interfaz de LocalScribe',
    proof: ['0 bytes subidos', 'Procesamiento local', 'Sin cuenta', 'Sin conexión tras la primera visita'],
  },
  fr: {
    howTitle: 'Comment ça marche',
    steps: [
      'Choisissez un fichier sur votre appareil.',
      'Ajustez le format, la qualité ou la plage.',
      'Traitez-le localement et téléchargez le résultat.',
    ],
    formatsTitle: 'Formats compatibles',
    formatsBody:
      'Les formats audio, vidéo et image courants sont traités dans le navigateur. Ce que le navigateur ne peut pas décoder passe par le convertisseur local intégré.',
    privacyTitle: 'Privé par conception',
    privacyBody:
      'Votre fichier est décodé et traité dans cet onglet. Rien n’est envoyé et le résultat est créé sur votre appareil.',
    faqTitle: 'Questions',
    faqs: [
      { q: 'Mon fichier est-il envoyé ?', a: 'Non. Le fichier reste sur cet appareil et n’est jamais envoyé à un serveur.' },
      { q: 'Cela fonctionne-t-il hors ligne ?', a: 'L’interface de l’application est mise en cache après la première visite. Les outils à modèle doivent télécharger leur modèle une fois.' },
      { q: 'Y a-t-il une limite de taille ?', a: 'Les gros fichiers dépendent de la mémoire disponible. Pour les médias très longs, utilisez un navigateur de bureau avec assez de RAM.' },
    ],
    relatedTitle: 'Outils associés',
    languageTitle: 'Langue',
    home: 'Accueil',
    guidesTitle: 'Guides',
    useCases: 'Cas d’usage',
    languages: 'Langues',
    allTools: 'Tous les outils',
    imageAlt: 'Interface de LocalScribe',
    proof: ['0 octet envoyé', 'Traitement local', 'Sans compte', 'Hors ligne après la première visite'],
  },
  de: {
    howTitle: 'So funktioniert es',
    steps: [
      'Wählen Sie eine Datei von Ihrem Gerät.',
      'Passen Sie Format, Qualität oder Bereich an.',
      'Verarbeiten Sie sie lokal und laden Sie das Ergebnis herunter.',
    ],
    formatsTitle: 'Unterstützte Formate',
    formatsBody:
      'Gängige Audio-, Video- und Bildformate werden im Browser verarbeitet. Was der Browser nicht dekodieren kann, übernimmt der mitgelieferte lokale Konverter.',
    privacyTitle: 'Privat by design',
    privacyBody:
      'Ihre Datei wird in diesem Tab dekodiert und verarbeitet. Nichts wird hochgeladen, und das Ergebnis entsteht auf Ihrem Gerät.',
    faqTitle: 'Fragen',
    faqs: [
      { q: 'Wird meine Datei hochgeladen?', a: 'Nein. Die Datei bleibt auf diesem Gerät und wird nie an einen Server gesendet.' },
      { q: 'Funktioniert das offline?', a: 'Die App-Hülle wird nach dem ersten Besuch zwischengespeichert. Modellbasierte Werkzeuge müssen ihr Modell einmal herunterladen.' },
      { q: 'Gibt es eine Dateigrößenbegrenzung?', a: 'Große Dateien hängen vom verfügbaren Gerätespeicher ab. Für sehr lange Medien verwenden Sie einen Desktop-Browser mit genügend RAM.' },
    ],
    relatedTitle: 'Verwandte Werkzeuge',
    languageTitle: 'Sprache',
    home: 'Start',
    guidesTitle: 'Anleitungen',
    useCases: 'Anwendungsfälle',
    languages: 'Sprachen',
    allTools: 'Alle Werkzeuge',
    imageAlt: 'LocalScribe-Oberfläche',
    proof: ['0 Bytes hochgeladen', 'Lokale Verarbeitung', 'Kein Konto', 'Offline nach dem ersten Besuch'],
  },
  zh: {
    howTitle: '使用方法',
    steps: [
      '从设备中选择一个文件。',
      '调整格式、质量或时间范围。',
      '在本机处理并下载结果。',
    ],
    formatsTitle: '支持的格式',
    formatsBody:
      '常见的音频、视频和图片格式会在浏览器中处理。浏览器无法解码的内容会使用内置的本地转换器。',
    privacyTitle: '隐私优先',
    privacyBody:
      '您的文件只在此标签页中解码和处理。不会上传任何内容，结果在本机生成。',
    faqTitle: '常见问题',
    faqs: [
      { q: '我的文件会被上传吗？', a: '不会。文件保留在此设备上，绝不会发送到服务器。' },
      { q: '可以离线使用吗？', a: '首次访问后会缓存应用外壳。基于模型的工具需要先下载一次模型。' },
      { q: '有文件大小限制吗？', a: '大文件取决于设备可用内存。处理很长的媒体时，请使用内存充足的桌面浏览器。' },
    ],
    relatedTitle: '相关工具',
    languageTitle: '语言',
    home: '首页',
    guidesTitle: '指南',
    useCases: '使用场景',
    languages: '语言',
    allTools: '所有工具',
    imageAlt: 'LocalScribe 界面',
    proof: ['0 字节上传', '本地处理', '无需账户', '首次访问后可离线'],
  },
  ja: {
    howTitle: '使い方',
    steps: [
      'デバイスからファイルを選択します。',
      '形式、品質、範囲を調整します。',
      'この端末で処理し、結果をダウンロードします。',
    ],
    formatsTitle: '対応形式',
    formatsBody:
      '一般的な音声、動画、画像形式はブラウザで処理されます。ブラウザがデコードできない場合は、内蔵のローカル変換器を使用します。',
    privacyTitle: 'プライバシー重視',
    privacyBody:
      'ファイルはこのタブ内でデコードされ、処理されます。アップロードは行われず、結果は端末上で作成されます。',
    faqTitle: 'よくある質問',
    faqs: [
      { q: 'ファイルはアップロードされますか？', a: 'いいえ。ファイルはこの端末に残り、サーバーに送信されることはありません。' },
      { q: 'オフラインで使えますか？', a: '初回アクセス後にアプリ本体がキャッシュされます。モデルを使うツールは初回のみモデルのダウンロードが必要です。' },
      { q: 'ファイルサイズの上限はありますか？', a: '大きなファイルは端末の空きメモリに依存します。非常に長いメディアには、十分なRAMがあるデスクトップブラウザをご利用ください。' },
    ],
    relatedTitle: '関連ツール',
    languageTitle: '言語',
    home: 'ホーム',
    guidesTitle: 'ガイド',
    useCases: '用途',
    languages: '言語',
    allTools: 'すべてのツール',
    imageAlt: 'LocalScribe の画面',
    proof: ['アップロード 0 バイト', 'ローカル処理', 'アカウント不要', '初回アクセス後はオフライン'],
  },
  ko: {
    howTitle: '사용 방법',
    steps: [
      '기기에서 파일을 선택합니다.',
      '형식, 품질 또는 범위를 조정합니다.',
      '이 기기에서 처리하고 결과를 다운로드합니다.',
    ],
    formatsTitle: '지원 형식',
    formatsBody:
      '일반적인 오디오, 비디오, 이미지 형식은 브라우저에서 처리됩니다. 브라우저가 디코딩할 수 없는 경우 내장된 로컬 변환기를 사용합니다.',
    privacyTitle: '개인정보 보호',
    privacyBody:
      '파일은 이 탭에서 디코딩되고 처리됩니다. 아무것도 업로드되지 않으며 결과는 기기에서 생성됩니다.',
    faqTitle: '질문',
    faqs: [
      { q: '파일이 업로드되나요?', a: '아니요. 파일은 이 기기에 남아 있으며 서버로 전송되지 않습니다.' },
      { q: '오프라인에서 작동하나요?', a: '처음 방문한 후 앱 셸이 캐시됩니다. 모델 기반 도구는 모델을 한 번 다운로드해야 합니다.' },
      { q: '파일 크기 제한이 있나요?', a: '큰 파일은 사용 가능한 기기 메모리에 따라 달라집니다. 매우 긴 미디어는 RAM이 충분한 데스크톱 브라우저를 사용하세요.' },
    ],
    relatedTitle: '관련 도구',
    languageTitle: '언어',
    home: '홈',
    guidesTitle: '가이드',
    useCases: '사용 사례',
    languages: '언어',
    allTools: '모든 도구',
    imageAlt: 'LocalScribe 인터페이스',
    proof: ['업로드 0바이트', '로컬 처리', '계정 불필요', '첫 방문 후 오프라인'],
  },
  ru: {
    howTitle: 'Как это работает',
    steps: [
      'Выберите файл на своём устройстве.',
      'Настройте формат, качество или диапазон.',
      'Обработайте локально и скачайте результат.',
    ],
    formatsTitle: 'Поддерживаемые форматы',
    formatsBody:
      'Распространённые аудио-, видео- и графические форматы обрабатываются в браузере. Если браузер не может их декодировать, используется встроенный локальный конвертер.',
    privacyTitle: 'Приватность по умолчанию',
    privacyBody:
      'Файл декодируется и обрабатывается в этой вкладке. Ничего не загружается, а результат создаётся на вашем устройстве.',
    faqTitle: 'Вопросы',
    faqs: [
      { q: 'Мой файл загружается?', a: 'Нет. Файл остаётся на этом устройстве и никогда не отправляется на сервер.' },
      { q: 'Работает ли это офлайн?', a: 'Оболочка приложения кешируется после первого визита. Инструментам с моделями нужно один раз скачать модель.' },
      { q: 'Есть ли ограничение по размеру?', a: 'Большие файлы зависят от доступной памяти устройства. Для очень длинных медиа используйте настольный браузер с достаточным объёмом ОЗУ.' },
    ],
    relatedTitle: 'Связанные инструменты',
    languageTitle: 'Язык',
    home: 'Главная',
    guidesTitle: 'Руководства',
    useCases: 'Сценарии',
    languages: 'Языки',
    allTools: 'Все инструменты',
    imageAlt: 'Интерфейс LocalScribe',
    proof: ['0 байт загружено', 'Локальная обработка', 'Без аккаунта', 'Офлайн после первого визита'],
  },
};

export function quickCopy(locale: string): QuickCopy {
  return COPY[locale] ?? COPY.en;
}
