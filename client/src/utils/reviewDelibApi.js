import apiClient from './api';

// Review team deliberation endpoints (server/src/routes/reviewDelibs.js).
// Errors carry `status` and `code`; a refused launch also has `body.sessionId`
// (the team's session already running), and a member refused entry has
// `body.groupName` (the team the session is for).

const base = '/review-delibs';

const reviewDelibApi = {
  active: (options) => apiClient.get(`${base}/active`, options),
  groups: (options) => apiClient.get(`${base}/groups`, options),
  launch: (groupId, thresholdPct) => apiClient.post(base, { groupId, thresholdPct }),

  join: (id) => apiClient.post(`${base}/${id}/join`, {}),
  state: (id, options) => apiClient.get(`${base}/${id}/state`, options),
  team: (id, options) => apiClient.get(`${base}/${id}/team`, options),
  candidate: (id, applicationId, options) => apiClient.get(`${base}/${id}/candidates/${applicationId}`, options),
  changes: (id, options) => apiClient.get(`${base}/${id}/changes`, options),

  threshold: (id, thresholdPct) => apiClient.post(`${base}/${id}/threshold`, { thresholdPct }),
  override: (id, type, scoreId, adminScore) => apiClient.post(`${base}/${id}/scores/${type}/${scoreId}`, { adminScore }),
  decide: (id, applicationId, decision) => apiClient.post(`${base}/${id}/decision`, { applicationId, decision }),
  end: (id) => apiClient.post(`${base}/${id}/end`, {}),

  // Sent as the page is torn down, so it has to survive navigation.
  leave: (id) => {
    try {
      return fetch(`/api${base}/${id}/leave`, {
        method: 'POST',
        keepalive: true,
        headers: apiClient.token ? { Authorization: `Bearer ${apiClient.token}` } : {}
      }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
};

export default reviewDelibApi;
