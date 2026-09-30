const button = document.getElementById('download-gif');
const menu = document.getElementById('download-menu');
const status = document.getElementById('gif-export-status');
const cancel = document.getElementById('cancel-gif-export');
const runId = new URL(location.href).searchParams.get('run');
let pending;

function announce(message) { status.textContent = message; status.hidden = !message; }

button.addEventListener('click', async () => {
  if (pending || !runId) return;
  const controller = new AbortController();
  pending = controller;
  button.disabled = true;
  button.textContent = 'Preparing GIF…';
  cancel.hidden = false;
  menu.open = false;
  announce('Preparing GIF…');
  let timedOut = false;
  // The server has its own shorter deadline, so it can return a useful error first.
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 130_000);
  try {
    const kind = runId.startsWith('archive-') ? 'archives' : 'runs';
    const response = await fetch(`/api/${kind}/${encodeURIComponent(runId)}/render.gif`, {
      signal: controller.signal, cache: 'no-store',
    });
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.error || 'GIF export failed. Try again.');
    }
    if (response.headers.get('Content-Type') !== 'image/gif') throw new Error('GIF export failed. Try again.');
    const blob = await response.blob();
    controller.signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `offcut-${runId.replace(/[^a-zA-Z0-9_-]/g, '')}-playback.gif`;
    document.body.append(link);
    link.click();
    link.remove();
    // Allow the browser to claim the file before releasing the temporary download URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    announce('GIF ready.');
  } catch (error) {
    announce(controller.signal.aborted
      ? timedOut ? 'GIF export took too long. Try again.' : 'GIF export cancelled.'
      : error instanceof TypeError ? 'The local server is unavailable. Try again.' : error.message);
  } finally {
    clearTimeout(timeout);
    pending = null;
    button.disabled = false;
    button.textContent = 'Playback GIF';
    cancel.hidden = true;
  }
});
cancel.addEventListener('click', () => { pending?.abort(); menu.open = false; });
window.addEventListener('pagehide', () => pending?.abort());
