## What's Changed

### New
- **Live label preview.** Settings › Appearance now has a **Status text** card: preview the label as you tweak it, pick what it shows (Layers / Time Left / Done At), and set what happens when the text doesn't fit. Nine rows of switches are now four.
- **Copy diagnostics.** Settings › About › **Copy diagnostics** puts your app, GPU, driver and display info on the clipboard, so display problems can be reported in one paste.

### Fixes
- **No more black block or black square on Windows.** Three driver-dependent causes fixed: the panda's video could be promoted to a hardware overlay that ignores window transparency, the status pill's `backdrop-filter` could make the whole window opaque, and the window could come up black after a resize, a re-show, or a display change.
- **Smooth pet-size slider.** Dragging it no longer resizes the window on every pixel.
- **Match Filament Color works on dual-nozzle printers again.** External spools and printers that don't report the active nozzle left the panda stuck on its default green; they now resolve, and anything still unknown falls back instead of giving up.

### Improvements
- **The label holds still.** Text that doesn't fit now ends in "…" instead of scrolling forever. Hover the panda to scroll it once, or choose **Scroll always** to keep the old behavior. Long printer names no longer push the status off the line.

### Under the hood
- Desktop label and settings preview share one text builder, so they can't drift apart.
- New tests cover the transparent-window fixes and the filament-color fallbacks.
