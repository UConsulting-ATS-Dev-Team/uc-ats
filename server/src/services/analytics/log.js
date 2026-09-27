// console.error as it was before errorCapture.js wrapped it.
//
// Everything under services/analytics/ logs its own trouble through this and
// never through console.error: once the wrapper is installed, a failed
// analytics write reported through console.error would be captured as a server
// error, buffered, fail to write again, and loop.
//
// Bound at import time. errorCapture.js imports this module, so it is always
// loaded before the wrapper can be installed.
export const logError = console.error.bind(console);
