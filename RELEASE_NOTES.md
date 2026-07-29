## What's Changed

### Fixes
- **Completion time no longer jumps to the restart moment.** For cloud-connected printers, restarting the app while a finished print was still on screen could reset the completion time to "finished a few minutes ago" (the moment of restart). The original finish time is now preserved across restarts.
- **Correct filament color on dual-nozzle printers.** The print animation on X2D / H2D machines now follows the active (main) nozzle's filament color instead of showing the wrong color.
- **Smoother upgrades from an older downloaded version.** If an older version was already downloaded, you can now update straight to the latest version instead of being forced to install an intermediate one first.

### Improvements
- **Better download and in-app update experience for users in mainland China**, where GitHub access is often unreliable.
