## What's Changed

### New
- **Bambu Lab H3C support (experimental).** The new 9-PrintTool tool changer with the AMS 3H gets its own printer photo in Settings. Match Filament Color follows the PrintTool that is currently printing. The nozzle temperature comes from that PrintTool's own heater, and PrintTool faults show as **Print Failed · PrintTool** instead of a generic failure. Built from Bambu Studio's open-source protocol code and not yet tested on a real H3C. When the panda can't tell which filament is in use, it keeps its default color rather than guess. Feedback from H3C owners is very welcome.

### Fixes
- **White filament no longer shows as black.** Printers report "no color info" as all zeros, which was read as black. On dual-nozzle printers a partial status update could also wipe which nozzle was printing. Together these made the panda hold a black spool for about 5 minutes while printing white.
- **Filament color recovers in under a minute.** When the color suddenly becomes unknown mid-print, the app now asks the printer for a full status refresh right away instead of waiting for the 5-minute periodic refresh. Rate-limited to once a minute.
- **Match Filament Color works with the AMS HT.** Single-nozzle printers printing from an AMS HT showed no filament color; they now pick up the right spool.

### Under the hood
- New tests cover the H3C tool-changer paths, the AMS HT slot mapping, the "no color" marker, and the refresh-on-color-loss rules.
