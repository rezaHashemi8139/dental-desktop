import { useState } from "react";
import { ArchiveRestoreIcon, ChevronRightIcon, DatabaseBackupIcon, ShieldAlertIcon, Trash2Icon, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/store";
import { cn } from "@/lib/utils";
import { ClearDatabaseDialog } from "@/components/clear-database-dialog";
import { ExportDatabaseDialog } from "@/components/export-database-dialog";
import { RestoreDatabaseDialog } from "@/components/restore-database-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type DatabaseDialog = "export" | "restore" | "clear";

/**
 * /database: everything done to the clinic database as a whole: back it up,
 * restore it, clear it. Each option opens its own dialog.
 */
export function DatabasePage() {
  const { t } = useTranslation();
  const session = useSession();
  const [dialog, setDialog] = useState<DatabaseDialog | null>(null);
  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  // Managers only (checked again in src-tauri/src/backup.rs). Others see the
  // options disabled, with the reason.
  const allowed = session.role === "manager";
  const dialogProps = (name: DatabaseDialog) => ({
    open: dialog === name,
    onOpenChange: (open: boolean) => setDialog(open ? name : null),
  });

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>{t("database.title")}</CardTitle>
        <CardDescription>{t("database.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!allowed && (
          <Alert>
            <ShieldAlertIcon />
            <AlertDescription>{t("database.errors.notAllowed")}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col divide-y rounded-lg border">
          <DatabaseOption
            icon={DatabaseBackupIcon}
            title={t("backup.export.title")}
            summary={t("backup.export.summary")}
            disabled={!allowed}
            onClick={() => setDialog("export")}
          />
          <DatabaseOption
            icon={ArchiveRestoreIcon}
            title={t("backup.restore.title")}
            summary={t("backup.restore.summary")}
            disabled={!allowed}
            onClick={() => setDialog("restore")}
          />
          <DatabaseOption
            icon={Trash2Icon}
            title={t("database.clear.title")}
            summary={t("database.clear.summary")}
            disabled={!allowed}
            destructive
            onClick={() => setDialog("clear")}
          />
        </div>
      </CardContent>

      <ExportDatabaseDialog {...dialogProps("export")} />
      <RestoreDatabaseDialog {...dialogProps("restore")} />
      <ClearDatabaseDialog {...dialogProps("clear")} username={session.username} />
    </Card>
  );
}

/** One row of the options list: what it does, and a chevron pointing onward. */
function DatabaseOption({
  icon: Icon,
  title,
  summary,
  disabled,
  destructive,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  summary: string;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-3 p-3 text-start transition-colors outline-none first:rounded-t-lg last:rounded-b-lg hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon className={cn("size-5 shrink-0", destructive ? "text-destructive" : "text-muted-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-sm font-medium", destructive && "text-destructive")}>{title}</span>
        <span className="text-xs text-muted-foreground">{summary}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
    </button>
  );
}
