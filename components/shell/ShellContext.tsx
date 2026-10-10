import { createContext, useContext } from "react";

export interface ShellControls {
  /** Open the ⌘K palette. */
  openPalette: () => void;
  /** Open the navigation drawer on a small screen. */
  openNav: () => void;
}

export const ShellContext = createContext<ShellControls>({ openPalette: () => undefined, openNav: () => undefined });

export const useShellControls = () => useContext(ShellContext);
