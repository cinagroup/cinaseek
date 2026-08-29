This release collects the CinaSeek native application packages built from one verified commit.

## Packages

- **Windows x64** — NSIS installer (`.exe`). The installer is not code-signed, so Windows SmartScreen may display a warning.
- **macOS** — DMG and ZIP packages. They are built with hardened-runtime settings but are not Developer ID signed or notarized.
- **Linux x64** — AppImage and Debian package (`.deb`).
- **Android** — installable debug-signed APK for testing and direct distribution; it is not a Play Store release bundle.
- **iOS Simulator** — unsigned Simulator `.app` bundle in a ZIP archive; it cannot be installed on a physical iPhone or distributed through the App Store.

The hosted web application remains available at [cinaseek.ai](https://cinaseek.ai/).

Verify downloads against `SHA256SUMS.txt` before installation.
