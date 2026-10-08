// Keep logical service operations independent of the browser's HTTP transport.
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  sessionStorage.setItem('modelServiceToken', fragment.get('token'));
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('modelServiceToken') || '';

export async function service(operation, payload = {}) {
  if (window.apex?.request) {
    const response = await window.apex.request(operation, payload);
    if (response.error) {
      const error = new Error(response.error.message || '服务请求失败');
      error.code = response.error.code; error.status = response.error.status;
      throw error;
    }
    return response.result;
  }
  if (window.apex?.execute) return window.apex.execute(operation, payload);
  const routes = {
    get_config: ['/api/config', 'GET'],
    browse: ['/api/browse?path=' + encodeURIComponent(payload.path || ''), 'GET'],
    get_media: ['/api/media/' + encodeURIComponent(payload.media_id || ''), 'GET'],
    probe_media: ['/api/probe', 'POST'],
    confirm_audio: ['/api/confirm-audio', 'POST'],
    analyze: ['/api/analyze', 'POST'],
    get_task: ['/api/tasks/' + encodeURIComponent(payload.task_id || ''), 'GET'],
    get_result: ['/api/results/' + encodeURIComponent(payload.result_id || ''), 'GET'],
    read_scores: ['/api/scores/' + encodeURIComponent(payload.prediction_id || '')
      + '?start_s=' + encodeURIComponent(payload.start_s) + '&end_s=' + encodeURIComponent(payload.end_s), 'GET'],
    recompute_candidates: ['/api/recompute-candidates', 'POST'],
    update_selection: ['/api/update-selection', 'POST'],
    request_preview: ['/api/preview', 'POST'],
    export: ['/api/export', 'POST'],
    cancel_task: ['/api/cancel', 'POST'],
    get_artifact: ['/api/artifacts/' + encodeURIComponent(payload.artifact_id || ''), 'GET'],
  };
  if (!routes[operation]) throw new Error('不支持的服务操作');
  const [path, method] = routes[operation];
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Apex-Token': token },
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || '服务请求失败');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

export function artifactUrl(artifactId) {
  if (window.apex?.artifactUrl) return window.apex.artifactUrl(artifactId);
  return '/api/artifacts/' + encodeURIComponent(artifactId) + '/content?token=' + encodeURIComponent(token);
}
