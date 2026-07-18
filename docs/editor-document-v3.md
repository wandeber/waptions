# Editor Document V3

Editor Document V3 is the canonical runtime and persistence contract for Waptions projects. It
stores the complete subtitle, video, and audio edit as one validated graph. Preview, transcription,
project bundles, and export consume derivatives of that graph instead of rebuilding media rules in
each feature.

## Graph model

`EditorDocumentV3` contains:

- A locked `renderProfile` with a rational frame rate, canvas dimensions, and a 48 kHz output audio
  rate.
- Typed video and audio source catalogs. Runtime documents include `File` objects; durable
  manifests store descriptors only.
- One ordered, gapless video clip sequence.
- Zero or more independent audio tracks. Each track can contain non-overlapping imported-audio or
  detached-video-audio clips.
- Subtitle tracks with either `video-ripple` or `absolute` timing behavior.
- A durable document revision, an audible-graph revision, and transcription provenance.
- A discriminated runtime selection. Selection is intentionally omitted from durable manifests.

The editor validates safe and unique IDs, source ownership, crop bounds, non-overlapping audio
clips, render-profile limits, mix ranges, transcription provenance, and runtime file metadata before
accepting a document.

## Linked and detached video audio

A video source reports whether it has a primary audio stream. A clip whose source has audio owns a
`VideoClipAudioSettings` value; a silent source owns `null`.

The initial `linkState` is `linked`. The clip's waveform is drawn inside the video block, and the
mix plan contributes the source audio using the clip's source crop and output placement. Running
**Separate audio** is one atomic history and persistence mutation:

1. The video clip changes to `linkState: "detached"`.
2. The embedded contributor disappears.
3. A new independent track and a seconds-based `video-source-audio` clip are created at the exact
   parent video placement.

Deleting the detached clip does not relink the parent. Repeating the command is therefore a no-op
and cannot duplicate audio.

Imported audio uses an `audio-source` reference and native sample crop boundaries. It is always an
independent clip and can be moved, trimmed, split, deleted, muted, faded, and mixed separately from
video.

## Timing domains

The output frame rate is stored as a reduced rational number. Video placements, audio timeline
starts, detached-audio fades, content boundaries, and interactive edits use integer output-frame
boundaries.

The audio engine uses integer 48 kHz output samples. Frame and native-sample boundaries are mapped
individually with exact integer arithmetic; durations are calculated as `map(end) - map(start)`.
This avoids the one-sample drift that can occur when a cropped duration is converted independently
from its left boundary.

Video crops and detached video audio retain seconds because container timestamps are time based.
Imported audio crops and fades retain native source samples. Subtitle rendering remains
second-based, with the declared track timing domain determining whether video ripple edits transform
those intervals.

Content duration is the maximum end boundary across video, subtitles, and independent audio. The
timeline adds separate view-only tail space, while playback and export stop at the exact content
boundary.

## Preview and export

`buildAudioMixPlan()` is the shared immutable contract for preview and export. It resolves linked
audio, detached and imported clips, output/source intervals, track and clip gain, fades, mute state,
and effective solo filtering.

The browser preview owns one `AudioContext`, one gain node, one `AudioWorkletNode`, and a bounded
decoder/cache pipeline. The context is created or resumed only from an explicit play gesture. When
the graph has audible contributors, worklet sample time is the playback master; otherwise the
visual request-animation-frame clock is the only publisher. No hidden `HTMLAudioElement` participates
in playback.

Export renders bounded audio windows with the same mix plan and DSP. When audio export is enabled,
the container receives an audio track through the complete content boundary, including exact
silence. Subtitle or audio tails render over black video after the gapless video sequence ends.
Visual export requires at least one video clip, although a locked project can continue editing and
playing audio after every video clip is deleted.

## Typed persistence and bundles

Durable manifests use separate descriptor arrays and storage keys:

- `video-source:<id>` for video files.
- `audio-source:<id>` for imported audio files.
- `video-source-audio:<id>` only as a decoded-audio cache identity; it references the audio stream
  inside a video source and is not a second persisted file.

The discriminators prevent a video and an audio source with the same ID from aliasing. V3 saves the
manifest and newly imported files in one IndexedDB transaction. Rapid editor changes are coalesced
by revision while preserving the latest complete document.

`.waptions` bundle format 3 stores the V3 manifest and both typed asset catalogs. Import accepts
bundle versions 1, 2, and 3 and rejects unknown newer versions.

Transcription-modal preferences are intentionally outside this contract. The selected route,
custom endpoint/model/request mode/API key/diarization toggle, and local-browser choices are
browser-global `localStorage` values. They never enter the manifest, project history, IndexedDB
project records or bundle metadata. Storing an API key there is a local convenience, not protected
credential storage: same-origin scripts and browser extensions may read it. Storage failures leave
the mounted editor session usable and produce a generic modal warning rather than serializing or
logging the failed record.

## Diarized speaker-track sets

Whole-project diarization is custom-OpenAI-compatible-only. The ordinary per-source transcription
path is unchanged when it is disabled. A successful diarized result writes one
`TrackTranscriptionProvenanceV3` entry per speaker track and identifies the generated set under the
versioned `waptions.transcription.diarization` extension. Every member shares a random `setId` and
an explicit `targetTrackId`; zero-based `speakerOrdinal` values record first-appearance order, while
the provider's speaker label remains descriptive rather than acting as identity.

The active target track is ordinal zero. Generated siblings are contiguous after it. A rerun uses
the anchored set identity to reuse existing member IDs, creates only missing siblings, and removes
only surplus members of that set. Existing names, styles, visibility, locks and timing domains on
reused tracks survive. Unknown extension keys survive replacement, and an unsupported future
version in the selected diarization namespace blocks replacement instead of being overwritten.

One store command publishes the complete tracks/provenance map, selection repair, revision,
content-boundary invalidation, history entry and persistence enqueue. Undo restores the exact
pre-command speaker-track projection; Redo restores the exact generated projection with the same
IDs. An empty speech response is a no-op. A malformed response or failed/cancelled request never
invokes the command.

Asynchronous application is guarded by the audible graph revision/signature and an exact
projection of the anchored target set: relative member order, track data, recognized set metadata
and complete provenance. Unrelated subtitle edits may advance the global document revision without
discarding a valid result. Audio changes or target-set edits make the result stale and leave the
current document untouched.

## Migration

V2 projects migrate their ordered video sources, clips, subtitles, active track, and transcription
into V3. Existing per-clip audio settings are retained when valid; settings without a `linkState`
become `linked`. The migrated project receives a render profile locked to its inspected source.

Legacy scalar projects first inspect their optional video file, create a V2-compatible intermediate
graph, and then use the same pure V2-to-V3 transform. Legacy video blobs can be resolved from their
old IndexedDB key without copying or deleting multi-gigabyte files. New imported-audio assets have
no untyped fallback: a missing typed key is treated as corruption.

Migration is validated before hydration. A failed migration leaves existing stored records intact.

## Resource ownership

Media inspection disposes every Mediabunny input after metadata promises settle. Waveform and mix
decoders close every owned audio sample. Preview decoding reuses one bounded session per typed
source and generation; graph invalidation aborts pending work, clears its small block cache, and
resets the worklet generation. Editor/project teardown destroys the decoder, disconnects nodes,
closes the audio context, and ignores late callbacks from the old project.

Video frame code follows the same ownership rule: every WebCodecs or Mediabunny sample owned by a
caller must be closed, including error and cancellation paths.
