// AbortSignal.any was added after Node 20.0; keep the declared Node 20 floor.
export function combineAbortSignals(signals) {
  const controller = new AbortController();
  const listeners = [];
  const abort = (source) => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    controller.abort(source.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) { abort(signal); break; }
    const listener = () => abort(signal);
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}
