/**
 * Release pointer for the separately hosted Emergency Box text pack.
 *
 * A descriptor with preview: true may be used for an explicitly labeled
 * non-final corpus test. Replace it only after the complete corpus metadata
 * is authoritative and the final deterministic ZIP has been built. Updating
 * this file is the only code change needed to publish a new corpus: copy the
 * descriptor emitted by build_emergency_pack.py, then run the integrity and
 * package-size tests.
 */

export const EMERGENCY_CORPUS_PROVISIONAL_MEASUREMENTS = Object.freeze({
  measuredAt: '2026-08-17',
  final: false,
  sourceDocumentCount: 570,
  sourceTextBytes: 304_190_304,
  note: 'Additional source documents and authoritative metadata are still pending.',
});

export const EMERGENCY_CORPUS_RELEASE = Object.freeze({
  id: 'emergency-box-text',
  version: '2026.08.17-preview.3',
  url: 'https://github.com/webbrain-one/emergency-box-corpus/releases/download/2026.08.17-preview.3/emergency-box-text.zip',
  archiveSha256: '950e5a3c6b52354c1de371b6463df39d9d239aa059dd5d3eabfa21e89c305e5e',
  downloadBytes: 501_799_481,
  installedTextBytes: 301_370_399,
  installedIndexBytes: 1_149_755_424,
  documentCount: 570,
  passageCount: 251_144,
  passageSchemaVersion: 2,
  contentSha256: '7e47c75a83ee7f78d1f0dec04c71279c425faa973c4fe7baf6bc9908b4ad2f3f',
  preview: true,
});
