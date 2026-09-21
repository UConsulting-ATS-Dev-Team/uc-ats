// uploadFile against a stubbed Drive client. The live path needs the service
// account and a folder shared with the address in google-cloud-key.json, so it
// is not exercised here (AGENTS.md, "What cannot be tested locally").
//
// The cases that matter are the ones that fail silently or misleadingly in
// production: an upload with no parent lands in the service account's own My
// Drive where nobody can find it, and Drive's own 403/404 read as network
// trouble unless they are translated.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { filesCreate } = vi.hoisted(() => ({ filesCreate: vi.fn() }));

vi.mock('googleapis', () => ({
  google: { drive: () => ({ files: { create: filesCreate } }) },
}));

vi.mock('./auth.js', () => ({
  getGoogleAuthClient: vi.fn(async () => ({ stub: 'auth' })),
}));

const { uploadFile } = await import('./drive.js');

// drive.js logs the full error before translating it; that is wanted in
// production and noise here.
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
afterAll(() => consoleError.mockRestore());

const driveError = (status, message = 'boom') => {
  const error = new Error(message);
  error.code = status;
  error.response = { status, data: { error: { message } } };
  return error;
};

describe('uploadFile', () => {
  beforeEach(() => {
    filesCreate.mockReset();
    consoleError.mockClear();
  });

  it('refuses to upload without a folder, which would hide the file in the service account My Drive', async () => {
    await expect(uploadFile({ name: 'list.csv', body: 'a,b\r\n' }))
      .rejects.toThrow('uploadFile requires a folderId');
    expect(filesCreate).not.toHaveBeenCalled();
  });

  it('refuses to upload without a name', async () => {
    await expect(uploadFile({ folderId: 'folder-1', body: 'a,b\r\n' }))
      .rejects.toThrow('uploadFile requires a file name');
    expect(filesCreate).not.toHaveBeenCalled();
  });

  it('sends the file into the requested folder with shared-drive support on', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-1', name: 'list.csv' } });

    await uploadFile({ name: 'list.csv', folderId: 'folder-1', body: 'a,b\r\n' });

    expect(filesCreate).toHaveBeenCalledTimes(1);
    const payload = filesCreate.mock.calls[0][0];
    expect(payload.requestBody.parents).toEqual(['folder-1']);
    expect(payload.requestBody.name).toBe('list.csv');
    expect(payload.media).toEqual({ mimeType: 'text/csv', body: 'a,b\r\n' });
    // Without this the call fails outright on a shared drive, which is where a
    // team's marketing folder actually lives.
    expect(payload.supportsAllDrives).toBe(true);
    expect(payload.fields).toContain('webViewLink');
  });

  it('defaults to text/csv but honours an explicit type', async () => {
    filesCreate.mockResolvedValue({ data: { id: 'file-1' } });

    await uploadFile({ name: 'notes.txt', folderId: 'f', body: 'x', mimeType: 'text/plain' });

    const payload = filesCreate.mock.calls[0][0];
    expect(payload.requestBody.mimeType).toBe('text/plain');
    expect(payload.media.mimeType).toBe('text/plain');
  });

  it('returns what Drive created, so the caller can print the link', async () => {
    filesCreate.mockResolvedValue({
      data: { id: 'file-1', name: 'list.csv', webViewLink: 'https://drive.example/file-1' },
    });

    const result = await uploadFile({ name: 'list.csv', folderId: 'folder-1', body: 'x' });

    expect(result).toEqual({
      id: 'file-1',
      name: 'list.csv',
      webViewLink: 'https://drive.example/file-1',
    });
  });

  it('translates a 404 into a missing folder rather than a bare API error', async () => {
    filesCreate.mockRejectedValue(driveError(404, 'File not found'));

    await expect(uploadFile({ name: 'list.csv', folderId: 'nope', body: 'x' }))
      .rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND', statusCode: 404 });
  });

  it('translates a 403 and names the fix, since read access is not enough to write', async () => {
    filesCreate.mockRejectedValue(driveError(403, 'Permission denied'));

    await expect(uploadFile({ name: 'list.csv', folderId: 'folder-1', body: 'x' }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', statusCode: 403 });

    await expect(uploadFile({ name: 'list.csv', folderId: 'folder-1', body: 'x' }))
      .rejects.toThrow(/Editor/);
  });

  it('rethrows anything it does not recognise instead of mislabelling it', async () => {
    const network = new Error('socket hang up');
    filesCreate.mockRejectedValue(network);

    await expect(uploadFile({ name: 'list.csv', folderId: 'folder-1', body: 'x' }))
      .rejects.toBe(network);
  });
});
