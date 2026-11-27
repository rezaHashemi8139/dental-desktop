import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/i18n/use-language";
import { Button } from "@/components/ui/button";

/**
 * Previous / next buttons under a paged list, with which rows are shown
 * ("21–40 of 95"). `page` counts from 1; `shown` is how many rows this page has.
 */
export function ListPagination({
  page,
  pageSize,
  total,
  shown,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  shown: number;
  onPageChange: (page: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const { language } = useLanguage();
  const number = (value: number) => value.toLocaleString(language.code);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const rtl = i18n.dir() === "rtl";
  const Previous = rtl ? ChevronRightIcon : ChevronLeftIcon;
  const Next = rtl ? ChevronLeftIcon : ChevronRightIcon;

  return (
    <nav aria-label={t("pagination.label")} className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        {t("pagination.summary", { from: number(from), to: number(from + shown - 1), total: number(total) })}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            <Previous data-icon="inline-start" />
            {t("pagination.previous")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("pagination.page", { page: number(page), pages: number(pages) })}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
            {t("pagination.next")}
            <Next data-icon="inline-end" />
          </Button>
        </div>
      )}
    </nav>
  );
}
