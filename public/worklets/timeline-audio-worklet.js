/*
 * Version 3 of Waptions' deployment-safe timeline audio processor.
 *
 * Compressed media is decoded and mixed into absolute stereo 48 kHz blocks on the main thread.
 * This processor owns only a bounded queue. Its render callback performs no file, network,
 * decoder, array-filter, or per-output-sample object/array allocation. Device hardware may use
 * any sample rate: a fractional canonical cursor advances by rate * 48000 / device sample rate.
 */
const PROTOCOL_VERSION = 3;
const PROJECT_SAMPLE_RATE = 48000;
const LOW_WATER_SAMPLES = 12000;
const MAX_QUEUED_BLOCKS = 16;
const CLOCK_EVENTS_PER_SECOND = 60;

class TimelineAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.generation = 0;
    this.cursor = 0;
    this.contentEndSample = 0;
    this.playing = false;
    this.playbackRate = 1;
    this.blocks = [];
    this.clockCountdown = 0;
    this.lastMissingStart = -1;
    this.lastMissingEnd = -1;
    this.lowWaterReported = false;
    this.endedReported = false;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || message.version !== PROTOCOL_VERSION
        || !Number.isSafeInteger(message.generation)) return;
    if (message.type === 'reset') {
      // A late reset from obsolete async decode work must never rewind a newer edit generation.
      if (message.generation < this.generation
          || !Number.isSafeInteger(message.outputSample)
          || !Number.isSafeInteger(message.contentEndSample)
          || message.contentEndSample < 0) return;
      this.generation = message.generation;
      this.contentEndSample = message.contentEndSample;
      this.cursor = Math.min(this.contentEndSample, Math.max(0, message.outputSample));
      this.playing = false;
      this.blocks.length = 0;
      this.lastMissingStart = -1;
      this.lastMissingEnd = -1;
      this.lowWaterReported = false;
      this.endedReported = false;
      return;
    }
    if (message.generation !== this.generation) return;

    if (message.type === 'queue') {
      if (!Number.isSafeInteger(message.startSample)
          || !(message.left instanceof Float32Array)
          || !(message.right instanceof Float32Array)
          || message.left.length !== message.right.length
          || message.left.length === 0) return;
      this.blocks.push({ startSample: message.startSample, left: message.left, right: message.right });
      this.blocks.sort((left, right) => left.startSample - right.startSample);
      // Main-thread scheduling uses a high-water mark. This defensive bound preserves nearest
      // playable coverage if a delayed producer transfers more blocks than the protocol permits.
      while (this.blocks.length > MAX_QUEUED_BLOCKS) this.blocks.pop();
      this.lastMissingStart = -1;
      this.lastMissingEnd = -1;
      this.lowWaterReported = false;
    } else if (message.type === 'play') {
      this.playing = true;
      this.endedReported = false;
    } else if (message.type === 'pause') {
      if (!Number.isSafeInteger(message.requestId)) return;
      this.playing = false;
      this.port.postMessage({
        version: PROTOCOL_VERSION,
        type: 'paused',
        generation: this.generation,
        outputSample: Math.floor(this.cursor),
        requestId: message.requestId,
      });
    } else if (message.type === 'set-content-end'
        && Number.isSafeInteger(message.contentEndSample)
        && message.contentEndSample >= 0) {
      // Content-only edits keep reusable coverage inside the new boundary. A shortened timeline
      // drops or truncates only the now-invalid suffix so a later extension can append it once,
      // while the cursor still publishes the normal terminal event at the shortened end.
      const previousContentEndSample = this.contentEndSample;
      this.contentEndSample = message.contentEndSample;
      if (message.contentEndSample < previousContentEndSample) {
        this.trimBlocksAtContentEnd(message.contentEndSample);
      }
      if (this.cursor > this.contentEndSample) this.cursor = this.contentEndSample;
      if (this.playing && this.cursor >= this.contentEndSample) this.reportEnded();
    } else if (message.type === 'set-rate'
        && Number.isFinite(message.playbackRate)
        && message.playbackRate >= 0.1
        && message.playbackRate <= 2) {
      this.playbackRate = message.playbackRate;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const leftOutput = output[0];
    const rightOutput = output[1] || output[0];
    leftOutput.fill(0);
    rightOutput.fill(0);

    // Returning before clock bookkeeping is deliberate. Paused editors suspend their AudioContext
    // after the acknowledgement above and never receive a background stream of redundant clocks.
    if (!this.playing) return true;

    const increment = this.playbackRate * PROJECT_SAMPLE_RATE / sampleRate;
    for (let frame = 0; frame < leftOutput.length; frame += 1) {
      if (this.cursor >= this.contentEndSample) {
        this.reportEnded();
        break;
      }
      const sampleIndex = Math.floor(this.cursor);
      const fraction = this.cursor - sampleIndex;
      const firstBlock = this.findBlock(sampleIndex);
      if (firstBlock === null) {
        // Silence is already in the output. The cursor remains frozen so the exact missing sample
        // is retried when a transferred block arrives. Reaching content end is handled above and
        // therefore can never be misreported as an underrun.
        this.reportUnderrun(sampleIndex, Math.ceil(this.cursor + increment) + 1);
        continue;
      }
      const firstOffset = sampleIndex - firstBlock.startSample;
      const firstLeft = firstBlock.left[firstOffset];
      const firstRight = firstBlock.right[firstOffset];
      const secondBlock = this.findBlock(sampleIndex + 1);
      let secondLeft = firstLeft;
      let secondRight = firstRight;
      if (secondBlock !== null) {
        const secondOffset = sampleIndex + 1 - secondBlock.startSample;
        secondLeft = secondBlock.left[secondOffset];
        secondRight = secondBlock.right[secondOffset];
      }
      leftOutput[frame] = firstLeft * (1 - fraction) + secondLeft * fraction;
      rightOutput[frame] = firstRight * (1 - fraction) + secondRight * fraction;
      this.cursor = Math.min(this.contentEndSample, this.cursor + increment);
      this.lastMissingStart = -1;
      this.lastMissingEnd = -1;
    }

    if (this.playing && this.cursor >= this.contentEndSample) this.reportEnded();
    if (!this.playing) return true;
    this.pruneConsumedBlocks();
    this.reportLowWater();
    this.clockCountdown -= leftOutput.length;
    if (this.clockCountdown <= 0) {
      // The sample clock drives video preview too. A 60 Hz target keeps frame publication smooth;
      // the playback store still deduplicates updates that quantize to the same project frame.
      this.clockCountdown = Math.max(1, Math.round(sampleRate / CLOCK_EVENTS_PER_SECOND));
      this.port.postMessage({
        version: PROTOCOL_VERSION,
        type: 'clock',
        generation: this.generation,
        outputSample: Math.floor(this.cursor),
        timeSeconds: this.cursor / PROJECT_SAMPLE_RATE,
        playing: true,
        playbackRate: this.playbackRate,
      });
    }
    return true;
  }

  findBlock(sampleIndex) {
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index];
      const offset = sampleIndex - block.startSample;
      if (offset >= 0 && offset < block.left.length) return block;
    }
    return null;
  }

  trimBlocksAtContentEnd(contentEndSample) {
    let retainedCount = 0;
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index];
      if (block.startSample >= contentEndSample) continue;
      const retainedLength = Math.min(
        block.left.length,
        contentEndSample - block.startSample,
      );
      if (retainedLength < block.left.length) {
        // subarray creates a small view only when the editor shrinks its tail; the real-time
        // process loop remains allocation-free and can no longer see samples beyond the boundary.
        block.left = block.left.subarray(0, retainedLength);
        block.right = block.right.subarray(0, retainedLength);
      }
      this.blocks[retainedCount] = block;
      retainedCount += 1;
    }
    this.blocks.length = retainedCount;
  }

  pruneConsumedBlocks() {
    const sampleIndex = Math.floor(this.cursor);
    let consumedCount = 0;
    while (consumedCount < this.blocks.length
        && this.blocks[consumedCount].startSample + this.blocks[consumedCount].left.length
          <= sampleIndex) {
      consumedCount += 1;
    }
    if (consumedCount > 0) this.blocks.splice(0, consumedCount);
  }

  queuedUntilSample() {
    let cursor = Math.floor(this.cursor);
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index];
      const end = block.startSample + block.left.length;
      if (end <= cursor) continue;
      if (block.startSample > cursor) break;
      cursor = Math.max(cursor, end);
    }
    return cursor;
  }

  reportUnderrun(startSample, endSample) {
    if (startSample === this.lastMissingStart && endSample === this.lastMissingEnd) return;
    this.lastMissingStart = startSample;
    this.lastMissingEnd = endSample;
    this.port.postMessage({
      version: PROTOCOL_VERSION,
      type: 'underrun',
      generation: this.generation,
      outputSample: Math.floor(this.cursor),
      missingStartSample: startSample,
      missingEndSample: endSample,
    });
  }

  reportLowWater() {
    const outputSample = Math.floor(this.cursor);
    const queuedUntilSample = this.queuedUntilSample();
    if (outputSample >= this.contentEndSample
        || queuedUntilSample - outputSample >= LOW_WATER_SAMPLES
        || this.lowWaterReported) return;
    this.lowWaterReported = true;
    this.port.postMessage({
      version: PROTOCOL_VERSION,
      type: 'low-water',
      generation: this.generation,
      outputSample,
      queuedUntilSample,
    });
  }

  reportEnded() {
    this.cursor = this.contentEndSample;
    this.playing = false;
    if (this.endedReported) return;
    this.endedReported = true;
    this.port.postMessage({
      version: PROTOCOL_VERSION,
      type: 'ended',
      generation: this.generation,
      outputSample: this.contentEndSample,
      timeSeconds: this.contentEndSample / PROJECT_SAMPLE_RATE,
    });
  }
}

registerProcessor('timeline-audio-processor', TimelineAudioProcessor);
