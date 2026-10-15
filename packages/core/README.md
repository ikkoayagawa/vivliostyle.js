# Vivliostyle Core

> このforkはGitのsubmoduleから取得してビルドする構成です。内部のパッケージ名は `@vivliostyle/core`、版は `2.45.2-ogenkou.1` です。編集プレビュー用のAPIとビルド手順は [forkの変更内容](../../CHANGES.md) を参照してください。以下は上流のVivliostyle Coreの案内です。

[![npm][npm]][npm-url]
[![Install Size][size]][size-url]
[![Downloads][downloads]][downloads-url]

Vivliostyle Core library for HTML+CSS typesetting with EPUB/Web publications support

🌏 [Vivliostyle website](https://vivliostyle.org)  
📖 [Documents](https://vivliostyle.org/documents/)  
🤝 [Join Community](https://vivliostyle.org/community/)

## Integrate Vivliostyle Core in your project

```
npm install @vivliostyle/core
```

See [API Reference](https://docs.vivliostyle.org/#/api).

## Vivliostyle official packages using Vivliostyle Core

- [Vivliostyle Viewer](https://github.com/vivliostyle/vivliostyle.js/tree/master/packages/viewer), CSS typesetting and rich paged viewing in your browser
- [Vivliostyle CLI](https://github.com/vivliostyle/vivliostyle-cli), a command-line interface for Vivliostyle.
- [Vivliostyle Print](https://github.com/vivliostyle/vivliostyle-print), allows page-layouting using the Vivliostyle Core for printing within a website without destroying the original layout.

## Development

- [Contribution Guide](https://github.com/vivliostyle/vivliostyle.js/tree/master/CONTRIBUTING.md) for development setup.
- [Development Wiki](https://github.com/vivliostyle/vivliostyle.js/wiki/Development).

## License

Licensed under [AGPL Version 3](https://www.gnu.org/licenses/agpl-3.0.html).

Vivliostyle Core is implemented based on [Peter Sorotokin's EPUB Adaptive Layout implementation](https://github.com/sorotokin/adaptive-layout), which is licensed under [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Vivliostyle Core contains following components:

- [fast-diff](https://www.npmjs.com/package/fast-diff)
  - Licensed under [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0)

## Other Documentation

- [Vivliostyle Documents](https://vivliostyle.org/documents/)

[npm]: https://img.shields.io/npm/v/@vivliostyle/core/latest
[npm-next]: https://img.shields.io/npm/v/@vivliostyle/core/next
[npm-url]: https://www.npmjs.com/package/@vivliostyle/core
[size]: https://packagephobia.vercel.app/badge?p=@vivliostyle/core
[size-url]: https://packagephobia.vercel.app/result?p=@vivliostyle/core
[downloads]: https://img.shields.io/npm/dw/@vivliostyle/core.svg
[downloads-url]: https://www.npmjs.com/package/@vivliostyle/core
