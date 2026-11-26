/**
 * Programmatic SEO content.
 *
 * Every entry becomes a static HTML page under /<slug>/ at build time. The
 * pages share a design and model table, but the intro, bullets, FAQ, and
 * metadata are written per page so they are not thin duplicates.
 */

export interface SeoModel {
  id: string;
  name: string;
  size: string;
  languages: string;
  bestFor: string;
  note: string;
}

export interface SeoFaq {
  q: string;
  a: string;
}

export interface SeoStep {
  title: string;
  body: string;
}

export interface SeoPage {
  slug: string;
  nav: string;
  eyebrow: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  intro: string[];
  bullets: Array<{ title: string; body: string }>;
  steps?: SeoStep[];
  modelIds: string[];
  /** Job preset used by the app CTA. */
  preset?: string;
  /** Explicit query string for the app CTA, without the leading ?. */
  appQuery?: string;
  faq: SeoFaq[];
  related: string[];
  keywords: string[];
}

export const MODELS: Record<string, SeoModel> = {
  'fluid-mini': {
    id: 'fluid-mini',
    name: 'Fluid Speech Mini',
    size: '300 MB',
    languages: 'English',
    bestFor: 'English dictation',
    note: 'The default English model. Small enough to keep cached, accurate enough for real work.',
  },
  'moonshine-tiny': {
    id: 'moonshine-tiny',
    name: 'Moonshine Tiny',
    size: '32 MB',
    languages: 'English',
    bestFor: 'Short voice notes',
    note: 'The smallest option. Downloads quickly and runs on CPU, which makes it good for phones and quick clips.',
  },
  'moonshine-base': {
    id: 'moonshine-base',
    name: 'Moonshine Base',
    size: '67 MB',
    languages: 'English',
    bestFor: 'Short clips, better accuracy',
    note: 'A larger Moonshine model for short English recordings where the extra accuracy is worth 67 MB.',
  },
  'parakeet-redux': {
    id: 'parakeet-redux',
    name: 'Parakeet Redux',
    size: '208 MB',
    languages: '25 European languages',
    bestFor: 'Smallest multilingual',
    note: 'The best size-to-coverage ratio for European languages. A 2-bit encoder keeps the download small.',
  },
  'fluid-pro': {
    id: 'fluid-pro',
    name: 'Fluid Speech Pro',
    size: '801 MB',
    languages: '25 European languages',
    bestFor: 'Multilingual meetings',
    note: 'The most accurate multilingual option in the catalog, with optional clean mode for filler removal.',
  },
  'phonon-2': {
    id: 'phonon-2',
    name: 'Phonon-2',
    size: '688 MB',
    languages: 'English',
    bestFor: 'Best English accuracy',
    note: 'An English TDT model with an exact preprocessor. Pick it when accuracy matters more than download size.',
  },
  'rumble-2-flash': {
    id: 'rumble-2-flash',
    name: 'Rumble-2-Flash',
    size: '656 MB',
    languages: '45 languages, auto-detected',
    bestFor: 'Phone-call audio',
    note: 'Tuned for compressed call audio, with automatic language detection and number formatting.',
  },
  'qwen3-asr-0.6b': {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    size: '987 MB',
    languages: '30 languages + 22 Chinese dialects',
    bestFor: 'Meetings and Asian languages',
    note: 'A larger multilingual model with strong Asian-language coverage, singing voice, and language detection.',
  },
  'omnilingual-300m': {
    id: 'omnilingual-300m',
    name: 'Omnilingual ASR 300M',
    size: '328 MB',
    languages: '1,600+ languages',
    bestFor: 'Long-tail languages',
    note: 'Meta’s CTC model for languages that other open models do not cover. Output has no punctuation.',
  },
  'granite-speech-5': {
    id: 'granite-speech-5',
    name: 'Granite Speech 5.0 2B',
    size: '1.73 GB',
    languages: '6 languages + English translation',
    bestFor: 'Punctuation and translation',
    note: 'IBM’s speech-language model. Requires WebGPU and a larger download, and adds punctuation and translation.',
  },
};

export const DEFAULT_STEPS: SeoStep[] = [
  {
    title: 'Load the recording',
    body: 'Drop the file, record from the microphone, or open the bundled sample. Audio is decoded in the tab.',
  },
  {
    title: 'Pick a model',
    body: 'Choose by language and download size. The app shows whether the model is cached and whether it fits this device.',
  },
  {
    title: 'Transcribe and export',
    body: 'The transcript streams in as it is decoded. Edit it, then copy or download TXT, SRT, VTT, Markdown, or JSON.',
  },
];

export const USE_CASES: SeoPage[] = [
  {
    slug: 'audio-to-text',
    nav: 'Audio to text',
    eyebrow: 'Speech & audio',
    title: 'Audio to text, without uploading the audio',
    metaTitle: 'Audio to text in your browser — no upload | LocalScribe',
    metaDescription:
      'Transcribe OGG, WAV, MP3, M4A, MP4, or WebM entirely in your browser. Ten local speech models, editable text, SRT/VTT export, no account, no backend.',
    intro: [
      'LocalScribe turns a recording into editable text inside the tab. The file is decoded with the Web Audio API and passed to an ONNX speech model running on WebGPU or WebAssembly. The audio is never posted to a server.',
      'Ten speech models are available, from a 32 MB English model for short notes to multilingual models covering 45 languages and an OmniASR model for more than 1,600. The model shelf makes the trade-off between download size, accuracy, and language coverage explicit.',
    ],
    bullets: [
      {
        title: 'Ten speech models',
        body: 'Fluid Speech, Moonshine, Parakeet, Phonon, Rumble, Qwen3-ASR, Omnilingual, and Granite Speech — none of them require an API key.',
      },
      {
        title: 'Audio and video input',
        body: 'OGG, WAV, MP3, M4A, MP4, and WebM. Video files are decoded for their audio track in the tab.',
      },
      {
        title: 'Editable, timed output',
        body: 'Every segment carries a start and end time. Click a segment to seek the player.',
      },
      {
        title: 'Exports that fit the job',
        body: 'TXT, SRT, VTT, Markdown, and JSON from the same transcript, with optional punctuation and number clean-up.',
      },
    ],
    modelIds: ['fluid-mini', 'moonshine-tiny', 'parakeet-redux', 'qwen3-asr-0.6b'],
    preset: 'dictation',
    faq: [
      {
        q: 'Is the transcription really local?',
        a: 'Yes. The page has no backend. Audio is decoded and transcribed in the tab. The only network requests are for model weights from Hugging Face, and those are cached after the first download.',
      },
      {
        q: 'Do I need an account or an API key?',
        a: 'No. There is no sign-up, no API key, and no per-minute billing. The app is a static site.',
      },
      {
        q: 'Does it work offline?',
        a: 'After the first visit and model download, the production build can reload offline and keep transcribing from the local cache. The service worker caches the app shell and the runtime actually used.',
      },
      {
        q: 'Which model should I start with?',
        a: 'Fluid Speech Mini for English dictation, Moonshine Tiny for short voice notes, and Parakeet Redux for European languages. The app labels each model with its best use and whether it runs here.',
      },
    ],
    related: ['dictation', 'subtitles', 'private-transcription'],
    keywords: ['audio to text', 'transcribe audio in browser', 'local transcription', 'no upload transcription'],
  },
  {
    slug: 'dictation',
    nav: 'Dictation',
    eyebrow: 'Dictation',
    title: 'Browser dictation that keeps every word on your device',
    metaTitle: 'Browser dictation — speak and get text locally | LocalScribe',
    metaDescription:
      'Dictate into a browser page with a local speech model. Record, stop, edit, and copy. No audio upload, no account, offline after the first download.',
    intro: [
      'Press record, speak, and stop. The recording is encoded by the browser, decoded in the tab, and transcribed by the selected model. The text appears in an editable box and can be copied or downloaded.',
      'This is dictation for people who do not want a cloud service listening. It is not a system-wide keyboard replacement; it is a page where you can dictate a note, a draft, or a transcript and then take the text anywhere.',
    ],
    bullets: [
      {
        title: 'Microphone to text',
        body: 'A timer and level meter make it clear when the browser is recording. Stopping the recording starts transcription automatically.',
      },
      {
        title: 'Dictation clean-up',
        body: 'Optionally turn spoken punctuation and number words into text: “comma”, “full stop”, and “twenty five percent”.',
      },
      {
        title: 'Pick accuracy vs speed',
        body: 'Moonshine Tiny is 32 MB; Fluid Speech Mini is 300 MB; Phonon-2 is the accuracy pick at 688 MB.',
      },
      {
        title: 'Keep a local record',
        body: 'Turn on history to keep text and timings in IndexedDB. Audio is never stored, and turning history off deletes the database.',
      },
    ],
    modelIds: ['fluid-mini', 'moonshine-tiny', 'phonon-2'],
    preset: 'dictation',
    faq: [
      {
        q: 'Does the browser need microphone permission?',
        a: 'Yes. The page asks for microphone access the first time. Permission can be revoked in the address-bar menu. HTTPS or localhost is required.',
      },
      {
        q: 'Can I dictate offline?',
        a: 'Yes, after the model has been downloaded once. The microphone and the model both run locally; no network request carries the recording.',
      },
      {
        q: 'Is the punctuation automatic?',
        a: 'Several models emit punctuation themselves. The optional clean-up pass adds spoken punctuation and converts number words, and is applied to the final transcript only.',
      },
      {
        q: 'How long can one dictation be?',
        a: 'The recording is decoded into memory, so very long sessions are limited by available RAM. For long recordings, use the file upload path and the silence-aware chunking.',
      },
    ],
    related: ['voice-notes', 'audio-to-text', 'private-transcription'],
    keywords: ['browser dictation', 'dictation without cloud', 'speech to text microphone', 'private dictation'],
  },
  {
    slug: 'meetings',
    nav: 'Meetings',
    eyebrow: 'Use case',
    title: 'Meeting transcription that stays in your browser',
    metaTitle: 'Meeting transcription in the browser | LocalScribe',
    metaDescription:
      'Transcribe meeting recordings locally with automatic language detection, clickable segments, and SRT/VTT export. No bot joins the call and no audio is uploaded.',
    intro: [
      'Drop a call or meeting recording into the tab and get a transcript with timestamps. Rumble-2-Flash detects 45 languages automatically; Qwen3-ASR covers 30 languages and 22 Chinese dialects.',
      'The transcript is split into silence-aware segments. Clicking a segment seeks the audio player, which makes it practical to check names, numbers, and decisions against the recording.',
    ],
    bullets: [
      {
        title: 'Automatic language detection',
        body: 'Rumble and Qwen3-ASR can detect the spoken language, or you can force one for short or mixed recordings.',
      },
      {
        title: 'Clickable segments',
        body: 'Each segment has a start and end time. Use the segment list to jump around the recording.',
      },
      {
        title: 'Subtitle exports',
        body: 'Export SRT or VTT for a video review, or Markdown for notes. The text stays editable before export.',
      },
      {
        title: 'No meeting bot',
        body: 'There is nothing to invite and no service joining the call. You transcribe a recording you already have.',
      },
    ],
    modelIds: ['qwen3-asr-0.6b', 'rumble-2-flash', 'fluid-pro'],
    preset: 'meeting',
    faq: [
      {
        q: 'Does it label who spoke?',
        a: 'Not yet. The current build gives timed segments but no speaker diarization. The transcript is editable, so names can be added by hand.',
      },
      {
        q: 'How long a meeting can it handle?',
        a: 'Long recordings are split at quiet points into model-sized chunks, so memory stays bounded. A multi-hour meeting is limited by the device and the selected model.',
      },
      {
        q: 'Can it handle multiple languages in one meeting?',
        a: 'Automatic detection is designed for a primary language. For mixed-language meetings, forcing a language or splitting the recording by language gives more predictable results.',
      },
    ],
    related: ['interview', 'lecture', 'subtitles'],
    keywords: ['meeting transcription', 'transcribe meeting locally', 'browser meeting notes', 'no meeting bot'],
  },
  {
    slug: 'subtitles',
    nav: 'Subtitles',
    eyebrow: 'Use case',
    title: 'Generate SRT and VTT subtitles locally',
    metaTitle: 'SRT and VTT subtitle generator in your browser | LocalScribe',
    metaDescription:
      'Drop a video, transcribe it in the browser, and export SRT or VTT with real segment timings. The video is never uploaded and no account is needed.',
    intro: [
      'Subtitles need timings, not just text. LocalScribe keeps the start and end of every segment and turns them into SRT or VTT cues when you export.',
      'The input can be a video file: MP4 and WebM are decoded in the tab for their audio track. Nothing is uploaded, which matters when the footage is unreleased or confidential.',
    ],
    bullets: [
      {
        title: 'Video in, captions out',
        body: 'MP4, WebM, MOV, and MKV are accepted. The browser decodes the audio track and the model transcribes it.',
      },
      {
        title: 'Real segment timings',
        body: 'SRT and VTT are generated from the same segment boundaries used during decoding, not from character estimates.',
      },
      {
        title: 'Editable before export',
        body: 'Fix a name or line break in the transcript and the exported captions use the edited text.',
      },
      {
        title: 'No upload for confidential footage',
        body: 'The file is read locally, and history stores text only. The original video is never copied into the browser database.',
      },
    ],
    modelIds: ['fluid-mini', 'moonshine-base', 'parakeet-redux'],
    preset: 'dictation',
    faq: [
      {
        q: 'Does it burn subtitles into the video?',
        a: 'No. It exports SRT or VTT files for a player, editor, or YouTube upload. Burning captions requires a video editor.',
      },
      {
        q: 'How accurate are the timings?',
        a: 'They follow the model’s silence-aware segments. For tightly timed captions, review and adjust cue boundaries in your editor.',
      },
      {
        q: 'Which video formats are supported?',
        a: 'MP4, WebM, MOV, and MKV when the browser can decode their audio codec. The audio is resampled to 16 kHz mono for the model.',
      },
    ],
    related: ['podcast-transcription', 'lecture', 'meetings'],
    keywords: ['srt generator', 'vtt generator', 'subtitle transcription browser', 'video to subtitles local'],
  },
  {
    slug: 'podcast-transcription',
    nav: 'Podcasts',
    eyebrow: 'Use case',
    title: 'Transcribe podcast episodes without a cloud service',
    metaTitle: 'Podcast transcription, local and private | LocalScribe',
    metaDescription:
      'Transcribe podcast episodes locally, clean up filler words, and export show notes as Markdown, TXT, or subtitles. No upload and no per-minute fee.',
    intro: [
      'Podcast episodes are long, so the useful questions are memory, throughput, and how much editing the output needs. LocalScribe splits at silence, keeps the transcript editable, and can run Fluid Speech Pro’s clean mode to drop fillers and repeated words.',
      'You can queue several episodes and let them run one at a time with the same model. Each finished transcript can be saved locally or exported immediately.',
    ],
    bullets: [
      {
        title: 'Long-form friendly',
        body: 'Silence-aware chunking keeps memory bounded instead of feeding an hour of audio to the model at once.',
      },
      {
        title: 'Clean mode',
        body: 'Fluid Speech Pro can remove filler words and repetitions. Leave it off for a verbatim record.',
      },
      {
        title: 'Show-notes exports',
        body: 'Markdown, TXT, JSON, SRT, and VTT from the same transcript. Markdown includes the file name, model, and duration.',
      },
      {
        title: 'Batch queue',
        body: 'Add several episodes, run them with one model, and keep the results in local history.',
      },
    ],
    modelIds: ['fluid-pro', 'phonon-2', 'parakeet-redux'],
    preset: 'accuracy',
    faq: [
      {
        q: 'Can it transcribe music and singing?',
        a: 'Qwen3-ASR is the best fit for singing and songs with background music. The English dictation models are tuned for speech and may produce unstable text over music.',
      },
      {
        q: 'How do I handle multiple episodes?',
        a: 'Use the batch queue in Audio to text. Files run sequentially with the selected model, and each result can be saved to local history.',
      },
      {
        q: 'Is there a minute limit?',
        a: 'No per-minute limit and no billing. The practical limit is browser memory and the time it takes to decode on your device.',
      },
    ],
    related: ['interview', 'subtitles', 'audio-to-text'],
    keywords: ['podcast transcription', 'transcribe podcast locally', 'show notes from audio', 'podcast to text'],
  },
  {
    slug: 'interview-transcription',
    nav: 'Interviews',
    eyebrow: 'Use case',
    title: 'Interview transcription for recordings you cannot upload',
    metaTitle: 'Private interview transcription | LocalScribe',
    metaDescription:
      'Transcribe interviews locally, keep the audio on your machine, and export quotes with timestamps. No upload, no account, no backend.',
    intro: [
      'Interviews often contain information that should not be sent to a transcription service: names, health details, legal matters, or unreleased research. LocalScribe reads the file and runs the model in the tab.',
      'The transcript is split into timed segments, so a quote can be checked against the recording and exported as SRT, VTT, Markdown, or plain text.',
    ],
    bullets: [
      {
        title: 'The audio does not move',
        body: 'The file is decoded by the browser. It is not uploaded, not proxied, and not stored in history.',
      },
      {
        title: 'Check quotes against the audio',
        body: 'Click a segment to seek the player, or click the waveform to jump. The active segment is highlighted.',
      },
      {
        title: 'Editable before export',
        body: 'Fix names and punctuation in the transcript, then download the corrected text or captions.',
      },
      {
        title: 'Local history, off by default',
        body: 'If you want transcripts to survive a reload, enable history. It stores text and timings only, and deleting it removes the database.',
      },
    ],
    modelIds: ['fluid-mini', 'qwen3-asr-0.6b', 'parakeet-redux'],
    preset: 'dictation',
    faq: [
      {
        q: 'Is it suitable for confidential interviews?',
        a: 'The architecture keeps audio in the tab and has no backend, but compliance also depends on your device, browser extensions, and policies. Verify the network activity with the built-in privacy receipt.',
      },
      {
        q: 'Can it handle accents and noisy rooms?',
        a: 'Larger models and WebGPU help. For difficult recordings, try Phonon-2 or Fluid Speech Mini rather than a 32 MB model, and keep the microphone or source close.',
      },
      {
        q: 'Does it separate speakers?',
        a: 'No. The transcript has timed segments but no speaker labels in this build. You can edit names into the text.',
      },
    ],
    related: ['meetings', 'podcast-transcription', 'private-transcription'],
    keywords: ['interview transcription', 'private interview transcript', 'local interview to text', 'no upload transcription'],
  },
  {
    slug: 'lecture-transcription',
    nav: 'Lectures',
    eyebrow: 'Use case',
    title: 'Transcribe lectures, talks, and long recordings',
    metaTitle: 'Lecture transcription in your browser — local | LocalScribe',
    metaDescription:
      'Turn a lecture recording into editable notes locally. Long audio, multilingual models, Markdown export, and offline use after the first download.',
    intro: [
      'A lecture is a long recording with one main speaker, occasional questions, and a lot of names. The useful workflow is to get a complete transcript, fix the names, and keep it as notes.',
      'LocalScribe accepts long files, splits them at quiet points, and lets you export Markdown or plain text. For a talk in another language, Qwen3-ASR or Fluid Speech Pro cover a wider set than the English models.',
    ],
    bullets: [
      {
        title: 'Long recordings',
        body: 'Audio is split at the quietest point near the model’s chunk length, so an hour-long talk does not have to fit in one model pass.',
      },
      {
        title: 'Multilingual coverage',
        body: 'Parakeet Redux and Fluid Speech Pro cover 25 European languages; Qwen3-ASR covers 30 languages and 22 Chinese dialects.',
      },
      {
        title: 'Notes-ready exports',
        body: 'Markdown includes the title, model, date, duration, and transcript. JSON keeps the segment timings.',
      },
      {
        title: 'Offline after download',
        body: 'The model and runtime are cached. A lecture can be transcribed on a plane once the first download is done.',
      },
    ],
    modelIds: ['qwen3-asr-0.6b', 'fluid-pro', 'omnilingual-300m'],
    preset: 'multilingual',
    faq: [
      {
        q: 'How long can a lecture be?',
        a: 'There is no fixed minute limit. Very long recordings are constrained by decoding time and memory; chunking keeps the model input bounded.',
      },
      {
        q: 'What about a lecture in a less common language?',
        a: 'Omnilingual ASR covers more than 1,600 languages, though its output has no punctuation and accuracy varies by language.',
      },
      {
        q: 'Can I export the transcript as notes?',
        a: 'Yes. Markdown and TXT are available alongside SRT, VTT, and JSON.',
      },
    ],
    related: ['meetings', 'subtitles', 'audio-to-text'],
    keywords: ['lecture transcription', 'transcribe lecture locally', 'talk to text browser', 'class recording transcription'],
  },
  {
    slug: 'voice-notes',
    nav: 'Voice notes',
    eyebrow: 'Use case',
    title: 'Voice notes to text, without sending them anywhere',
    metaTitle: 'Voice notes to text, local and private | LocalScribe',
    metaDescription:
      'Turn WhatsApp-style voice notes and short clips into text locally. Start with a 32 MB model, record from the microphone, and keep the audio in the tab.',
    intro: [
      'Short voice notes do not need a 1 GB model. Moonshine Tiny is 32 MB, runs on CPU, and is designed for clips measured in seconds rather than hours.',
      'Drop an OGG or M4A voice note, or record directly in the page. The transcription is editable and can be copied or saved before you close the tab.',
    ],
    bullets: [
      {
        title: '32 MB starting point',
        body: 'Moonshine Tiny downloads quickly and works without WebGPU, which makes it the practical choice on a phone or an older laptop.',
      },
      {
        title: 'Voice-note formats',
        body: 'OGG and M4A are accepted, along with WAV, MP3, MP4, and WebM. The audio is resampled to 16 kHz mono.',
      },
      {
        title: 'Record in the page',
        body: 'Use the microphone button for a new note. Stopping starts transcription, and Esc cancels the recording.',
      },
      {
        title: 'Nothing uploaded',
        body: 'The note stays in the tab. Model weights are the only download, and they are cached for the next note.',
      },
    ],
    modelIds: ['moonshine-tiny', 'moonshine-base', 'fluid-mini'],
    preset: 'voice-note',
    faq: [
      {
        q: 'Can I transcribe a WhatsApp voice note?',
        a: 'If you can export or share the OGG file to the browser, yes. Drag it into the page or pick it from the file selector.',
      },
      {
        q: 'Does it work on a phone?',
        a: 'The page is responsive and Moonshine Tiny is small enough for mobile data. Large models are marked as heavy on mobile.',
      },
      {
        q: 'Where does the text go?',
        a: 'Nowhere unless you copy it or enable local history. The app has no backend and no analytics.',
      },
    ],
    related: ['dictation', 'audio-to-text', 'interview-transcription'],
    keywords: ['voice notes to text', 'transcribe voice memo', 'ogg to text', 'whatsapp voice note transcription'],
  },
  {
    slug: 'call-recordings',
    nav: 'Call recordings',
    eyebrow: 'Use case',
    title: 'Transcribe call recordings with phone-audio models',
    metaTitle: 'Call recording transcription in the browser | LocalScribe',
    metaDescription:
      'Transcribe compressed call audio locally with Rumble-2-Flash and automatic language detection across 45 languages. No upload and no per-minute fee.',
    intro: [
      'Call audio is compressed, narrow-band, and often clipped, which is a different problem from a studio recording. Rumble-2-Flash is tuned for real phone-call audio and detects 45 languages automatically.',
      'Drop the recording and the transcript appears with segment timings. Numbers and language are handled by the model; the text remains editable before export.',
    ],
    bullets: [
      {
        title: 'Built for phone audio',
        body: 'Rumble-2-Flash is trained for compressed call recordings, with number formatting and optional verbatim output.',
      },
      {
        title: '45-language detection',
        body: 'Leave the language on auto-detect, or force one for a short or mixed call.',
      },
      {
        title: 'Timed segments',
        body: 'Click a segment to hear the corresponding part of the call before quoting it.',
      },
      {
        title: 'Private by default',
        body: 'The recording is decoded and transcribed in the tab. It is not uploaded to a transcription API.',
      },
    ],
    modelIds: ['rumble-2-flash', 'qwen3-asr-0.6b', 'parakeet-redux'],
    preset: 'meeting',
    faq: [
      {
        q: 'Can it handle 8 kHz call audio?',
        a: 'Yes. The browser resamples the decoded audio to 16 kHz mono for the model. Heavily clipped or noisy calls still benefit from a larger model.',
      },
      {
        q: 'Should I record calls without consent?',
        a: 'Follow the law and the policy that applies to you. LocalScribe only processes a file you provide; it does not record calls by itself.',
      },
      {
        q: 'Does it detect the language?',
        a: 'Rumble and Qwen3-ASR can detect the spoken language. For short calls, forcing the language is often more reliable.',
      },
    ],
    related: ['meetings', 'interview-transcription', 'private-transcription'],
    keywords: ['call recording transcription', 'phone call to text', 'transcribe call audio locally', '45 languages'],
  },
  {
    slug: 'private-transcription',
    nav: 'Privacy',
    eyebrow: 'Trust',
    title: 'Private transcription with a receipt you can inspect',
    metaTitle: 'Private transcription, verified in the browser | LocalScribe',
    metaDescription:
      'A static, no-backend transcript app with a per-run privacy receipt, offline use, and local-only history. Verify network activity instead of trusting a policy.',
    intro: [
      '“Private” usually means a policy. LocalScribe is built so you can check the behaviour: the app is static, model weights are the only third-party download, and the built-in receipt lists every request destination made during a transcription.',
      'The same page can run offline after the first visit. History is off by default, stores text only, and deletes its database when you turn it off.',
    ],
    bullets: [
      {
        title: 'No backend',
        body: 'There is no server that receives audio or text, and no account to create.',
      },
      {
        title: 'Per-run receipt',
        body: 'Settings lists hosts, methods, response sizes, range probes, and failed requests for the last transcription.',
      },
      {
        title: 'Offline capable',
        body: 'The app shell and the runtime are cached by a service worker; model weights stay in Cache Storage.',
      },
      {
        title: 'Local history only',
        body: 'When enabled, transcripts live in IndexedDB in this browser. Audio is never stored.',
      },
    ],
    modelIds: ['fluid-mini', 'moonshine-tiny', 'parakeet-redux'],
    preset: 'dictation',
    faq: [
      {
        q: 'How can I verify that audio is not uploaded?',
        a: 'Open DevTools → Network while a transcription runs, or open Settings → Request receipt and audit the next run. The receipt separates model-host requests from site requests and reports non-GET requests.',
      },
      {
        q: 'Do you use analytics or cookies?',
        a: 'No analytics and no cookies. The static site loads its own assets and model weights from Hugging Face.',
      },
      {
        q: 'Does this make me HIPAA or GDPR compliant?',
        a: 'No tool can promise compliance on its own. Keeping processing local removes a class of data-transfer risk, but device security, consent, retention, and your own policies still apply.',
      },
      {
        q: 'What leaves the device?',
        a: 'The initial page assets and model weights are downloaded. After the first run, cached models can be used offline. Audio and transcript text are never sent.',
      },
    ],
    related: ['interview-transcription', 'meetings', 'audio-to-text'],
    keywords: ['private transcription', 'transcription without upload', 'local speech to text', 'no analytics transcription'],
  },
];

const LANGUAGE_MODELS = ['parakeet-redux', 'qwen3-asr-0.6b', 'fluid-pro'];

function languagePage(options: {
  slug: string;
  language: string;
  appLanguage: string;
  model: string;
  intro: string;
  accents: string;
  faq: SeoFaq[];
  related: string[];
}): SeoPage {
  const model = MODELS[options.model];
  return {
    slug: `languages/${options.slug}`,
    nav: options.language,
    eyebrow: 'Languages',
    title: `Transcribe ${options.language} audio in your browser`,
    metaTitle: `Transcribe ${options.language} audio locally | LocalScribe`,
    metaDescription: `Turn ${options.language} speech into text locally with ${model.name}. No upload, editable transcript, and SRT/VTT export.`,
    intro: [
      options.intro,
      `The recommended starting point is ${model.name} (${model.size}). The app can force the spoken language when auto-detection is unreliable, and it shows the exact download size before anything is fetched.`,
    ],
    bullets: [
      {
        title: `${options.language} support`,
        body: `${model.name} is the suggested model for ${options.language} in this build. ${options.accents}`,
      },
      {
        title: 'Force the language',
        body: 'Auto-detect is convenient, but a short clip often benefits from setting the language explicitly on the model.',
      },
      {
        title: 'Editable and exportable',
        body: 'Fix names and punctuation, then copy the text or export TXT, SRT, VTT, Markdown, or JSON.',
      },
      {
        title: 'Local by construction',
        body: 'The audio is decoded in the tab. Model weights are the only download, and they are cached after the first run.',
      },
    ],
    modelIds: LANGUAGE_MODELS,
    appQuery: `model=${options.model}&lang=${encodeURIComponent(options.appLanguage)}`,
    faq: options.faq,
    related: options.related,
    keywords: [
      `${options.language.toLowerCase()} transcription`,
      `transcribe ${options.language.toLowerCase()} audio`,
      `${options.language.toLowerCase()} speech to text browser`,
      `local ${options.language.toLowerCase()} transcription`,
    ],
  };
}

export const LANGUAGE_PAGES: SeoPage[] = [
  languagePage({
    slug: 'spanish',
    language: 'Spanish',
    appLanguage: 'Spanish',
    model: 'qwen3-asr-0.6b',
    intro:
      'Spanish is one of the 30 languages covered by Qwen3-ASR 0.6B, which accepts a forced language option. Parakeet Redux is the smaller 208 MB option when automatic detection is enough.',
    accents:
      'Castilian, Latin American, and Caribbean accents vary enough that a forced language and a larger model help on noisy recordings. Qwen accepts Spanish explicitly; Parakeet detects it automatically.',
    faq: [
      { q: 'Which Spanish model is smallest?', a: 'Parakeet Redux is 208 MB and covers Spanish alongside 24 other European languages.' },
      { q: 'Does it handle Latin American Spanish?', a: 'Yes, with normal accent variation. Short or noisy clips benefit from forcing Spanish in Qwen3-ASR instead of auto-detecting it.' },
      { q: 'Can I export Spanish subtitles?', a: 'Yes. SRT and VTT keep the original Spanish text and segment timings.' },
    ],
    related: ['languages/french', 'languages/portuguese', 'audio-to-text'],
  }),
  languagePage({
    slug: 'french',
    language: 'French',
    appLanguage: 'French',
    model: 'qwen3-asr-0.6b',
    intro:
      'French is covered by Qwen3-ASR 0.6B, which accepts a forced language, and by Parakeet Redux as the 208 MB auto-detect option. Fluid Speech Pro is another multilingual choice.',
    accents:
      'Parisian, Quebec, and African French differ in vowels and rhythm. Qwen lets you force French for a short or noisy clip; Parakeet detects the language automatically.',
    faq: [
      { q: 'Does it handle Quebec French?', a: 'The model is multilingual and not accent-specific; results vary. A larger model and clear audio improve consistency.' },
      { q: 'Can it transcribe French and English in one file?', a: 'Pick one primary language for the pass. Mixed-language files are better split by language.' },
      { q: 'Are French accents preserved?', a: 'The transcript is plain text in the model’s output vocabulary. Review names and diacritics before publishing.' },
    ],
    related: ['languages/spanish', 'languages/italian', 'audio-to-text'],
  }),
  languagePage({
    slug: 'german',
    language: 'German',
    appLanguage: 'German',
    model: 'qwen3-asr-0.6b',
    intro:
      'German compounds and long words make recovery from a wrong word harder. Qwen3-ASR 0.6B accepts a forced German setting; Parakeet Redux is the 208 MB auto-detect alternative.',
    accents:
      'Austrian, Swiss, and northern German accents differ noticeably. A larger model and an explicit language setting are the practical levers.',
    faq: [
      { q: 'Does it handle compound nouns?', a: 'It transcribes them as text; spelling and splitting follow the model’s vocabulary. Correct unusual compounds in the editable transcript.' },
      { q: 'Can I force German?', a: 'Yes. Choose Qwen3-ASR and set the language selector to German instead of Auto-detect.' },
      { q: 'Is there a German punctuation pass?', a: 'The model emits its own punctuation. The optional clean-up pass is English-oriented.' },
    ],
    related: ['languages/dutch', 'languages/french', 'audio-to-text'],
  }),
  languagePage({
    slug: 'portuguese',
    language: 'Portuguese',
    appLanguage: 'Portuguese',
    model: 'qwen3-asr-0.6b',
    intro:
      'Portuguese is covered by Qwen3-ASR 0.6B, which accepts a forced language; Parakeet Redux is the smaller 208 MB auto-detect option. Brazilian and European varieties differ in pronunciation.',
    accents:
      'Brazilian Portuguese is the more common test case; European Portuguese vowels are tighter. Forcing Portuguese in Qwen helps on short or noisy clips.',
    faq: [
      { q: 'Does it support Brazilian Portuguese?', a: 'Yes. Portuguese is in Qwen3-ASR’s 30-language set and Parakeet’s 25-language set. Accuracy depends on the recording and accent.' },
      { q: 'Can I get Portuguese subtitles?', a: 'Yes. Export SRT or VTT after editing the transcript.' },
      { q: 'Which model for long Portuguese meetings?', a: 'Try Qwen3-ASR for a forced language, or Parakeet Redux if download size matters more. Fluid Speech Pro is another multilingual option.' },
    ],
    related: ['languages/spanish', 'languages/italian', 'meetings'],
  }),
  languagePage({
    slug: 'japanese',
    language: 'Japanese',
    appLanguage: 'Japanese',
    model: 'qwen3-asr-0.6b',
    intro:
      'Japanese is covered by Qwen3-ASR 0.6B. Unlike the European models, Qwen is a larger speech-language model with stronger coverage of Japanese and other Asian languages.',
    accents:
      'Pitch accent and casual speech vary widely. Qwen is a sensible default; Granite Speech 5.0 also lists Japanese if you want punctuation and a larger speech-language model.',
    faq: [
      { q: 'Does it output kanji and kana?', a: 'Qwen3-ASR produces text in its own vocabulary. Review names and rare kanji in the editable transcript.' },
      { q: 'Can it detect Japanese automatically?', a: 'Yes, but short clips are more reliable when the language is forced.' },
      { q: 'Which model is best for Japanese?', a: 'Start with Qwen3-ASR 0.6B. Granite Speech is the alternative when punctuation and translation matter.' },
    ],
    related: ['languages/chinese', 'languages/korean', 'audio-to-text'],
  }),
  languagePage({
    slug: 'chinese',
    language: 'Chinese',
    appLanguage: 'Chinese',
    model: 'qwen3-asr-0.6b',
    intro:
      'Qwen3-ASR 0.6B covers Mandarin plus 22 Chinese dialects. The app maps the language selector to “Chinese”, and the model can also detect the language automatically.',
    accents:
      'Mandarin, Cantonese, and regional dialects are not interchangeable. Qwen’s dialect coverage is the reason to pick it over the European models.',
    faq: [
      { q: 'Does it support Cantonese?', a: 'Cantonese is listed among the Qwen3-ASR languages. Accuracy varies by recording and dialect mix.' },
      { q: 'Can it transcribe songs?', a: 'Qwen3-ASR is the model in this shelf that mentions singing voice and songs with background music.' },
      { q: 'Which language option should I choose?', a: 'Choose Chinese for Mandarin, or leave Auto-detect on for mixed audio.' },
    ],
    related: ['languages/japanese', 'languages/korean', 'audio-to-text'],
  }),
  languagePage({
    slug: 'hindi',
    language: 'Hindi',
    appLanguage: 'Hindi',
    model: 'qwen3-asr-0.6b',
    intro:
      'Hindi is supported by Qwen3-ASR 0.6B. The model handles language identification and transcription, and the app lets you force Hindi for short clips.',
    accents:
      'Hindi–English code-switching is common in real recordings. Expect the transcript to mix scripts and Latin words; edit names and technical terms by hand.',
    faq: [
      { q: 'Does it handle Hinglish?', a: 'Mixed Hindi–English speech is difficult for any model. Forcing Hindi is a starting point, but expect to edit the output.' },
      { q: 'Is the output in Devanagari?', a: 'The model produces its own script for the language. Review the transcript before publishing.' },
      { q: 'Can I export Hindi subtitles?', a: 'Yes. SRT/VTT preserve the text and timings.' },
    ],
    related: ['languages/arabic', 'languages/chinese', 'audio-to-text'],
  }),
  languagePage({
    slug: 'arabic',
    language: 'Arabic',
    appLanguage: 'Arabic',
    model: 'qwen3-asr-0.6b',
    intro:
      'Arabic is covered by Qwen3-ASR 0.6B and Rumble-2-Flash. Dialect differences are significant, so forcing the language and using a larger model is often worth it.',
    accents:
      'Modern Standard Arabic and regional dialects differ substantially. Rumble is tuned for phone audio; Qwen is the larger general option.',
    faq: [
      { q: 'Which Arabic dialect is supported?', a: 'The model is not dialect-specific. MSA is the most predictable; dialectal speech varies.' },
      { q: 'Can it transcribe Arabic call recordings?', a: 'Try Rumble-2-Flash for compressed phone audio, then Qwen3-ASR if accuracy is insufficient.' },
      { q: 'Does it keep right-to-left text?', a: 'The transcript is plain Unicode text, so RTL rendering depends on your editor. The built-in textarea displays it normally.' },
    ],
    related: ['languages/hindi', 'call-recordings', 'audio-to-text'],
  }),
];

export const ALL_PAGES: SeoPage[] = [...USE_CASES, ...LANGUAGE_PAGES];

export function pageById(slug: string): SeoPage | undefined {
  return ALL_PAGES.find((page) => page.slug === slug);
}
