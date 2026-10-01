// Turns a tutorial's share link (YouTube, Loom, Vimeo) into one an iframe can play.
// Anything else is returned as given.
export function getVideoEmbedUrl(url) {
  return getKnownVideoEmbedUrl(url) ?? url ?? null;
}

// Like getVideoEmbedUrl, but null for anything that is not a YouTube, Loom or Vimeo
// link, for callers that would rather link to an unknown page than frame it.
export function getKnownVideoEmbedUrl(url) {
  if (!url) return null;
  try {
    const youtubeMatch = url.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    }
    const loomMatch = url.match(/loom\.com\/share\/([A-Za-z0-9_-]+)/);
    if (loomMatch) {
      return `https://www.loom.com/embed/${loomMatch[1]}`;
    }
    const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }
  } catch {
    return null;
  }
  return null;
}
