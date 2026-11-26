/** File checksums (MD5, SHA, CRC32, Adler32) off the main thread. */
import { checksumsFor, type FileChecksums } from './file-metadata';

const scope = self as unknown as {
  postMessage: (message: { id: number; checksums?: FileChecksums | null; error?: string }) => void;
  onmessage: ((event: MessageEvent<{ id: number; file: Blob }>) => void) | null;
};

scope.onmessage = async (event) => {
  const { id, file } = event.data;
  try {
    scope.postMessage({ id, checksums: await checksumsFor(file) });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
