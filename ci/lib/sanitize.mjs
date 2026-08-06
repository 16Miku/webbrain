function httpRequestEvidence(args = {}) {
  let url;
  try {
    url = new URL(String(args.url_origin || args.url || ''));
  } catch {
    return {};
  }
  if (!['http:', 'https:'].includes(url.protocol)) return {};
  const rawPathRoot = String(args.url_path_root || '');
  let firstSegment = '';
  if (String(args.url || '').length) {
    try {
      firstSegment = new URL(String(args.url)).pathname.split('/').filter(Boolean)[0] || '';
    } catch {}
  }
  const urlPathRoot = /^\/[A-Za-z0-9._~-]{1,64}$/.test(rawPathRoot)
    ? rawPathRoot
    : rawPathRoot === '/'
      ? '/'
      : firstSegment
        ? `/${firstSegment}`
        : '/';
  const method = String(args.method || '').toUpperCase();
  return {
    url_origin: url.origin,
    url_path_root: urlPathRoot,
    ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? { method } : {}),
  };
}

function httpOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}/` : '';
  } catch {
    return '';
  }
}

export function sanitizeTrace(trace) {
  if (!trace?.run) return null;
  return {
    format: trace.format,
    version: trace.version,
    run: {
      run_id: trace.run.run_id,
      status: trace.run.status,
      mode: trace.run.mode || 'act',
      final_url: httpOrigin(trace.run.final_url),
      updates: (trace.run.updates || [])
        .filter((update) => update.type === 'tool_call' || update.type === 'tool_result')
        .map((update) => {
          const name = update.data?.name || update.data?.tool || '';
          if (update.type === 'tool_result') {
            const result = update.data?.result && typeof update.data.result === 'object'
              ? update.data.result
              : {};
            const status = Number(result.status);
            return {
              type: 'tool_result',
              data: {
                name,
                result: {
                  success: result.success === true,
                  ...(name === 'fetch_url' && Number.isInteger(status) ? { status } : {}),
                },
              },
            };
          }
          const args = update.data?.args || update.data?.arguments || {};
          return {
            type: 'tool_call',
            data: {
              name,
              ...(name === 'load_skill'
                ? { args: { skill_id: args.skill_id || '' } }
                : name === 'fetch_url'
                  ? { args: httpRequestEvidence(args) }
                  : {}),
            },
          };
        }),
    },
  };
}

export function sanitizeRun(run) {
  if (!run) return null;
  return {
    run_id: run.run_id || run.runId || null,
    status: run.status,
    mode: run.mode || 'act',
    final_url: httpOrigin(run.final_url || run.finalUrl),
    result: run.result ?? null,
    error: run.error ? 'Sensitive run reported an error.' : '',
  };
}

export function sanitizeGnippetsState(state) {
  if (!state) return null;
  return {
    scenario: state.scenario,
    signup: { stage: state.signup?.stage || 'unknown' },
    captcha_solved: state.captcha_solved === true,
    events: (state.events || []).map(({ type, detail, at }) => ({ type, detail, at })),
    created_at: state.created_at,
    expires_at: state.expires_at,
  };
}
