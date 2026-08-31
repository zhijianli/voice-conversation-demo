function currentPage(): "realtime" | "free-coach" | "elevenlabs" {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/openai")) return "realtime";
  if (path.endsWith("/elevenlabs")) return "elevenlabs";
  return "free-coach";
}

export function PageNav() {
  const page = currentPage();
  const base = import.meta.env.BASE_URL;

  return (
    <nav className="page-nav" aria-label="语音对话模式">
      <a className={page === "free-coach" ? "active" : ""} href={base}>
        Free Coach
      </a>
      <a
        className={page === "elevenlabs" ? "active" : ""}
        href={`${base}elevenlabs`}
      >
        ElevenLabs
      </a>
      <a
        className={page === "realtime" ? "active" : ""}
        href={`${base}openai`}
      >
        OpenAI Realtime
      </a>
    </nav>
  );
}
