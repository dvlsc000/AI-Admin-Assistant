const API = import.meta.env.VITE_API_URL;

/**
 * Fetch helper:
 * - includes cookies for session auth (credentials: "include")
 * - throws readable errors
 */
export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    credentials: "include"
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || body?.details || `Request failed (${res.status})`);
  }

  return res.json();
}

export function apiBase() {
  return API;
}
