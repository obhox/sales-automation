import {NextIntlClientProvider, createTranslator} from "next-intl";
import {createContext, useCallback, useContext, useEffect, useSyncExternalStore} from "react";
import en from "@/messages/en.json";
import ptBR from "@/messages/pt-BR.json";

export type UiLocale = "pt-BR" | "en";
export const DEFAULT_UI_LOCALE: UiLocale = "pt-BR";
const COOKIE_NAME = "LINKI_UI_LOCALE";
const CHANGE_EVENT = "linki-ui-locale-changed";
const dictionaries = {"pt-BR": ptBR, en};

type LocalePreference = {locale: UiLocale; setLocale: (locale: UiLocale) => void};
const LocaleContext = createContext<LocalePreference | null>(null);

function readClientLocale(): UiLocale {
  if (typeof document === "undefined") return DEFAULT_UI_LOCALE;
  const saved = document.cookie.split("; ").find(part => part.startsWith(`${COOKIE_NAME}=`))?.split("=")[1];
  return saved === "en" || saved === "pt-BR" ? saved : DEFAULT_UI_LOCALE;
}

function subscribeToLocaleChange(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

export function LocaleProvider({children}: {children: React.ReactNode}) {
  // Avoid mismatched SSR hydration: the Pages Router renders pt-BR on the server;
  // React reads the saved cookie after hydration via useSyncExternalStore.
  // No locale URL rewrites: auth callbacks, API endpoints and links stay stable.
  const locale = useSyncExternalStore(subscribeToLocaleChange, readClientLocale, () => DEFAULT_UI_LOCALE);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: UiLocale) => {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${COOKIE_NAME}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return (
    <LocaleContext.Provider value={{locale, setLocale}}>
      <NextIntlClientProvider locale={locale} messages={dictionaries[locale]}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}

export function useLocalePreference(): LocalePreference {
  const preference = useContext(LocaleContext);
  if (!preference) throw new Error("useLocalePreference requires LocaleProvider");
  return preference;
}

// Shared controls are also rendered without the app provider in isolated component tests.
// In those contexts they retain the English fallback; inside the app, use the
// same selected locale as next-intl without making these primitives require a provider.
const commonEn = createTranslator({locale: "en", messages: {UiCommon: en.UiCommon}, namespace: "UiCommon"});
const commonPt = createTranslator({locale: "pt-BR", messages: {UiCommon: ptBR.UiCommon}, namespace: "UiCommon"});
export function useUiCommonTranslations() {
  const locale = useContext(LocaleContext)?.locale ?? "en";
  return locale === "pt-BR" ? commonPt : commonEn;
}

const welcomeEn = createTranslator({locale: "en", messages: {WelcomePage: en.WelcomePage}, namespace: "WelcomePage"});
const welcomePt = createTranslator({locale: "pt-BR", messages: {WelcomePage: ptBR.WelcomePage}, namespace: "WelcomePage"});
export function useWelcomeTranslations() {
  const locale = useContext(LocaleContext)?.locale ?? "en";
  return locale === "pt-BR" ? welcomePt : welcomeEn;
}
