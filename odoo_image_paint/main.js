/**
 * Entry point, called by the service worker each time the toolbar icon is
 * clicked: starts the picker, cancels it, or brings the open editor back
 * to the front.
 */
(() => {
    const ns = (globalThis.oImagePaint ??= {});

    let picker = null;
    let editor = null;

    /** @param {string} origin the tab's origin, as Chrome reports it */
    ns.toggle = (origin) => {
        if (location.origin !== origin) {
            return;
        }
        if (editor) {
            editor.focus();
            return;
        }
        if (picker) {
            picker.stop();
            return;
        }
        picker = new ns.Picker(origin, {
            pick: (target) => {
                picker = null;
                editor = new ns.Editor(origin, target, () => {
                    editor = null;
                });
                editor.open();
            },
            end: () => {
                picker = null;
            },
        });
        picker.start();
    };
})();
