import {
  CATEGORIES,
  categoryHref,
  getCategory,
  type CategoryId,
} from "../lib/schemes";

interface CategoryTabsProps {
  active: CategoryId;
}

export function CategoryTabs({ active }: CategoryTabsProps) {
  const activeCategory = getCategory(active);

  return (
    <div className="category-tabs-wrap">
      <nav className="category-tabs" aria-label="语音方案类别">
        {CATEGORIES.map((category) => (
          <a
            key={category.id}
            className={active === category.id ? "active" : ""}
            href={categoryHref(category.id)}
          >
            {category.label}
          </a>
        ))}
      </nav>
      {activeCategory ? (
        <p className="category-tabs__intro">{activeCategory.description}</p>
      ) : null}
    </div>
  );
}
