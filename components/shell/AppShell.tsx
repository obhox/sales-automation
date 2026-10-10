import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Dialog as RadixDialog, VisuallyHidden } from "radix-ui";
import { Menu as MenuIcon } from "lucide-react";
import { CommandPalette } from "./CommandPalette";
import { ShellContext } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { BrandMark } from "./WorkspaceSwitcher";

/**
 * The frame every signed-in page sits in: the sidebar on the left, the page on the
 * right, and the ⌘K palette over both. Below 1024px the sidebar becomes a drawer
 * opened from a slim bar at the top.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openNav = useCallback(() => setNavOpen(true), []);
  const controls = useMemo(() => ({ openPalette, openNav }), [openPalette, openNav]);

  return (
    <ShellContext.Provider value={controls}>
      <div className="flex h-screen overflow-hidden bg-page">
        <Sidebar className="hidden lg:flex" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-surface px-3 lg:hidden">
            <button type="button" onClick={openNav} aria-label="Open navigation" className="inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-control">
              <MenuIcon size={16} aria-hidden="true" />
            </button>
            <BrandMark size={22} />
            <span className="text-135 font-medium tracking-title text-ink">Linki</span>
          </div>
          {children}
        </div>
      </div>

      <RadixDialog.Root open={navOpen} onOpenChange={setNavOpen}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-40 bg-scrim/40 data-[state=open]:animate-fade-in lg:hidden" />
          <RadixDialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 outline-none data-[state=open]:animate-fade-in lg:hidden">
            <VisuallyHidden.Root asChild>
              <RadixDialog.Title>Navigation</RadixDialog.Title>
            </VisuallyHidden.Root>
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>

      {/* Mounted only while open, so it starts empty every time. */}
      {paletteOpen ? <CommandPalette open onOpenChange={setPaletteOpen} /> : null}
    </ShellContext.Provider>
  );
}

/**
 * Holds a page that has not been rebuilt yet inside the new frame. The old styles apply
 * only within `.legacy`; the padding and width are what the old layout gave its pages.
 */
export function LegacyPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="legacy legacy-framed min-h-0 flex-1 overflow-y-auto" data-theme="linki">
      <div className="mx-auto w-full max-w-[1240px] px-4 pb-14 pt-6 md:px-10 md:pt-9">{children}</div>
    </div>
  );
}
