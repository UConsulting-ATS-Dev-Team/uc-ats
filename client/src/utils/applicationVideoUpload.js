import apiClient from './api';

// Uploading a video for an application an admin is adding by hand.
//
// The video does not go through /api: that reaches the server through Vercel's
// proxy, which is no place for a file this size. The server hands back a signed
// upload URL instead and the browser sends the file straight to storage. What
// comes back is a document id for POST /applications/manual to name.

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'];
export const VIDEO_ACCEPT = VIDEO_EXTENSIONS.map((ext) => `.${ext}`).join(',');
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

/** Why this file cannot be uploaded, or null when it can. */
export function videoProblem(file) {
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    return `The video must be one of: ${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(', ')}`;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return `The video must be smaller than ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))}MB`;
  }
  return null;
}

// XMLHttpRequest rather than fetch, which cannot report upload progress.
function sendToStorage(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let reason = xhr.statusText;
      try { reason = JSON.parse(xhr.responseText).message || reason; } catch { /* not JSON */ }
      reject(new Error(`The video upload failed (${xhr.status}${reason ? `: ${reason}` : ''})`));
    };
    xhr.onerror = () => reject(new Error('The video upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

/**
 * Upload `file` and resolve with its document id. `onProgress` is called with
 * a fraction from 0 to 1.
 */
export async function uploadApplicationVideo(file, onProgress) {
  const { documentId, uploadUrl, contentType } = await apiClient.post('/application-documents/video-uploads', {
    fileName: file.name,
    sizeBytes: file.size,
  });
  await sendToStorage(uploadUrl, file, contentType, onProgress);
  return documentId;
}
