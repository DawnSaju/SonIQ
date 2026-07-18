import { LazyStore } from "@tauri-apps/plugin-store";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SCOPES = ["playlist-modify-private", "playlist-modify-public", "user-read-private", "user-read-email"];

export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
export const REDIRECT_URI = "soniq://callback";

export interface SpotifyAuthData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
}

if (!CLIENT_ID) {
  console.warn("Missing Spotify clientID in environment variable");
}

export function generateCodeVerifier(length = 128): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(randomValues)
    .map((x) => possible[x % possible.length])
    .join("");
}

export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function getSpotifyAuthUrl(): Promise<{ url: string; verifier: string }> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  localStorage.setItem("spotify_verifier", verifier);

  return {
    url: `${AUTH_URL}?${params.toString()}`,
    verifier,
  };
}

const authStore = new LazyStore("spotify_auth.json");

export async function saveAuthData(data: Omit<SpotifyAuthData, "obtained_at">) {
  const payload: SpotifyAuthData = {
    ...data,
    obtained_at: Date.now(),
  };
  await authStore.set("auth_data", payload);
  await authStore.save();
}

export async function getAuthData(): Promise<SpotifyAuthData | null> {
  const data = await authStore.get<SpotifyAuthData>("auth_data");
  if (!data) return null;

  if (Date.now() > data.obtained_at + (data.expires_in - 300) * 1000) {
    return await refreshAccessToken(data.refresh_token);
  }
  return data;
}

export async function clearAuthData() {
  await authStore.delete("auth_data");
  await authStore.save();
}

export async function exchangeCodeForToken(code: string): Promise<void> {
  const verifier = localStorage.getItem("spotify_verifier");
  if (!verifier) throw new Error("No Spotify verifier found");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to exchange code: ${err}`);
  }

  const data = await response.json();
  await saveAuthData(data);
  localStorage.removeItem("spotify_verifier");
}

export async function refreshAccessToken(refreshToken: string): Promise<SpotifyAuthData> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await clearAuthData();
    throw new Error("Failed to refresh Spotify token");
  }

  const data = await response.json();
  if (!data.refresh_token) {
    data.refresh_token = refreshToken;
  }

  await saveAuthData(data);
  return { ...data, obtained_at: Date.now() };
}
