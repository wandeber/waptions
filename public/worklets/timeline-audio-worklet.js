/*
 * Version 2 of Waptions' deployment-safe timeline audio processor.
 *
 * Compressed media is decoded and mixed into absolute stereo 48 kHz blocks on the main thread.
 * This processor owns only a small bounded queue, so the render callback never performs file,
 * network, decoder, or graph work. Device hardware is allowed to use any sample rate: a
 * fractional canonical cursor advances by playbackRate * 48000 / deviceSampleRate.
 */
const PROTOCOL_VERSION = 2;
const PROJECT_SAMPLE_RATE = 48000;
const LOW_WATER_SAMPLES = 12000;
const MAX_QUEUED_BLOCKS = 32;

class TimelineAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.generation = 0;
    this.cursor = 0;
    this.playing = false;
    this.playbackRate = 1;
    this.blocks = [];
    this.clockCountdown = 0;
    this.lastMissingKey = null;
    this.lowWaterReported = false;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    if (!message || message.version !== PROTOCOL_VERSION || !Number.isSafeInteger(message.generation)) return;
    if (message.type === 'reset') {
      // A late reset from an obsolete async decode must never rewind a newer edit generation.
      if (message.generation < this.generation || !Number.isSafeInteger(message.outputSample)) return;
      this.generation = message.generation;
      this.cursor = Math.max(0, message.outputSample);
      this.playing = false;
      this.blocks = [];
      this.lastMissingKey = null;
      this.lowWaterReported = false;
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
      // Main-thread scheduling already uses a high-water mark. This final bound protects the
      // render realm from a buggy or delayed producer without retaining unbounded transferred data.
      while (this.blocks.length > MAX_QUEUED_BLOCKS) this.blocks.pop();
      this.lastMissingKey = null;
      this.lowWaterReported = false;
    } else if (message.type === 'play') {
      this.playing = true;
    } else if (message.type === 'pause') {
      this.playing = false;
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

    if (this.playing) {
      const increment = this.playbackRate * PROJECT_SAMPLE_RATE / sampleRate;
      for (let frame = 0; frame < leftOutput.length; frame += 1) {
        const sampleIndex = Math.floor(this.cursor);
        const fraction = this.cursor - sampleIndex;
        const first = this.readSample(sampleIndex);
        if (!first) {
          // Silence is already in the output. Crucially, the project cursor does not advance:
          // the exact missing sample is retried after a transferred block arrives.
          this.reportUnderrun(sampleIndex, Math.ceil(this.cursor + increment) + 1);
          continue;
        }
        const second = this.readSample(sampleIndex + 1) || first;
        leftOutput[frame] = first[0] * (1 - fraction) + second[0] * fraction;
        rightOutput[frame] = first[1] * (1 - fraction) + second[1] * fraction;
        this.cursor += increment;
        this.lastMissingKey = null;
      }
      this.pruneConsumedBlocks();
      this.reportLowWater();
    }

    this.clockCountdown -= leftOutput.length;
    if (this.clockCountdown <= 0) {
      this.clockCountdown = Math.max(1, Math.round(sampleRate / 10));
      this.port.postMessage({
        version: PROTOCOL_VERSION,
        type: 'clock',
        generation: this.generation,
        outputSample: Math.floor(this.cursor),
        timeSeconds: this.cursor / PROJECT_SAMPLE_RATE,
        playing: this.playing,
        playbackRate: this.playbackRate,
      });
    }
    return true;
  }

  readSample(sampleIndex) {
    for (const block of this.blocks) {
      const offset = sampleIndex - block.startSample;
      if (offset >= 0 && offset < block.left.length) return [block.left[offset], block.right[offset]];
    }
    return null;
  }

  pruneConsumedBlocks() {
    const sampleIndex = Math.floor(this.cursor);
    this.blocks = this.blocks.filter((block) => block.startSample + block.left.length > sampleIndex);
  }

  queuedUntilSample() {
    let cursor = Math.floor(this.cursor);
    for (const block of this.blocks) {
      const end = block.startSample + block.left.length;
      if (end <= cursor) continue;
      if (block.startSample > cursor) break;
      cursor = Math.max(cursor, end);
    }
    return cursor;
  }

  reportUnderrun(startSample, endSample) {
    const missingKey = `${startSample}:${endSample}`;
    if (missingKey === this.lastMissingKey) return;
    this.lastMissingKey = missingKey;
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
    if (queuedUntilSample - outputSample >= LOW_WATER_SAMPLES || this.lowWaterReported) return;
    this.lowWaterReported = true;
    this.port.postMessage({
      version: PROTOCOL_VERSION,
      type: 'low-water',
      generation: this.generation,
      outputSample,
      queuedUntilSample,
    });
  }
}

registerProcessor('timeline-audio-processor', TimelineAudioProcessor);
