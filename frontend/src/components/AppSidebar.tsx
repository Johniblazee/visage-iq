import { Activity, BarChart3, Database, LockOpen, Pause, Play, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { API_BASE_URL, type Health, type SyncJob, type WorkerStatus } from "../api";
import type { Tab } from "../App";
import { formatNumber, relativeTime } from "../format";
import ThemeToggle from "./ThemeToggle";

const tabs = [
  { id: "search", label: "Search", icon: Search },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
] as const;

// The sidebar is always dark (see index.css), so buttons/controls inside it
// swap the default theme tokens for the sidebar-* palette.
const sideActionClass =
  "w-full border border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

// Everything except the nav menu disappears when the sidebar collapses to
// the icon rail.
const expandedOnlyClass = "group-data-[collapsible=icon]:hidden";

interface AppSidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  health: Health | null;
  healthError: string;
  worker: WorkerStatus | null;
  onToggleWorker: () => void;
  activeSync: SyncJob | null;
  syncError: string;
  onSync: (prune: boolean) => void;
  onForceUnlock: () => void;
}

export default function AppSidebar({
  activeTab,
  onTabChange,
  health,
  healthError,
  worker,
  onToggleWorker,
  activeSync,
  syncError,
  onSync,
  onForceUnlock,
}: AppSidebarProps) {
  const [pruneDeleted, setPruneDeleted] = useState(true);

  const enrolledCount = health?.enrolled_count ?? 0;
  const driveTotal = health?.drive_total ?? null;
  const coverage = driveTotal ? Math.min(100, (enrolledCount / driveTotal) * 100) : null;
  const progress = activeSync?.progress;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-extrabold text-sidebar-primary-foreground">
            VI
          </div>
          <div className={cn("min-w-0", expandedOnlyClass)}>
            <h1 className="text-base font-semibold leading-tight">VisageIQ</h1>
            <p className="text-xs text-sidebar-foreground/60">Face match operations</p>
          </div>
          <div className={cn("ml-auto", expandedOnlyClass)}>
            <ThemeToggle />
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {tabs.map((tab) => (
                <SidebarMenuItem key={tab.id}>
                  <SidebarMenuButton
                    isActive={activeTab === tab.id}
                    tooltip={tab.label}
                    onClick={() => onTabChange(tab.id)}
                  >
                    <tab.icon />
                    <span>{tab.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className={expandedOnlyClass} />

        <SidebarGroup className={expandedOnlyClass}>
          <SidebarGroupLabel className="gap-2">
            <Database />
            Database
          </SidebarGroupLabel>
          <SidebarGroupContent className="grid gap-2.5 px-2">
            {healthError ? (
              <p className="text-sm font-semibold text-red-400">API unreachable</p>
            ) : health ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-sidebar-border bg-white/5 p-2">
                    <span className="block text-xs text-sidebar-foreground/60">Enrolled</span>
                    <strong>{formatNumber(health.enrolled_count)}</strong>
                  </div>
                  <div className="rounded-lg border border-sidebar-border bg-white/5 p-2">
                    <span className="block text-xs text-sidebar-foreground/60">In Drive</span>
                    <strong>{driveTotal === null ? "-" : formatNumber(driveTotal)}</strong>
                  </div>
                </div>
                {coverage !== null && (
                  <>
                    <Progress
                      value={coverage}
                      className="[&_[data-slot=progress-track]]:bg-sidebar-accent"
                    />
                    <p className="text-xs text-sidebar-foreground/60">{coverage.toFixed(1)}% coverage</p>
                  </>
                )}
                {health.last_sync_finished_at && (
                  <p className="text-xs text-sidebar-foreground/60">
                    Last sync {relativeTime(health.last_sync_finished_at)}
                  </p>
                )}
                <p className="text-xs text-sidebar-foreground/60">Model: {health.model || "unknown"}</p>
              </>
            ) : (
              <p className="text-xs text-sidebar-foreground/60">Loading status...</p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className={expandedOnlyClass} />

        <SidebarGroup className={expandedOnlyClass}>
          <SidebarGroupLabel className="gap-2">
            <Activity />
            Worker
          </SidebarGroupLabel>
          <SidebarGroupContent className="grid gap-2.5 px-2">
            {worker ? (
              <>
                <p
                  className={cn(
                    "text-sm font-semibold",
                    worker.suspended ? "text-amber-400" : "text-emerald-400",
                  )}
                >
                  {worker.suspended ? "Paused" : "Running"}
                </p>
                <Button variant="ghost" className={sideActionClass} onClick={onToggleWorker}>
                  {worker.suspended ? <Play /> : <Pause />}
                  <span>{worker.suspended ? "Resume worker" : "Pause worker"}</span>
                </Button>
              </>
            ) : (
              <p className="text-xs text-sidebar-foreground/60">Status unavailable</p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className={expandedOnlyClass} />

        <SidebarGroup className={expandedOnlyClass}>
          <SidebarGroupLabel className="gap-2">
            <RefreshCw />
            Drive Sync
          </SidebarGroupLabel>
          <SidebarGroupContent className="grid gap-2.5 px-2">
            <label className="flex items-center gap-2 text-sm text-sidebar-foreground/80">
              <Checkbox
                checked={pruneDeleted}
                onCheckedChange={setPruneDeleted}
                className="border-sidebar-foreground/40 data-checked:border-sidebar-primary data-checked:bg-sidebar-primary data-checked:text-sidebar-primary-foreground"
              />
              <span>Remove deleted Drive files</span>
            </label>
            <Button
              className="w-full bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90"
              onClick={() => onSync(pruneDeleted)}
            >
              <RefreshCw />
              <span>Sync now</span>
            </Button>
            <Button variant="ghost" className={sideActionClass} onClick={onForceUnlock}>
              <LockOpen />
              <span>Force unlock</span>
            </Button>
            {syncError && <p className="text-sm font-semibold text-red-400">{syncError}</p>}
          </SidebarGroupContent>
        </SidebarGroup>

        {activeSync && (
          <>
            <SidebarSeparator className={expandedOnlyClass} />
            <SidebarGroup className={expandedOnlyClass}>
              <SidebarGroupLabel className="gap-2">
                <Activity />
                Active Sync
              </SidebarGroupLabel>
              <SidebarGroupContent className="grid gap-2.5 px-2">
                <p className="text-xs text-sidebar-foreground/60">
                  Job {String(activeSync.job_id).slice(0, 8)}: {activeSync.status}
                </p>
                {progress && (
                  <>
                    {progress.phase === "embedding" && progress.total ? (
                      <Progress
                        value={Math.min(100, ((progress.current || 0) / progress.total) * 100)}
                        className="[&_[data-slot=progress-track]]:bg-sidebar-accent"
                      />
                    ) : null}
                    <p className="text-xs text-sidebar-foreground/60">
                      {formatNumber(progress.current || progress.listed || 0)}
                      {progress.total ? <>/ {formatNumber(progress.total)}</> : null}{" "}
                      {progress.phase || ""}
                    </p>
                  </>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <p className={cn("break-all px-2 text-xs text-sidebar-foreground/60", expandedOnlyClass)}>
          API: {API_BASE_URL}
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
