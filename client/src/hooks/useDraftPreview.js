import { useEffect, useRef, useState } from 'react';
import apiClient from '../utils/api';

/**
 * Renders an email with unsaved changes, on the server, as the admin edits.
 *
 * Debounced so dragging a colour picker is one request when it settles rather
 * than one per pixel, and each request carries a sequence number so a slow
 * response for an older draft cannot overwrite a newer one.
 *
 * `draft` is `{ theme?, style? }`, or null to render nothing.
 */
export default function useDraftPreview(previewKey, draft, { delay = 350 } = {}) {
  const [state, setState] = useState({ loading: Boolean(draft), error: '', data: null });
  const sequence = useRef(0);
  const body = draft ? JSON.stringify(draft) : null;

  useEffect(() => {
    if (!previewKey || !body) return undefined;
    const mine = ++sequence.current;
    setState((current) => ({ ...current, loading: true, error: '' }));

    const timer = setTimeout(() => {
      apiClient
        .post(`/admin/email-templates/${encodeURIComponent(previewKey)}/preview`, JSON.parse(body))
        .then((data) => {
          if (mine === sequence.current) setState({ loading: false, error: '', data });
        })
        .catch((err) => {
          if (mine === sequence.current) {
            setState((current) => ({
              ...current,
              loading: false,
              error: err.serverMessage || 'Could not preview this change',
            }));
          }
        });
    }, delay);

    return () => clearTimeout(timer);
  }, [previewKey, body, delay]);

  return state;
}
