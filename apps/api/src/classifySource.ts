export function classifySource(originalPath: string | null): {
  isExternal: boolean;
  isInternal: boolean;
} {
  if (!originalPath) {
    return { isExternal: false, isInternal: false };
  }

  const normalized = originalPath.toLowerCase();

  // Adjust these prefixes to match your actual folder layout
  const externalPrefixes = [
    "/external/",
    "/mnt/external/",
    "/photos/External/",
    "/photos/external/"
  ];

  const internalPrefixes = [
    "/usr/src/app/upload/",
    "/photos/internal/",
    "/data/internal/",
    "/data/library/admin/"
  ];

  const isExternal = externalPrefixes.some((prefix) =>
    normalized.startsWith(prefix)
  );

  const isInternal = internalPrefixes.some((prefix) =>
    normalized.startsWith(prefix)
  );

  return { isExternal, isInternal };
}