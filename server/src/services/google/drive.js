import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import { getGoogleAuthClient } from './auth.js';

let driveClient;

async function getDriveClient() {
  if (!driveClient) {
    const authClient = await getGoogleAuthClient();
    driveClient = google.drive({ version: 'v3', auth: authClient });
  }
  return driveClient;
}

// Get direct download stream for a Google Drive file. `range` ({ start, end },
// inclusive) reads only that slice; Drive honours Range on alt=media downloads.
export async function getFileStream(fileId, { range } = {}) {
  try {
    const drive = await getDriveClient();
    const res = await drive.files.get({
      fileId: fileId,
      alt: 'media',
      supportsAllDrives: true // Required for shared drives
    }, {
      responseType: 'stream',
      ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
    });
    
    return res.data;
  } catch (error) {
    // Enhanced error logging
    console.error(`Error getting file stream for ${fileId}:`, {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      errors: error.errors
    });
    
    // Handle specific Google API errors
    if (error.code === 404 || error.response?.status === 404) {
      const notFoundError = new Error(`File not found: ${fileId}. ${error.response?.data?.error?.message || error.message}`);
      notFoundError.code = 'FILE_NOT_FOUND';
      notFoundError.statusCode = 404;
      throw notFoundError;
    }
    
    if (error.code === 403 || error.response?.status === 403) {
      const accessError = new Error(`Access denied to file: ${fileId}. ${error.response?.data?.error?.message || error.message}`);
      accessError.code = 'ACCESS_DENIED';
      accessError.statusCode = 403;
      throw accessError;
    }
    
    throw error;
  }
}

// Write a whole Drive file to `destPath`, streaming, so a large video never sits
// in memory. Resolves with the number of bytes written.
export async function downloadFile(fileId, destPath) {
  const stream = await getFileStream(fileId);
  await pipeline(stream, fs.createWriteStream(destPath));
  return (await fs.promises.stat(destPath)).size;
}

// Create a new file in a Drive folder from an in-memory string or a stream.
// `folderId` is required: without a parent, Drive silently files the upload in
// the service account's own My Drive, where nobody on the team can see it.
// `appProperties` are private key/value tags only this app can read, used to
// find a file again by what it was made from rather than by its name.
export async function uploadFile({ name, folderId, body, mimeType = 'text/csv', appProperties }) {
  if (!name) throw new Error('uploadFile requires a file name');
  if (!folderId) throw new Error('uploadFile requires a folderId');

  try {
    const drive = await getDriveClient();
    const res = await drive.files.create({
      requestBody: { name, parents: [folderId], mimeType, ...(appProperties ? { appProperties } : {}) },
      media: { mimeType, body },
      fields: 'id, name, webViewLink, parents',
      supportsAllDrives: true // Required for shared drives
    });
    return res.data;
  } catch (error) {
    console.error(`Error uploading "${name}" to folder ${folderId}:`, {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      errors: error.errors
    });

    if (error.code === 404 || error.response?.status === 404) {
      const notFoundError = new Error(`Folder not found: ${folderId}. ${error.response?.data?.error?.message || error.message}`);
      notFoundError.code = 'FOLDER_NOT_FOUND';
      notFoundError.statusCode = 404;
      throw notFoundError;
    }

    if (error.code === 403 || error.response?.status === 403) {
      const accessError = new Error(`Access denied writing to folder: ${folderId}. Share it with the service account as an Editor. ${error.response?.data?.error?.message || error.message}`);
      accessError.code = 'ACCESS_DENIED';
      accessError.statusCode = 403;
      throw accessError;
    }

    throw error;
  }
}

// Files in `folderId` tagged with appProperties[key] === value, not trashed.
export async function listFilesByAppProperty({ folderId, key, value, fields = 'id, name, mimeType, size' }) {
  const quote = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const drive = await getDriveClient();
  const res = await drive.files.list({
    q: `'${quote(folderId)}' in parents and trashed = false and appProperties has { key='${quote(key)}' and value='${quote(value)}' }`,
    fields: `files(${fields})`,
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files || [];
}

// Get metadata for a Google Drive file. The default fields are name, mimeType,
// size, and the md5Checksum / modifiedTime that services/documentValidators.js
// turns into an ETag and Last-Modified; pass `fields` for others, e.g. parents.
export async function getFileMetadata(fileId, { fields = 'id, name, mimeType, size, md5Checksum, modifiedTime' } = {}) {
  try {
    const drive = await getDriveClient();
    const res = await drive.files.get({
      fileId,
      fields,
      supportsAllDrives: true // Required for shared drives
    });
    return res.data;
  } catch (error) {
    // Enhanced error logging
    console.error(`Error getting file metadata for ${fileId}:`, {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      errors: error.errors
    });
    
    // Handle specific Google API errors
    if (error.code === 404 || error.response?.status === 404) {
      const notFoundError = new Error(`File not found: ${fileId}. ${error.response?.data?.error?.message || error.message}`);
      notFoundError.code = 'FILE_NOT_FOUND';
      notFoundError.statusCode = 404;
      throw notFoundError;
    }
    
    if (error.code === 403 || error.response?.status === 403) {
      const accessError = new Error(`Access denied to file: ${fileId}. ${error.response?.data?.error?.message || error.message}`);
      accessError.code = 'ACCESS_DENIED';
      accessError.statusCode = 403;
      throw accessError;
    }
    
    throw error;
  }
}
