import { getAuthData, refreshAccessToken, clearAuthData } from "./spotify-auth";
import type { SoundtrackEntry } from "./soundtrack";
import { invoke } from "@tauri-apps/api/core";

const API_BASE = "https://api.spotify.com/v1";

async function fetchSpotify(endpoint: string, options: RequestInit = {}) {
  let auth = await getAuthData();
  if (!auth) throw new Error("Not authenticated with Spotify");

  const headers: Record<string, string> = {};
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers as any)) {
      headers[k] = v as string;
    }
  }
  headers["Authorization"] = `Bearer ${auth.access_token}`;

  let status: number;
  let text: string;
  try {
    const result: [number, string] = await invoke("fetch_spotify", {
      url: `${API_BASE}${endpoint}`,
      method: options.method || "GET",
      headers,
      body: options.body ? String(options.body) : null,
    });
    status = result[0];
    text = result[1];
  } catch (err) {
    throw new Error(`Rust reqwest failed: ${err}`);
  }

  if (status === 401) {
    // Try one refresh
    auth = await refreshAccessToken(auth.refresh_token);
    headers["Authorization"] = `Bearer ${auth.access_token}`;

    try {
      const retryResult: [number, string] = await invoke("fetch_spotify", {
        url: `${API_BASE}${endpoint}`,
        method: options.method || "GET",
        headers,
        body: options.body ? String(options.body) : null,
      });
      status = retryResult[0];
      text = retryResult[1];
    } catch (err) {
      throw new Error(`Rust reqwest retry failed: ${err}`);
    }
  }

  if (status === 429) {
    console.warn(`Spotify rate limited. Waiting 2000ms before retrying...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const retryResult: [number, string] = await invoke("fetch_spotify", {
        url: `${API_BASE}${endpoint}`,
        method: options.method || "GET",
        headers,
        body: options.body ? String(options.body) : null,
      });
      status = retryResult[0];
      text = retryResult[1];
    } catch (err) {
      throw new Error(`Rust reqwest rate limit retry failed: ${err}`);
    }
  }

  if (status < 200 || status > 299) {
    try {
      const errorData = JSON.parse(text);
      throw new Error(`Spotify API error ${status} on ${endpoint}: ${errorData.error?.message || text}`);
    } catch {
      throw new Error(`Spotify API error ${status} on ${endpoint}: ${text}`);
    }
  }

  return {
    ok: true,
    status,
    json: async () => text ? JSON.parse(text) : {}
  };
}



export async function searchTrack(title: string, artist: string): Promise<string | null> {
  if (!title) return null;
  const cleanTitle = title.replace(/\(.*remaster.*\)/i, "").trim();
  const query = `track:${cleanTitle}${artist ? ` artist:${artist}` : ""}`;
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: "1",
  });

  const res = await fetchSpotify(`/search?${params.toString()}`);
  const data = await res.json();

  if (data.tracks?.items?.length > 0) {
    return data.tracks.items[0].uri;
  }
  return null;
}

export async function createPlaylist(name: string): Promise<string> {
  const res = await fetchSpotify("/me/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      public: false,
    }),
  });
  const data = await res.json();
  return data.id;
}

export async function addItemsToPlaylist(playlistId: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await fetchSpotify(`/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: chunk }),
    });
  }
}

export async function exportSoundtrack(name: string, entries: SoundtrackEntry[]): Promise<{ playlistId: string; matched: number; total: number }> {
  const uris: string[] = [];
  for (const entry of entries) {
    const uri = await searchTrack(entry.title, entry.artist);
    if (uri) uris.push(uri);
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  if (uris.length === 0) {
    throw new Error("No tracks could be found on Spotify to export.");
  }

  const playlistId = await createPlaylist(name);
  await addItemsToPlaylist(playlistId, uris);

  return {
    playlistId,
    matched: uris.length,
    total: entries.length,
  };
}
