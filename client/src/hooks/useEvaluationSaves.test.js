import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useEvaluationSaves from './useEvaluationSaves';

async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A stand-in server: each send records the notes as they were when it went out and
// waits until the test settles it.
function fakeServer() {
  const sends = [];
  const notes = { current: '' };
  const send = vi.fn((id) => {
    const call = { id, notes: notes.current, ...deferred() };
    sends.push(call);
    return call.promise;
  });
  return { sends, notes, send };
}

describe('useEvaluationSaves', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('autosaves once edits pause, with the notes as they are then', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    server.notes.current = 'Strong';
    act(() => result.current.scheduleAutoSave('a1'));
    await advance(1000);
    server.notes.current = 'Strong framework';
    act(() => result.current.scheduleAutoSave('a1'));
    await advance(1999);
    expect(server.send).not.toHaveBeenCalled();

    await advance(1);
    expect(server.sends.map((s) => s.notes)).toEqual(['Strong framework']);
  });

  // The bug: a slow autosave finishing after the save that followed it put the
  // older notes back.
  it('sends a save only once the one before it has finished, so the latest lands last', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    server.notes.current = 'First draft';
    act(() => result.current.scheduleAutoSave('a1'));
    await advance(2000);
    expect(server.sends).toHaveLength(1);

    server.notes.current = 'Final notes';
    let saved;
    act(() => { saved = result.current.saveNow('a1'); });
    await advance(0);
    expect(server.sends).toHaveLength(1);

    await act(async () => { server.sends[0].resolve(); });
    expect(server.sends.map((s) => s.notes)).toEqual(['First draft', 'Final notes']);
    await act(async () => { server.sends[1].resolve(); await saved; });
  });

  it('has a save asked for while another is waiting share it', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    let first;
    let second;
    let third;
    act(() => { first = result.current.saveNow('a1'); });
    await advance(0);
    expect(server.sends).toHaveLength(1);
    act(() => {
      second = result.current.saveNow('a1');
      third = result.current.saveNow('a1');
    });
    await advance(0);
    expect(second).toBe(third);
    await act(async () => { server.sends[0].resolve(); });
    await act(async () => { server.sends[1].resolve(); await Promise.all([first, second]); });
    expect(server.send).toHaveBeenCalledTimes(2);
  });

  it('keeps different candidates independent', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    act(() => {
      result.current.saveNow('a1');
      result.current.saveNow('a2');
    });
    await advance(0);
    expect(server.sends.map((s) => s.id)).toEqual(['a1', 'a2']);
  });

  it('retries a failed autosave and reports both the failure and the save that recovers', async () => {
    const server = fakeServer();
    const onAutoSaveError = vi.fn();
    const onSaved = vi.fn();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send, onAutoSaveError, onSaved }));

    act(() => result.current.scheduleAutoSave('a1'));
    await advance(2000);
    await act(async () => { server.sends[0].reject(new Error('503')); });
    expect(onAutoSaveError).toHaveBeenCalledWith('a1', expect.any(Error));

    await advance(2000);
    expect(server.sends).toHaveLength(2);
    await act(async () => { server.sends[1].resolve(); });
    expect(onSaved).toHaveBeenCalledWith('a1');
  });

  it('gives up after the last retry', async () => {
    const send = vi.fn(() => Promise.reject(new Error('down')));
    const onAutoSaveError = vi.fn();
    const { result } = renderHook(() => useEvaluationSaves({ send, retryDelaysMs: [100, 200], onAutoSaveError }));

    act(() => result.current.scheduleAutoSave('a1'));
    await advance(2000 + 100 + 200 + 10000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onAutoSaveError).toHaveBeenCalledTimes(3);
  });

  it('lets a new edit replace a pending retry with its own autosave', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send, retryDelaysMs: [5000] }));

    act(() => result.current.scheduleAutoSave('a1'));
    await advance(2000);
    await act(async () => { server.sends[0].reject(new Error('503')); });

    server.notes.current = 'Edited after the failure';
    act(() => result.current.scheduleAutoSave('a1'));
    await advance(2000);
    expect(server.sends.map((s) => s.notes)).toEqual(['', 'Edited after the failure']);
    await act(async () => { server.sends[1].resolve(); });
    await advance(10000);
    expect(server.sends).toHaveLength(2);
  });

  it('rejects a failed Save and puts back the autosave it replaced', async () => {
    const server = fakeServer();
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    act(() => result.current.scheduleAutoSave('a1'));
    let saved;
    act(() => { saved = result.current.saveNow('a1'); });
    await advance(0);
    const outcome = saved.then(() => 'saved', () => 'failed');
    await act(async () => { server.sends[0].reject(new Error('503')); });
    expect(await outcome).toBe('failed');

    await advance(2000);
    expect(server.sends).toHaveLength(2);
  });

  it('reports a Save that lands as saved, so a failure notice can come down', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() => useEvaluationSaves({ send: () => Promise.resolve(), onSaved }));

    await act(async () => { await result.current.saveNow('a1'); });
    expect(onSaved).toHaveBeenCalledWith('a1');
  });

  it('runs a one-off write in its place in the queue', async () => {
    const server = fakeServer();
    const decision = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useEvaluationSaves({ send: server.send }));

    act(() => {
      result.current.saveNow('a1');
      result.current.runInQueue('a1', decision);
    });
    await advance(0);
    expect(decision).not.toHaveBeenCalled();
    await act(async () => { server.sends[0].resolve(); });
    expect(decision).toHaveBeenCalledTimes(1);
  });

  it('sends a waiting autosave when the page is left', async () => {
    const server = fakeServer();
    const { result, unmount } = renderHook(() => useEvaluationSaves({ send: server.send }));

    server.notes.current = 'Typed just before leaving';
    act(() => result.current.scheduleAutoSave('a1'));
    unmount();
    await advance(0);
    expect(server.sends.map((s) => s.notes)).toEqual(['Typed just before leaving']);
    await advance(5000);
    expect(server.sends).toHaveLength(1);
  });
});
