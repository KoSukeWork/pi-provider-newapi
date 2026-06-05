# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses semantic versioning.

## [0.3.0] - 2026-06-05

### Added

- Added `api` to generated `modelInfo` templates so unknown models can explicitly choose a supported NewAPI backend.
- Added enriched model provider/source tracking for debugging model metadata provenance.
- Added VS Code launch configuration for running the extension through pi.

### Changed

- Route models by enriched built-in model API metadata instead of hard-coded model ID prefixes.
- Register discovered NewAPI models with their enriched `api`, endpoint, and compatibility settings so pi can use the appropriate built-in stream handler.
- Expanded enrichment sources to include `zai` and `xiaomi`, while preserving provider priority.
- Apply `supportsDeveloperRole` compatibility during enrichment: enabled for `anthropic` and `openai` sources, disabled for other sources.
- Updated English and Chinese documentation to describe API-based routing and enriched model metadata.

### Fixed

- Skip built-in models with APIs unsupported by NewAPI during enrichment lookup construction. NewAPI enrichment now only uses `openai-completions`, `openai-responses`, and `anthropic-messages` models.
- Fall back to `anthropic-messages` with a warning when an enriched model has no API value.

## [0.2.0] - 2026-06-05

### Added

- Added prioritized model enrichment from multiple built-in providers.
- Added config-vs-upstream diff warnings when a previously unknown model becomes known.
- Added `compat` passthrough from enriched built-in model metadata.
- Added a dedicated `ModelLookupItem` type for enrichment lookup entries.

### Changed

- Lowered fetch timeout to 3 seconds to avoid UI freezes during NewAPI discovery.
- Updated Chinese documentation link to use an absolute GitHub URL.

## [0.1.1] - 2026-06-05

### Changed

- Updated `package.json` keywords for pi package gallery discoverability.

## [0.1.0] - 2026-06-05

### Added

- Initial `pi-provider-newapi` extension for self-hosted NewAPI gateways.
- Dynamic model discovery from `GET /v1/models`.
- NewAPI ratio config fetching from `GET /api/ratio_config` with quota-to-cost calculation.
- Model metadata enrichment and generated templates for unknown models.
- Graceful unconfigured fallback provider when discovery or authentication fails.
- `fetchWithTimeout` helper for model discovery and ratio config requests.
- English and Chinese README documentation.
- MIT license and package metadata for pi extension installation.

### Fixed

- Corrected `/login` references and installation instructions.
- Added graceful fallback behavior on fetch failures.
