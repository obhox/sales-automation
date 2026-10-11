import { createContext, useContext } from "react";
import type { TourId } from "@/lib/client/tours";

export interface ShellControls {
  /** Open the ⌘K palette. */
  openPalette: () => void;
  /** Open the navigation drawer on a small screen. */
  openNav: () => void;
  /** Run a guided tour now, whether or not it has been seen. */
  startTour: (id: TourId) => void;
}

export const ShellContext = createContext<ShellControls>({ openPalette: () => undefined, openNav: () => undefined, startTour: () => undefined });

export const useShellControls = () => useContext(ShellContext);
