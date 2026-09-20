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

//Get direct download stream for a Google Drive file
export async function getFileStream(fileId) {
  try {
    const drive = await getDriveClient();
    const res = await drive.files.get({
      fileId: fileId,
      alt: 'media',
      supportsAllDrives: true // Required for shared drives
    }, { responseType: 'stream' });
    
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

// Create a new file in a Drive folder from an in-memory string or a stream.
// `folderId` is required: without a parent, Drive silently files the upload in
// the service account's own My Drive, where nobody on the team can see it.
export async function uploadFile({ name, folderId, body, mimeType = 'text/csv' }) {
  if (!name) throw new Error('uploadFile requires a file name');
  if (!folderId) throw new Error('uploadFile requires a folderId');

  try {
    const drive = await getDriveClient();
    const res = await drive.files.create({
      requestBody: { name, parents: [folderId], mimeType },
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

// Get metadata for a Google Drive file (name, mimeType, size)
export async function getFileMetadata(fileId) {
  try {
    const drive = await getDriveClient();
    const res = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size',
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
