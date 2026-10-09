import type { CommitInfo, FileContent, TreeEntry } from "../shared/types";

export const TOKEN_KEY = "flockline.token";
export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
  return data as T;
}

export const files = {
  tree: (taskId: string) => api<TreeEntry[]>(`/api/tasks/${taskId}/tree`),
  file: (taskId: string, path: string) => api<FileContent>(`/api/tasks/${taskId}/file?path=${encodeURIComponent(path)}`),
  commits: (taskId: string) => api<CommitInfo[]>(`/api/tasks/${taskId}/commits`),
  diff: (taskId: string) => api<{ diff: string }>(`/api/tasks/${taskId}/diff`),
};
