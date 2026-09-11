import { useCallback, useEffect, useState } from 'react';
import apiClient from '../utils/api';

// Round-one questions asked of one specific candidate, keyed by application id.
// basePath is '/admin' or '/member'. add/update/remove throw on failure so the
// caller can keep the user's draft and show the error next to it.
export default function useCandidateQuestions(interviewId, applicationIds, basePath) {
  const [byApplication, setByApplication] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const idsKey = (applicationIds || []).filter(Boolean).join(',');
  const root = `${basePath}/interviews/${interviewId}/candidate-questions`;

  const reload = useCallback(async () => {
    if (!interviewId || !idsKey) {
      setByApplication({});
      setLoaded(true);
      return;
    }
    // A new candidate set is unknown until this read lands, so callers that gate
    // on `loaded` don't act on the empty map left from before.
    setLoaded(false);
    try {
      const data = await apiClient.get(`${root}?applicationIds=${idsKey}`);
      setByApplication(data && typeof data === 'object' ? data : {});
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load candidate questions.');
    } finally {
      setLoaded(true);
    }
  }, [interviewId, idsKey, root]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = useCallback(
    async (applicationId, questionText) => {
      const created = await apiClient.post(root, { applicationId, questionText });
      setByApplication((prev) => ({
        ...prev,
        [applicationId]: [...(prev[applicationId] || []), created],
      }));
      return created;
    },
    [root]
  );

  const update = useCallback(
    async (question, questionText) => {
      const updated = await apiClient.patch(`${root}/${question.id}`, { questionText });
      setByApplication((prev) => ({
        ...prev,
        [question.applicationId]: (prev[question.applicationId] || []).map((q) =>
          q.id === updated.id ? updated : q
        ),
      }));
      return updated;
    },
    [root]
  );

  const remove = useCallback(
    async (question) => {
      await apiClient.delete(`${root}/${question.id}`);
      setByApplication((prev) => ({
        ...prev,
        [question.applicationId]: (prev[question.applicationId] || []).filter((q) => q.id !== question.id),
      }));
    },
    [root]
  );

  return { byApplication, loaded, error, add, update, remove, reload };
}
