/** 16-bit little-endian mono PCM helpers for the voice runtime. */

export const pcmDurationMs = (bytes: number, sampleRate: number) => (bytes / 2 / sampleRate) * 1000;

/** Linear-interpolation resampler; good enough for speech at telephony rates. */
export const resamplePcm16 = (input: Buffer, fromRate: number, toRate: number): Buffer => {
  if (fromRate === toRate || input.length < 2) return input;
  const inSamples = Math.floor(input.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const output = Buffer.alloc(outSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input.readInt16LE(Math.min(index, inSamples - 1) * 2);
    const b = input.readInt16LE(Math.min(index + 1, inSamples - 1) * 2);
    output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return output;
};

export const wavFromPcm16 = (pcm: Buffer, sampleRate: number): Buffer => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

const ipv4ToInt = (ip: string) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

/** Exact match, or IPv4 CIDR match (e.g. 10.0.0.0/24). An empty list allows everyone. */
export const ipAllowed = (ip: string, allowed: string[]) => {
  if (!allowed.length) return true;
  const address = ip.replace(/^::ffff:/, "");
  return allowed.some((rule) => {
    const [base, bits] = rule.split("/");
    if (!bits) return base === address;
    if (!base?.includes(".") || !address.includes(".")) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (ipv4ToInt(base) & mask) === (ipv4ToInt(address) & mask);
  });
};
