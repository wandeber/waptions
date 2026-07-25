import process from 'node:process';

const FIXED_MODEL = 'qwen-1.7b-edit-max';
const mappings = [
  ['WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_REPO', 'WAPTIONS_E2E_DIARIZATION_REFERENCE_REPO'],
  ['WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_TEMPLATE', 'WAPTIONS_E2E_DIARIZATION_REFERENCE_TEMPLATE'],
  ['WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_PYTHON', 'WAPTIONS_E2E_DIARIZATION_REFERENCE_PYTHON'],
  ['WAPTIONS_E2E_TEXT_EDITOR_MEDIA', 'WAPTIONS_E2E_DIARIZATION_MEDIA'],
];
const requiredCallerInputs = [
  'WAPTIONS_E2E_TEXT_EDITOR_REFERENCE_REPO',
  'WAPTIONS_E2E_TEXT_EDITOR_MEDIA',
];

const forbiddenCallerInputs = [
  'WAPTIONS_E2E_TEXT_EDITOR_MODEL',
  'WAPTIONS_E2E_TEXT_EDITOR_ENDPOINT',
  'WAPTIONS_E2E_TEXT_EDITOR_API_KEY',
].filter((name) => Object.prototype.hasOwnProperty.call(process.env, name));
if (forbiddenCallerInputs.length > 0) {
  failCallerConfiguration(
    `Remove unsupported caller variable(s): ${forbiddenCallerInputs.join(', ')}. `
    + 'The runner fixes the model and owns its endpoint and ephemeral credential.',
  );
}
const missingCallerInputs = requiredCallerInputs.filter((name) => !process.env[name]);
if (missingCallerInputs.length > 0) {
  failCallerConfiguration(`Missing required live E2E variable(s): ${missingCallerInputs.join(', ')}.`);
}

// The hardened live-runner implementation is shared with the existing diarization gate so both
// scenarios receive identical ephemeral-secret, redaction, nested-artifact, and signal-cleanup
// guarantees. Only non-secret caller configuration is translated before the shared module loads.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('WAPTIONS_E2E_DIARIZATION_')) delete process.env[name];
}
for (const [source, target] of mappings) {
  if (process.env[source]) process.env[target] = process.env[source];
}
process.env.WAPTIONS_E2E_DIARIZATION_MODEL = FIXED_MODEL;
process.env.WAPTIONS_E2E_SECURE_PROFILE = 'text-editor';

await import('./run-diarization-live.mjs');

function failCallerConfiguration(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
