// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
/*
 * Copyright 2018 Vivliostyle Foundation
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

export * from "./vivliostyle/constants";
export { HOOKS, plugin, registerHook, removeHook, getHooksForName } from "./vivliostyle/plugin";
export type {
  PreProcessSingleDocumentHook, PreProcessTextContentHook,
  PreProcessElementStyleHook, PolyfilledInheritedPropsHook, ConfigurationHook,
  ResolveTextNodeBreakerHook, ResolveFormattingContextHook,
  ResolveLayoutProcessorHook, PostLayoutBlockHook, PaginationProgressHook,
} from "./vivliostyle/plugin";
export * from "./vivliostyle/profile";
export * from "./vivliostyle/core-viewer";
export * from "./vivliostyle/memory-document";
export { type SourceTextEntry, type SourceTextKind, type SourceTextPosition } from "./vivliostyle/source-map";
export { SourceMappedPresentation } from "./vivliostyle/source-presentation";
export { CompletedPaperDocument, type CompletedPaperPacket } from "./vivliostyle/completed-paper";
export { CompletedPaperHost } from "./vivliostyle/completed-paper-host";
export { PortableSeedError, type PortablePreviewSeed } from "./vivliostyle/portable-seed";
export * from "./vivliostyle/print";
export * from "./vivliostyle/assets";
