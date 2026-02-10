// api.js
export function apiBase() {
  // Prefer Vite env var if set, otherwise assume same origin proxy or localhost backend.
  return import.meta.env.VITE_API_URL || "http://localhost:3001";
}

export async function apiFetch(path, options = {}) {
  const base = apiBase().replace(/\/$/, "");
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;

  // Default timeout: 120s (sync+AI can be slow)
  const timeoutMs = options.timeoutMs ?? 120000;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      credentials: "include", // IMPORTANT for session cookie
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

    if (!res.ok) {
      const msg =
        (body && typeof body === "object" && (body.details || body.error)) ||
        (typeof body === "string" && body) ||
        `HTTP ${res.status}`;

      throw new Error(msg);
    }

    return body;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}
