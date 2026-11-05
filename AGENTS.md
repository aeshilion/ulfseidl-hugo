# AGENTS.md – ersteschischule.at (Ulf Seidl, Skilehrer in Flachau)

Für Claude in Ulfs Sitzungen. Ulf ist Skilehrer, kein Techniker: **duzen**, kurze Sätze, keine
Fachwörter. Erst zeigen, was sich ändert, dann ändern.

## 1 Was wo steht
1.1 Texte der Seite: `content/de/_index.md`, `content/en/…`, `content/nl/…` (Startseite, Impressum, Datenschutz).
1.2 Angebote, Preise, Saison, Treffpunkt: **`data/ulf.yaml`** – die eine Quelle. Seite, Formular-Auswahl,
    `/llms.txt` und `/webmcp.json` lesen alle daraus. Regeln stehen oben in der Datei.
1.3 Knöpfe und kurze Texte je Sprache: `i18n/de.toml`, `en.toml`, `nl.toml`.
1.4 Bilder: `static/images/`. Telefon, WhatsApp, Mail: `hugo.toml` unter `[params]`.

## 2 Regeln
2.1 **Drei Sprachen:** Jede Textänderung in Deutsch, Englisch und Niederländisch. Fehlt Ulf eine
    Übersetzung, schlag eine vor und lass sie ihn bestätigen.
2.2 **Nichts erfinden.** Preise, Zeiten, Aussagen nur, was Ulf sagt. In `data/ulf.yaml` muss jede Aussage
    wörtlich auf der Seite stehen – erst den Satz auf die Seite, dann in die Datei.
2.3 **Das Anfrageformular nicht umbauen:** `layouts/partials/anfrage-formular.html`, `assets/js/anfrage.js`,
    `anfrageEndpoint` und `turnstileSitekey` in `hugo.toml` bleiben, wie sie sind. Ein neues oder
    umbenanntes Angebot ändert die Formular-Auswahl – dann **vorher Emanuel fragen**, weil der
    Mail-Dienst dahinter die Werte kennen muss (`tasks/lessons.md`).
2.4 Impressum- und Datenschutz-Link, Telefon-Link und das Formular auf der Startseite müssen bleiben –
    Emanuels Leitstand prüft sie täglich.
2.5 Keine fremden Server einbinden (keine Google-Schriften, kein CDN, keine Tracker, keine Videos von
    YouTube). Alles liegt im Repo.
2.6 Bilder vor dem Hochladen verkleinern (lange Seite höchstens 1600 px, JPG, unter 400 KB).
2.7 **Prüfen vor dem Vorschlag:** `hugo --gc --minify` muss ohne Fehler durchlaufen, dann
    `python3 tests/webmcp-probe.py` und `python3 tests/formular-probe.py`. Fehlt ein Werkzeug dafür,
    sag das ehrlich, statt grün zu melden. Proben nie abschwächen, damit sie grün werden.
    Auf GitHub laufen dieselben Proben bei jedem Pull Request („Seite prüfen“); erst bei grünem
    Haken sagst du Ulf, dass er mergen kann.
2.8 **Immer als Pull Request**, nie direkt auf `main`. Ulf schaut ihn an und klickt auf Merge; danach ist
    die Seite in etwa 2 Minuten live.
2.9 Rückgängig nur mit `git revert` (bei Merges `-m 1`), nie `reset` oder Force-Push.

## 3 Was nicht Ulfs Sache ist
3.1 Domain, DNS, Cloudflare, der Mail-Dienst hinter dem Formular (`anfrage.ersteschischule.at`) und
    die Server: das macht Emanuel. Nie nach Zugangsdaten oder dem Domain-Anbieter fragen.
3.2 Bei solchen Wünschen: kurz aufschreiben, was Ulf möchte, und sagen „das gibst du bitte Emanuel“.
