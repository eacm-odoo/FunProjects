/** setTimeout as a promise that rejects with the signal's reason when aborted. */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(signal.reason ?? new Error("aborted"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
