/**
 * Resolve an ECS task identity without making local execution AWS-dependent.
 * ECS exposes this locally through the task metadata endpoint; a local process
 * gets a stable-for-process fallback instead.
 */
export async function resolveWorkerIdentity({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pid = process.pid,
} = {}) {
  const explicit = env.WORKER_TASK_ID || env.ECS_TASK_ID;
  if (explicit) return { taskId: explicit, containerId: null, source: 'environment' };

  const endpoint = env.ECS_CONTAINER_METADATA_URI_V4 || env.ECS_CONTAINER_METADATA_URI;
  if (!endpoint || typeof fetchImpl !== 'function') {
    return { taskId: `local-${pid}`, containerId: null, source: 'local-fallback' };
  }

  try {
    const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/task`);
    if (!response.ok) throw new Error(`metadata status ${response.status}`);
    const metadata = await response.json();
    const taskArn = metadata.TaskARN || metadata.TaskArn;
    const taskSuffix = typeof taskArn === 'string' ? taskArn.split('/').at(-1) : null;
    const container = (metadata.Containers || []).find((item) => item.Name === 'route-impact-worker')
      || metadata.Containers?.[0];
    if (!taskSuffix) throw new Error('metadata response did not contain TaskARN');
    return {
      taskId: `ecs-${taskSuffix}`,
      containerId: container?.DockerId || container?.DockerID || null,
      source: 'ecs-task-metadata',
    };
  } catch {
    // Metadata can briefly be unavailable during task startup. Do not prevent
    // the queue worker from starting; the fallback is still traceable in logs.
    return { taskId: `local-${pid}`, containerId: null, source: 'local-fallback' };
  }
}
