const MODEL_BASE = 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/';
const MODEL_6S_BASE = 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/49df9b6989cf2150840ea65b0bef77a2e471b678/';

export const MUSIC_MODEL_CACHE = 'localscribe-htdemucs-v1';

/** Stem order in each export's `stems[1, n, 2, 343980]` output. */
export const STEMS_4 = ['Drums', 'Bass', 'Other', 'Vocals'];
export const STEMS_6 = ['Drums', 'Bass', 'Other', 'Vocals', 'Guitar', 'Piano'];

export const MUSIC_MODEL_VARIANTS = {
  fp32: { url: MODEL_BASE + 'htdemucs.onnx', bytes: 316_446_953, stems: STEMS_4, label: '4-stem · full precision' },
  fp16: { url: MODEL_BASE + 'htdemucs_fp16weights.onnx', bytes: 165_612_636, stems: STEMS_4, label: '4-stem · standard' },
  '6s-fp32': { url: MODEL_6S_BASE + 'htdemucs_6s.onnx', bytes: 258_159_781, stems: STEMS_6, label: '6-stem · full precision' },
  '6s-fp16': { url: MODEL_6S_BASE + 'htdemucs_6s_fp16weights.onnx', bytes: 136_428_532, stems: STEMS_6, label: '6-stem · standard' },
};

export type MusicModelVariant = keyof typeof MUSIC_MODEL_VARIANTS;
