# PacketLark artwork

The icon combines a lark in flight with a folded message, in cream and gold on a deep teal tile. The artwork is part of PacketLark and uses the repository's MIT license.

- `icon.svg` is the editable vector source, with transparent corners and no font dependency.
- `icon.png` is the 1024 × 1024 RGBA export for Linux packaging, application windows, and desktop notifications when enabled.
- `icon.ico` contains 16, 20, 24, 32, 40, 48, 64, 128, and 256 pixel images for Windows Explorer, shortcuts, taskbars, and installers.

All exports are checked in. Normal development and GitHub Actions builds require no image tools or extra dependencies. The toolbar and renderer favicon use the SVG through Vite's asset handling; the desktop window uses the packaged PNG. Existing application IDs, account associations, and storage paths remain unchanged.

If the artwork changes, export the SVG at 1024 × 1024 with transparency, then regenerate every ICO size from that PNG. The current exports were made with CairoSVG and Pillow (development tools only); do not flatten the transparent corners or substitute a font glyph.
