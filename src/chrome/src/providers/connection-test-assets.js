const VISION_CONNECTION_TEST_IMAGE_PATH = 'assets/vision-connection-test.png';
const TRANSCRIPTION_CONNECTION_TEST_AUDIO_PATH = 'assets/transcription-connection-test.wav';

async function readPackagedAsset(runtime, relativePath) {
  const response = await fetch(runtime.getURL(relativePath));
  if (!response.ok) {
    throw new Error(`Could not load packaged connection-test asset ${relativePath} (HTTP ${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function loadVisionConnectionTestImage(runtime) {
  const bytes = await readPackagedAsset(runtime, VISION_CONNECTION_TEST_IMAGE_PATH);
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

export async function loadTranscriptionConnectionTestAudio(runtime) {
  const bytes = await readPackagedAsset(runtime, TRANSCRIPTION_CONNECTION_TEST_AUDIO_PATH);
  return new Blob([bytes], { type: 'audio/wav' });
}
