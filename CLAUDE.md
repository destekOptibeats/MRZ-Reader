# MRZ-Reader

Browser-based MRZ (Machine Readable Zone) reader for passports and ID cards. Built as a single-page web app with Turkish UI.

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **OCR**: Tesseract.js with custom `mrz.traineddata` model
- **Structure**: `index.html` (UI + styles), `mrz-core.js` (MRZ parsing logic), `js/` (app modules)

## Project Structure
```
index.html          # Main SPA — all UI, styles, and screen logic
mrz-core.js         # MRZ line parsing, checksum validation, field extraction
js/app.js           # App initialization and screen management
js/camera.js        # Camera capture and live MRZ scanning
js/upload.js        # Image upload and processing
js/batch.js         # Batch document processing
js/overlay.js       # MRZ zone overlay rendering
js/telemetry.js     # Usage analytics
mrz.traineddata     # Custom Tesseract OCR model for MRZ fonts
mrz.traineddata.gz  # Gzipped version of the model
```

## Development Guidelines
- This is a static web app — no build step, no bundler
- Test changes by opening `index.html` in a browser
- UI language is Turkish
- Version string in `index.html` is auto-bumped by CI on push to main

## Git Conventions
- Use conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- Keep commits focused and atomic
- Write commit messages in English
