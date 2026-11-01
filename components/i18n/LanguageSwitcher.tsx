import {useTranslations} from "next-intl";
import {useLocalePreference} from "./LocaleProvider";

export function LanguageSwitcher({className = ""}: {className?: string}) {
  const t = useTranslations("Common");
  const {locale, setLocale} = useLocalePreference();
  return (
    <label className={`inline-flex items-center gap-2 text-115 text-ink-2 ${className}`}>
      <span>{t("language")}</span>
      <select
        aria-label={t("language")}
        value={locale}
        onChange={event => setLocale(event.target.value as "pt-BR" | "en")}
        className="rounded-md border border-line bg-surface px-2 py-1 text-115 text-ink"
      >
        <option value="pt-BR">{t("portuguese")}</option>
        <option value="en">{t("english")}</option>
      </select>
    </label>
  );
}
