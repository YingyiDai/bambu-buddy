## What's Changed

### New
- **Intel Mac build.** macOS now ships in two flavors: `macOS-arm64` for Apple Silicon (M1/M2/M3…) and `macOS-x64` for Intel Macs. Download the one that matches your machine — Apple menu › About This Mac tells you which one you have. In-app updates pick the right build automatically.

### Fixes
- **No more flicker when a print starts.** In the first second of a job the panda could flash "Printing", "Finished" or "Idle" before settling on "Preparing". Those half-updated frames from the printer are now recognized for what they are, and a new state stabilizer holds back any single-frame state change until the printer confirms it — so the panda shows the state your printer is really in, without the twitch.
- **Cloud printers come back online on their own.** After powering the printer off and on, the panda could stay offline for up to five minutes, or until you signed in again. It now recovers within 30 seconds, with no manual re-login.
- **Rounded Dock icon on every macOS version.** The icon was a square image that relied on macOS to round the corners, which only macOS 26 does — on macOS 15 and earlier it showed up square. The rounded shape is now part of the icon itself.

### Improvements
- **Overnight prints show which day they finish.** A print that ends after midnight now reads "Done 08:00+1" instead of a bare "Done 08:00", so a 9-hour and a 33-hour job are no longer indistinguishable. The offset counts local calendar days, so it stays correct across daylight-saving changes, and it is not capped — a week-long print shows "+7".

### Under the hood
- Release notes are now hand-written in English and enforced by CI, and the release pipeline builds, verifies, signs and mirrors both Mac architectures.
- New developer script to preview the panda's label off-screen, so label wording and layout can be checked without a printer or a display.
