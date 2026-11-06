/**
 * Meta's Immersive Web Emulation Runtime (IWER), to try the headset mode in a
 * desktop browser: an emulated Quest 3 with controllers and hands, the DevUI
 * panel to move them, and a synthetic room (SEM) that gives the hit-test a
 * floor, tables and walls, drawn as the passthrough view.
 *
 * Development only: main.js loads it with ?emulate, and the production build
 * drops it (and the three packages) entirely.
 */

/**
 * @param {object} [options]
 * @param {string} [options.room] one of SEM's built-in rooms
 * @returns {Promise<{device: object, devui: object}>}
 */
export async function installEmulator({ room = "sunlit_living_room" } = {}) {
    const [{ XRDevice, metaQuest3 }, { SyntheticEnvironmentModule }, { DevUI }] = await Promise.all([
        import("iwer"),
        import("@iwer/sem"),
        import("@iwer/devui"),
    ]);
    const device = new XRDevice(metaQuest3);
    // Desktop Chrome already has a navigator.xr, with no AR device behind it.
    device.installRuntime({ forceInstall: true });
    // Both take the class, and the device builds and mounts them during the
    // session. The packages' READMEs still show `new DevUI(device)`, which
    // builds a panel the device never shows.
    device.installSEM(SyntheticEnvironmentModule);
    device.installDevUI(DevUI);
    await device.sem.loadDefaultEnvironment(room);
    console.info(`[emulator] Quest 3 emulated by IWER ${device.version}, room "${room}". `
        + "In the session: drag the controllers in the view, or use the panel's play mode "
        + "(right trigger = left click, right grip = right click, A = Enter, X = X).");
    return { device, devui: device.devui };
}
