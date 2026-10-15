# Contribution Guide

> To get started, <a href="https://cla-assistant.io/vivliostyle/vivliostyle.js">sign the Contributor License Agreement</a>.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Build Guideline](#build-guideline)
  - [Setup](#setup)
  - [Build](#build)
  - [Watch](#watch)
  - [Lint & Format](#lint--format)
  - [Release Flow](#release-flow)
- [Consistent Naming Guideline](#consistent-naming-guideline)
- [Commit Message Guideline](#commit-message-guideline)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Build Guideline

### Setup

```
git clone https://github.com/vivliostyle/vivliostyle.js.git
cd vivliostyle.js
yarn install
```

### Build

```
yarn build
```

### Watch

```
yarn dev
```

### Lint & Format

```
yarn lint
yarn format
```

### Release Flow

Use the development repository as the source of changes. Build and verify Core, then commit the development changes. Generate the publication files from that commit:

```shell
node scripts/export-publication.mjs --target=../vivliostyle_publish
node scripts/export-publication.mjs --target=../vivliostyle_publish --write
```

The first command previews the file changes. The second updates a clean publication repository. Review and commit the publication diff, then record that public Core commit in the parent application’s submodule. The export rules are in `publication.json`.

## Consistent Naming Guideline

1. Match class name and its file name for consistency.
2. Use PascalCase for module import name, kebab-case for a file name, making easier to visually distinguish differences.
3. No abbreviation in a file name and class name for perspicuity, except:
   1. Initialism (EPUB, PDF, etc).
   2. Lengthy name (prefer conditional-props over conditional-properties).

## Commit Message Guideline

All notable changes to this project will be documented in `CHANGELOG.md`.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.
