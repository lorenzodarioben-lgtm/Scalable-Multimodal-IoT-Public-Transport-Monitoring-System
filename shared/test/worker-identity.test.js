import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerIdentity } from '../worker/identity.js';

test('worker identity uses a local fallback outside ECS', async () => {
  const identity = await resolveWorkerIdentity({ env: {}, pid: 4321, fetchImpl: null });
  assert.deepEqual(identity, { taskId: 'local-4321', containerId: null, source: 'local-fallback' });
});

test('worker identity derives a stable ECS task id from task metadata', async () => {
  const identity = await resolveWorkerIdentity({
    env: { ECS_CONTAINER_METADATA_URI_V4: 'http://metadata' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        TaskARN: 'arn:aws:ecs:region:123456789012:task/cluster/task-abc',
        Containers: [{ Name: 'route-impact-worker', DockerId: 'container-123' }],
      }),
    }),
  });
  assert.deepEqual(identity, {
    taskId: 'ecs-task-abc', containerId: 'container-123', source: 'ecs-task-metadata',
  });
});
