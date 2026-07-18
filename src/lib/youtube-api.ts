import { invoke } from "@tauri-apps/api/core";
import type { SoundtrackEntry } from "./soundtrack";

export async function searchYouTubeTrack(title: string, artist: string): Promise<string | null> {
  if (!title) return null;
  const cleanTitle = title.replace(/\([^)]*remaster[^)]*\)/i, "").trim();
  const query = `${cleanTitle} ${artist ? artist : ""}`.trim();
  const params = new URLSearchParams({ search_query: query });

  const url = `https://www.youtube.com/results?${params.toString()}`;

  try {
    const result: [number, string] = await invoke("fetch_spotify", {
      url,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: null,
    });

    const status = result[0];
    const html = result[1];

    if (status === 200 && html) {
      const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch (err) {
    console.error("YouTube search failed:", err);
  }

  return null;
}

export async function exportToYouTube(entries: SoundtrackEntry[]): Promise<string> {
  const videoIds: string[] = [];

  for (const entry of entries) {
    const videoId = await searchYouTubeTrack(entry.title, entry.artist);
    if (videoId) {
      videoIds.push(videoId);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  if (videoIds.length === 0) {
    throw new Error("No tracks could be found on YouTube.");
  }

  const uniqueIds = Array.from(new Set(videoIds)).slice(0, 50);

  return `https://www.youtube.com/watch_videos?video_ids=${uniqueIds.join(",")}`;
}
