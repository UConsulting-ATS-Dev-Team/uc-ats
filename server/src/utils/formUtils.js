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
 * The link an applicant opens to fill in a cycle's form.
 *
 * Admins paste whatever Google gave them, usually the editor link
 * (`/forms/d/<id>/edit`), which an applicant cannot open. The form id works
 * with `/viewform` too, so that is what applicants get. A published link
 * (`/forms/d/e/<publishedId>/...`) carries a different id that only works
 * under `/d/e/`, so it keeps that shape. A `forms.gle` shortlink already opens
 * the responder view and is passed through.
 *
 * The host is checked before anything is rewritten. Matching the path alone
 * would turn `https://example.com/forms/d/abc/edit` into a Google link to a
 * form nobody configured.
 * @param {string} formUrl - The Google Form URL stored on the cycle
 * @returns {string|null} - The responder link, or null when it is not a Google Form
 */
function applicantFormLink(formUrl) {
    if (!formUrl || typeof formUrl !== 'string') {
        return null;
    }

    let url;
    try {
        url = new URL(formUrl.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }

    if (url.hostname === 'forms.gle') {
        const shortId = url.pathname.match(/^\/([a-zA-Z0-9]+)\/?$/);
        return shortId ? `https://forms.gle/${shortId[1]}` : null;
    }

    if (url.hostname !== 'docs.google.com') {
        return null;
    }

    const published = url.pathname.match(/^\/forms\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (published) {
        return `https://docs.google.com/forms/d/e/${published[1]}/viewform`;
    }

    const formId = url.pathname.match(/^\/forms\/d\/([a-zA-Z0-9-_]+)/);
    return formId ? `https://docs.google.com/forms/d/${formId[1]}/viewform` : null;
}

export {
    extractFormIdFromUrl,
    applicantFormLink
}; 