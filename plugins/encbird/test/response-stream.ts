export function responseStream(chunks: Uint8Array[], options: { readError?: Error; cancelError?: Error } = {}) {
  let reads = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else if (options.readError) controller.error(options.readError);
      else controller.close();
    },
    cancel() { cancellations++; if (options.cancelError) throw options.cancelError; },
  }, { highWaterMark: 0 });
  return { body, reads: () => reads, cancellations: () => cancellations };
}
