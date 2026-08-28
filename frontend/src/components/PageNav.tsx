function currentPage(): "realtime" | "free-coach" {
  const path = window.location.pathname.replace(/\/+$/, "");
  return path.endsWith("/openai") ? "realtime" : "free-coach";
}

export function PageNav() {
  const page = currentPage();
  const base = import.meta.env.BASE_URL;

  return (
    <nav className="page-nav" aria-label="语音对话模式">
      <a
        className={page === "free-coach" ? "active" : ""}
        href={base}
      >
        Free Coach
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
