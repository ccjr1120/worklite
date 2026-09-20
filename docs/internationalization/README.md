# Fixed Chinese Interface

WorkLite uses a single Simplified Chinese (`zh-CN`) Web resource set. The application does not expose language selection, read browser-language preferences, persist a locale preference, or synchronize locale settings through the API.

The existing translation lookup layer remains as an internal resource organization mechanism so shared copy stays consistent across the Web application. It is not a multi-locale feature: only `apps/web/src/i18n/locales/zh-CN/` is loaded at runtime.

Dates, numbers, lists, and other formatted values use the fixed `zh-CN` locale. New user-facing copy must be added only to the Chinese resource set and must follow `ui-ux-design/shared/copy-standards.md`.
