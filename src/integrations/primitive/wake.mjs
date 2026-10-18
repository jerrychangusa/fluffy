async function sendWake(api, config, args, requestId, onCreated) {
  const schedule = await api(
    '/wake/schedules',
    'POST',
    {
      from_address: config.approval_address,
      target_address: config.execution_address,
      command: 'resume_request',
      args,
      cron_expr: '0 0 1 1 *',
      timezone: 'UTC',
      note: `One-shot approval ${requestId}; disabled before firing and deleted afterward.`,
    },
    `hosted:wake:create:${requestId}`,
  );

  await onCreated(schedule.id);
  // Disable before manually firing, so a retry cannot leave a recurring job.
  await api(`/wake/schedules/${schedule.id}`, 'PATCH', { enabled: false });

  try {
    return await api(
      `/wake/schedules/${schedule.id}/run`,
      'POST',
      undefined,
      `hosted:wake:run:${requestId}`,
    );
  } finally {
    try {
      await api(`/wake/schedules/${schedule.id}`, 'DELETE');
    } catch {
      console.log(
        JSON.stringify({
          kind: 'disabled_wake_cleanup_pending',
          request_id: requestId,
        }),
      );
    }
  }
}

export function createWakeDispatcher(api, config) {
  return (args, id, onCreated) => sendWake(api, config, args, id, onCreated);
}
