> ⚠️ **This is a beta build for testing, not a public release.** Please report anything that
> looks wrong. It will be superseded by the next stable release, which your app will pick up
> automatically.

## What's Changed

### Fixes
- **Filament color following works again on dual-nozzle printers (H2D / H2C).** On machines with two nozzles the panda could keep its original green filament and never follow the loaded color at all. Two everyday setups ran into this: printing from the external spool (common on an H2D without an AMS), and printers that don't report which nozzle is currently extruding. In both cases the app gave up rather than guessing. It now reads the external spool directly, and when it genuinely cannot tell the nozzles apart it falls back to the single-nozzle behavior instead of showing no color at all. Single-nozzle printers are unaffected.
- **Beta builds no longer get "updated" back to an older stable release.** Version numbers with a beta suffix were compared incorrectly, so a beta build looked older than the stable release it was built on top of and the app would quietly download and install the older version over it. Beta versions are now ordered correctly: newer than the stable release they follow, older than the stable release they lead to — so a beta upgrades to the next stable release and never downgrades.

**Testing notes:** if you print with two nozzles, or from the external spool, check that the panda's filament color matches what is actually loaded. The tray icon should show no update available while you are on this beta.
