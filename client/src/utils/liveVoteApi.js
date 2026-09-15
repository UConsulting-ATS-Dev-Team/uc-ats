import apiClient from './api';

// Live vote endpoints (server/src/routes/liveVotes.js). Errors carry `status`
// and `code`; a refused launch also has `body.rejected` (the candidates that
// cannot be voted on) or `body.sessionId` (the session already running).

const base = '/live-votes';

const liveVoteApi = {
  active: (options) => apiClient.get(`${base}/active`, options),
  rubrics: () => apiClient.get(`${base}/rubrics`),
  saveRubric: (phase, criteria) => apiClient.put(`${base}/rubrics/${phase}`, { criteria }),
  launch: (body) => apiClient.post(base, body),

  join: (id) => apiClient.post(`${base}/${id}/join`, {}),
  state: (id, options) => apiClient.get(`${base}/${id}/state`, options),
  vote: (id, ballotId, value) => apiClient.post(`${base}/${id}/votes`, { ballotId, value }),

  begin: (id) => apiClient.post(`${base}/${id}/begin`, {}),
  close: (id, ballotId) => apiClient.post(`${base}/${id}/close`, { ballotId }),
  reopen: (id, sessionCandidateId) => apiClient.post(`${base}/${id}/reopen`, { sessionCandidateId }),
  navigate: (id, fromIndex, toIndex) => apiClient.post(`${base}/${id}/navigate`, { fromIndex, toIndex }),
  decide: (id, sessionCandidateId, decision) =>
    apiClient.post(`${base}/${id}/decision`, { sessionCandidateId, decision }),
  end: (id) => apiClient.post(`${base}/${id}/end`, {}),

  // Sent as the page is torn down, so it has to survive navigation: keepalive
  // lets the browser finish it after the document is gone.
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

export default liveVoteApi;
