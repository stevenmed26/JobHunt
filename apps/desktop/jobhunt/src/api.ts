export const ENGINE_BASE = "http://127.0.0.1:38471";

export async function getJobs() {
  const res = await fetch(`${ENGINE_BASE}/jobs`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function seedJob() {
  const res = await fetch(`${ENGINE_BASE}/seed`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function events(onMessage: (data: any) => void) {
  const es = new EventSource(`${ENGINE_BASE}/events`);
  es.addEventListener("message", (ev) => {
    try {
      onMessage(JSON.parse((ev as MessageEvent).data));
    } catch {
      // ignore
    }
  });
  return () => es.close();
}
