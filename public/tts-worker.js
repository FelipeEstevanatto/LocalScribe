/*
 * tiny-voca phonemizer worker.
 *
 * Pyodide, NumPy, dizione and the tiny-voca data are all served from this
 * origin. The worker only converts text to phoneme ids; the ONNX voice model
 * runs on the main thread with the app's existing ONNX Runtime.
 */

const ROOT = new URL('./', self.location.href);
const PYODIDE = new URL('pyodide/', ROOT).href;
const TINY = new URL('tiny-voca/', ROOT).href;
const DATA = ['lexicon.tsv', 'align.json', 'g2p.json', 'g2p.npz', 'homographs.json'];

importScripts(new URL('pyodide.js', PYODIDE).href);

let pyodide = null;
let phonemize = null;

const post = (message) => self.postMessage(message);

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function load() {
  post({ type: 'status', text: 'Starting the local Python runtime…' });
  pyodide = await loadPyodide({ indexURL: PYODIDE });

  post({ type: 'status', text: 'Loading NumPy…' });
  await pyodide.loadPackage('numpy');

  post({ type: 'status', text: 'Loading the phonemizer…' });
  const [archive, ...files] = await Promise.all([
    fetchBytes(new URL('dizione.zip', TINY).href),
    ...DATA.map((name) => fetchBytes(new URL(`phonemizer/${name}`, TINY).href)),
  ]);

  pyodide.FS.mkdirTree('/dizione-data');
  DATA.forEach((name, index) => {
    pyodide.FS.writeFile(`/dizione-data/${name}`, files[index]);
  });

  pyodide.unpackArchive(archive.buffer, 'zip', { extractDir: '/dizione-src' });

  pyodide.runPython(`
import json, os, sys
os.environ["DIZIONE_DATA"] = "/dizione-data"
sys.path.insert(0, "/dizione-src")
import dizione

def phonemize_json(text):
    try:
        result = dizione.phonemize(text)
    except ValueError:
        if any(word for mark, words in dizione.pieces(text) if not mark for word in words):
            raise
        return "null"
    return json.dumps({"ids": list(result.ids), "stress": list(result.stress), "text": str(result)})

phonemize_json("Warm up.")
`);

  phonemize = pyodide.globals.get('phonemize_json');
  const config = await (await fetch(new URL('config.json', TINY))).json();
  post({
    type: 'ready',
    voices: config.voices,
    sampleRate: config.sample_rate,
  });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load();
      return;
    }

    if (data.type === 'phonemize') {
      if (!phonemize) throw new Error('The phonemizer is not ready.');
      const json = phonemize(String(data.text));
      if (json === 'null') {
        post({ type: 'phonemes', id: data.id, empty: true });
        return;
      }
      const result = JSON.parse(json);
      post({
        type: 'phonemes',
        id: data.id,
        ids: result.ids,
        stress: result.stress,
        text: result.text,
      });
    }
  } catch (error) {
    post({
      type: 'error',
      id: data && data.id,
      message: String((error && error.message) || error),
    });
  }
};
