/**
 * Extracts the Google Form ID from a Google Form URL
 * @param {string} formUrl - The Google Form URL
 * @returns {string|null} - The extracted form ID or null if invalid
 */
function extractFormIdFromUrl(formUrl) {
    if (!formUrl || typeof formUrl !== 'string') {
        return null;
    }

    // Match Google Form URLs of different formats:
    // https://docs.google.com/forms/d/FORM_ID/viewform
    // https://docs.google.com/forms/d/FORM_ID/edit
    // https://docs.google.com/forms/d/FORM_ID/
    const regex = /\/forms\/d\/([a-zA-Z0-9-_]+)/;
    const match = formUrl.match(regex);
    
    return match ? match[1] : null;
}

/**
 * The form id the application sync can read responses from, or null.
 *
 * Only a `docs.google.com/forms/d/<id>` link carries the id the Forms API
 * wants. A `forms.gle` shortlink carries none, and a published link
 * (`/forms/d/e/<publishedId>/...`) carries a different id the API rejects, so
 * a cycle saved with either never syncs a single application. The host is
 * checked too: matching the path alone would accept
 * `https://example.com/forms/d/abc/edit` as a Google Form.
 * @param {string} formUrl - The Google Form URL stored on the cycle
 * @returns {string|null} - The form id, or null when sync could not use this link
 */
function syncableFormId(formUrl) {
    if (!formUrl || typeof formUrl !== 'string') {
        return null;
    }

    let url;
    try {
        url = new URL(formUrl.trim());
    } catch {
        return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname !== 'docs.google.com') {
        return null;
    }

    const match = url.pathname.match(/^\/forms\/d\/([a-zA-Z0-9-_]+)/);
    if (!match || match[1] === 'e') {
        return null;
    }
    return match[1];
}

/**
 * The link an applicant opens to fill in a cycle's form.
 *
 * Admins paste the editor link (`/forms/d/<id>/edit`), which an applicant
 * cannot open. The same id works under `/viewform`, so that is what
 * applicants get.
 *
 * Null for any link the sync cannot read. Sending someone to a form whose
 * responses never reach the ATS is worse than showing no button: they would
 * apply and never appear.
 * @param {string} formUrl - The Google Form URL stored on the cycle
 * @returns {string|null} - The responder link, or null
 */
function applicantFormLink(formUrl) {
    const formId = syncableFormId(formUrl);
    return formId ? `https://docs.google.com/forms/d/${formId}/viewform` : null;
}

/**
 * Every form id a cycle's applications arrive through: the current form
 * first, then its earlier versions, without repeats. Links sync cannot read
 * are left out.
 * @param {{ formUrl?: string|null, previousFormUrls?: string[]|null }} cycle
 * @returns {string[]}
 */
function cycleFormIds(cycle) {
    const urls = [cycle?.formUrl, ...(cycle?.previousFormUrls || [])];
    return [...new Set(urls.map(syncableFormId).filter(Boolean))];
}

export {
    extractFormIdFromUrl,
    syncableFormId,
    applicantFormLink,
    cycleFormIds
}; 