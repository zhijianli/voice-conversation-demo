import {
  schemeHref,
  schemesForCategory,
  type CategoryId,
  type SchemeId,
} from "../lib/schemes";

interface SchemeNavProps {
  category: CategoryId;
  active: SchemeId;
}

export function SchemeNav({ category, active }: SchemeNavProps) {
  const schemes = schemesForCategory(category);

  return (
    <nav className="scheme-nav" aria-label="具体方案">
      {schemes.map((scheme) => (
        <a
          key={scheme.id}
          className={active === scheme.id ? "active" : ""}
          href={schemeHref(category, scheme.id)}
        >
          <span>{scheme.name}</span>
          {!scheme.implemented ? (
            <span className="scheme-nav__badge">待接入</span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
