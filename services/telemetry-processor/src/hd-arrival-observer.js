/** Optional HD post-fanout signal publisher; business jobs remain authoritative. */
import { createAnalysisArrivalSignal } from '../../../shared/hd/arrival-signal.js';

export function createHdArrivalObserver({ send, queueUrl, runId = 'production', now = () => Date.now() }) {
  if (typeof send !== 'function' || !queueUrl) throw new Error('HD arrival observer needs send and queueUrl');
  return {
    async publish({ signalId, publishedJobCount }) {
      const signal = createAnalysisArrivalSignal({ runId, signalId, publishedJobCount, atMs: now() });
      await send({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(signal),
        MessageGroupId: runId,
        MessageDeduplicationId: signalId,
      });
      return signal;
    },
  };
}

export async function createHdAwsArrivalObserver({ queueUrl, runId, region }) {
  const sdk = await import('@aws-sdk/client-sqs');
  const client = new sdk.SQSClient({ region });
  return createHdArrivalObserver({
    queueUrl, runId,
    send: (input) => client.send(new sdk.SendMessageCommand(input)),
  });
}
