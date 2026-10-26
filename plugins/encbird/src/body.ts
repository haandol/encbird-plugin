export const MAX_RESPONSE_BYTES = 1_048_576;
type BodyResult = { kind: 'complete'; text: string } | { kind: 'too-large' };

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null): Promise<BodyResult> {
  const reader = body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { kind: 'too-large' };
      }
      chunks.push(value);
    }
  }
  return { kind: 'complete', text: Buffer.concat(chunks).toString('utf8') };
}
