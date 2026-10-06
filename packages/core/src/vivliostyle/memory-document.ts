// Ogenkou fork modification notice (2026-10-05): this file differs from upstream Vivliostyle 2.45.1.
// See SOURCE_CODE.md in the Ogenkou distribution for the fork scope and corresponding source.
export type MemoryResourceContent = string | Blob | ArrayBuffer;

export type MemoryResource = {
  /** URL relative to MemoryDocumentSource.url, or an absolute URL. */
  url: string;
  content: MemoryResourceContent;
  mediaType?: string;
};

export type MemoryDocumentSource = {
  /** Stable absolute identity used to resolve links and preserve refresh state. */
  url: string;
  html: string;
  /** Client-owned generation used to correlate asynchronous viewer events. */
  revision?: number;
  resources?: readonly MemoryResource[];
};

export type PreparedMemoryDocument = {
  document: Document;
  objectURLs: string[];
};

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/giu;

function mediaType(resource: MemoryResource): string {
  if (resource.mediaType) return resource.mediaType;
  const pathname = new URL(resource.url, "https://memory.invalid/").pathname;
  const extension = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".avif": "image/avif",
      ".css": "text/css",
      ".gif": "image/gif",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".otf": "font/otf",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] || "application/octet-stream"
  );
}

function blob(resource: MemoryResource, content = resource.content): Blob {
  return content instanceof Blob
    ? content
    : new Blob([content], { type: mediaType(resource) });
}

function absoluteURL(url: string, baseURL: string): string {
  return new URL(url, baseURL).href;
}

/**
 * Materialize a self-contained document without fetching its HTML or declared
 * resources. Resource URLs are replaced with browser-owned blob URLs while
 * the stable source URL remains the document identity used by Core.
 */
export function prepareMemoryDocument(
  source: MemoryDocumentSource,
  window: Window,
): PreparedMemoryDocument {
  const resources = new Map(
    (source.resources || []).map((resource) => [
      absoluteURL(resource.url, source.url),
      resource,
    ]),
  );
  const objectURLs: string[] = [];
  const materialized = new Map<string, string>();
  const resolving = new Set<string>();

  const resolve = (value: string, baseURL: string): string => {
    if (!value || value.startsWith("#")) return value;
    let resolved: string;
    try {
      resolved = absoluteURL(value, baseURL);
    } catch {
      return value;
    }
    const parsed = new URL(resolved);
    const fragment = parsed.hash;
    parsed.hash = "";
    const key = parsed.href;
    const resource = resources.get(key);
    if (!resource) return value;
    const existing = materialized.get(key);
    if (existing) return `${existing}${fragment}`;
    if (resolving.has(key)) return value;
    resolving.add(key);
    let content = resource.content;
    if (mediaType(resource) === "text/css" && typeof content === "string") {
      content = content.replace(
        CSS_URL,
        (match, quote: string, target: string) => {
          const replacement = resolve(target, key);
          return replacement === target
            ? match
            : `url(${quote}${replacement}${quote})`;
        },
      );
    }
    const objectURL = (window as unknown as { URL: typeof URL }).URL.createObjectURL(
      blob(resource, content),
    );
    objectURLs.push(objectURL);
    materialized.set(key, objectURL);
    resolving.delete(key);
    return `${objectURL}${fragment}`;
  };

  // Materialize non-CSS dependencies before styles so CSS url() references
  // resolve without depending on input ordering.
  for (const [url, resource] of resources) {
    if (mediaType(resource) !== "text/css") resolve(url, source.url);
  }
  for (const [url] of resources) resolve(url, source.url);

  const DOMParserConstructor = (
    window as unknown as { DOMParser: typeof DOMParser }
  ).DOMParser;
  const document = new DOMParserConstructor().parseFromString(
    source.html,
    "text/html",
  );
  for (const element of document.querySelectorAll<HTMLElement>(
    "[src], [href], [poster], [data], [style]",
  )) {
    for (const attribute of ["src", "href", "poster", "data"]) {
      const value = element.getAttribute(attribute);
      if (value !== null)
        element.setAttribute(attribute, resolve(value, source.url));
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      element.setAttribute(
        "style",
        style.replace(CSS_URL, (match, quote: string, target: string) => {
          const replacement = resolve(target, source.url);
          return replacement === target
            ? match
            : `url(${quote}${replacement}${quote})`;
        }),
      );
    }
  }
  for (const style of document.querySelectorAll("style")) {
    style.textContent = style.textContent.replace(
      CSS_URL,
      (match, quote: string, target: string) => {
        const replacement = resolve(target, source.url);
        return replacement === target
          ? match
          : `url(${quote}${replacement}${quote})`;
      },
    );
  }
  for (const element of document.querySelectorAll<HTMLElement>("[srcset]")) {
    const value = element.getAttribute("srcset");
    if (value === null) continue;
    element.setAttribute(
      "srcset",
      value
        .split(",")
        .map((candidate) => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/u);
          return [resolve(url, source.url), ...descriptor].join(" ");
        })
        .join(", "),
    );
  }
  return { document, objectURLs };
}
