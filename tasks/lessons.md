# Lehren ulfseidl-hugo

## 04.11.2026 — Preisänderung (bau/preise-2026-27)
**Muster:** Neue Angebote/Preise brauchten Änderungen an 13 Dateien, obwohl `data/ulf.yaml` „einzige Quelle“ ist: Vorlagen, i18n, WebMCP-Texte (`data/webmcp.yaml` nennt ids wörtlich), beide Proben (Kartenzahl, Formularwerte, Mutanten mit festen Beträgen).
**Regel:** Bei jeder Angebotsänderung `grep -rn "<alte id>\|<alter Formularwert>\|€ <alter Preis>" data layouts i18n tests assets` und die Proben mit `--selbsttest` laufen lassen.

**Muster:** `tests/webmcp-probe.py` verlangt jedes Wort jeder Katalog-Aussage auf der Seite. Entfällt eine Karte, fallen ihre Sätze als Beleg weg („Familie oder Freunde …“ wurde rot).
**Regel:** Erst den Satz auf die Seite, dann in den Katalog. Angebots-ids zählen als Struktur-Wörter (seit 04.11. in `struktur_woerter`).

**Muster:** Formularwerte (`wert`) müssen in `THEMEN_LISTE` der ulf-contact-api stehen (Server `/etc/ulf-contact-api.env` auf eap-zentrale). Ein unbekannter Wert wird NICHT abgewiesen, er landet als Kategorie „nicht zugeordnet“ — die Mail kommt trotzdem.
**Regel:** Neue `wert`-Strings = zweiter Branch in `projekt-entwicklung-contact-api` (env.example, ulf_test.go, README) + Server-Env mit alten und neuen Werten zusammen; Push dort rollt über deploy.yml auf biz/ai-mini-lab aus.
