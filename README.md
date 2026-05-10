# Immich Dedupe

A local duplicate-resolution tool for Immich that analyzes duplicate groups, applies deterministic safety rules, preserves album memberships, and resolves safe duplicates in bulk.

## Overview

Immich Dedupe is a local helper app for managing large numbers of suspected duplicate assets in an Immich library.

It is designed for situations where duplicate groups contain:

- an original asset in an External Library
- a lower-quality or imported copy in the Internal Library
- duplicate groups that are too numerous to review manually through Immich’s built-in Duplicate utility

The app connects to the Immich API, enriches duplicate group data, applies conservative rules, and resolves only high-confidence matches.

## Current Status

This project is under active development.

Currently implemented:

- Express API backend
- Immich API connection through `@immich/sdk`
- duplicate group fetching
- duplicate normalization
- asset file-size enrichment
- album membership enrichment
- deterministic rule engine
- dry-run execution
- real duplicate resolution
- album transfer before resolution
- execution logging
- batch execution with separate scan and execution limits
- backend status and log endpoints
- initial Web UI planning

Not yet implemented:

- full React GUI dashboard
- execution plan preview UI
- manual review UI
- thumbnails
- rule configuration UI
- packaged deployment

## Architecture

This project uses a pnpm monorepo.

```text
immich-dedupe/
  apps/
    api/              # Express backend
    web/              # React/Vite frontend
  packages/
    shared/           # Shared TypeScript types
    rule-engine/      # Pure duplicate decision logic
    immich-client/    # Reserved for future Immich client abstractions