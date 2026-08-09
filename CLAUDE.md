# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Sauna Heatmap München

Persönliches Dashboard, das die Auslastung Münchner Saunen über die Woche visualisiert. Ziel: antizyklische Besuchszeiten finden — möglichst leere 4h-Fenster.

## System-Überblick

Zwei getrennte Komponenten, die nur über ein Google Sheet und einen JSON-Endpoint verbunden sind:

```
SWM REST / Ticos API / Phoenixbad AJAX / Fresch Gips API / Claudius HTML
  ↓  fetchAll()  — Apps Script, Trigger alle 30 Min
Google Sheet "Saunen Auslastung"
  ↓  doGet()  — Apps Script Web App, JSON
index.html  — GitHub Pages
```

Parallel dazu fetcht das Frontend direkt aus dem Browser:
- **SWM REST** (`swm.de/.rest/bath/visitorCount`) für Echtzeit-Auslastung der 7 SWM-Saunen (die Live-Kacheln oben) — ein Call, Zuordnung per `area_id`, CORS ist offen (`access-control-allow-origin: *`)
- **Open-Meteo** für Niederschlagsdaten (Wetter-Korrelation), `past_days=30` — ältere Zeilen haben keine Wetterzuordnung

Phoenixbad, Fresch und Claudius haben keine browserfähige Echtzeit-Quelle — deren Kacheln zeigen den letzten Wert aus dem Sheet.

## Was wo liegt

| Datei | Ort | Rolle |
|---|---|---|
| `index.html` | dieses Repo | Komplettes Frontend, eine selbstständige Datei |
| `apps-script.gs` | dieses Repo (Kopie) | Referenzkopie des Backends — Datensammler, Alerting, `doGet()` |
| `cleansing.gs` | dieses Repo (Kopie) | Referenzkopie des Data Cleansing |
| — | Google Apps Script | Die **laufenden** Originale beider `.gs`-Dateien, gleich benannt |
| `CLAUDE.md` | dieses Repo | Diese Datei |

`apps-script.gs` ist **nur eine Kopie**. Das laufende Backend lebt im Apps-Script-Projekt; Änderungen hier müssen manuell dorthin übertragen und neu deployed werden — und umgekehrt kann das Original der Kopie vorausgelaufen sein. Vor Backend-Arbeit prüfen, ob die Kopie noch aktuell ist. Konkret bekannt: `ALERT_EMAIL` steht in der Kopie auf dem Platzhalter `DEINE_EMAIL@gmail.com`, im Original nicht.

**IDs:** Sheet `1PCvPFyERck2HMAF2W5HBqccXq1nGsmrUpNos-e4if5M`, GID `372330793`. Der API-Endpoint steht als `API`-Konstante oben in `index.html`.

## Getrackte Saunen (10)

| Sauna | Quelle |
|---|---|
| Cosimawellenbad (area 75), Michaelibad (9), Westbad (18), Dantebad (33), Nordbad (63), Südbad (81), Müllersches Volksbad (87) | SWM REST `swm.de/.rest/bath/visitorCount` — ein Call für alle Bäder, Zuordnung per `area_id` |
| Phoenixbad Sauna | `phoenixbad.de/wp-admin/admin-ajax.php?action=updateLiveVisitors&area=Sauna` |
| Fresch Sauna (Freising) | Gips CMS API, JSON mit `ZoneUsages`, Zone `"Sauna"`, max 150 |
| Claudius Therme (Köln) | HTML-Gäste-Ampel: HTML-Kommentare `<!-- full anchor` / `<!-- half anchor` zählen, Score 0–5 → Prozent |

Backend und Frontend nutzen inzwischen **dieselbe** SWM-Quelle, jeweils mit eigener `area_id`-Liste (`SWM_SAUNAS` bzw. `SWM`). Ein neues Bad muss an beiden Stellen eingetragen werden.

**Vorsicht bei den Doppel-Einträgen:** Die REST-Antwort enthält pro Sauna zwei Areas — die benannte (`"Nordbad Sauna"`, id 63) und eine Kurzform (`"NB - Sauna"`, id 117). Die Kurzform steht durchgängig auf 0 und ist **nicht** die richtige. Immer die ausgeschriebene Variante nehmen.

## Ticos ist tot — und fällt nicht ehrlich aus

`counter.ticos-systems.cloud` war bis Mitte 2026 die SWM-Quelle. Der Endpoint **antwortet weiterhin mit HTTP 200**, liefert aber für jede `organizationUnitId` `personCount: 0`. Ein Fallback darauf erfindet also stillschweigend Nullen, statt zu scheitern — genau das ist passiert: Cosimawellenbad ab 21.06.2026 und Nordbad ab 07.06.2026 haben monatelang reine Nullzeilen ins Sheet geschrieben, jeweils ab dem Revisionstermin der jeweiligen Sauna (SWM scheint die Ticos-Kennung bei der Revision abzuschalten).

Daraus die Regel: **keine Datenquelle als Fallback behalten, die 0 zurückgibt statt zu scheitern.** Lieber `NO_DATA` loggen — dann greift auch die Zero-Streak-Erkennung. `SWM_TICOS_API` steht nur noch für `testSWM()` im Script.

Die bereits gespeicherten Nullzeilen stehen weiterhin im Sheet und werden über die Qualitäts-Spalte aussortiert (siehe unten). Eine frühere Zwischenlösung mit fest verdrahteten Datumsfenstern (`BAD_DATA` / `isBadRow()`) wurde damit abgelöst und entfernt.

---

# Backend (Apps Script)

## Struktur

**Konfiguration oben im Script:** `ALERT_EMAIL`, `SHEET_NAME = "Saunen Auslastung"`, `SHEET_LOG = "Health Log"`, `INTERVAL_MINUTES = 30`, `ZERO_STREAK_THRESHOLD = 2`

**Zwei Trigger**, eingerichtet über `setupTriggers()` (Plural — es gab mal eine Singular-Version):
- `fetchAll` alle 30 Minuten — Datenerfassung
- `dailyHealthCheck` täglich 23:30 — Zusammenfassung

**Sheet-Spalten:** Timestamp, Datum, Wochentag, Uhrzeit, Betreiber, Sauna, Personen, Max Kapazität, Auslastung %

Die **Spaltenreihenfolge ist im Backend fest verdrahtet**: `checkZeroStreaks()` und `dailyHealthCheck()` greifen per Index zu (`[0]` Timestamp, `[1]` Datum, `[3]` Uhrzeit, `[5]` Sauna, `[6]` Personen). Eine eingeschobene Spalte bricht beides still — das Frontend merkt nichts davon, weil es über `fCol()` nach Header-Namen sucht.

**Zweites Sheet "Health Log"** protokolliert alle Fehler und Anomalien.

**Test-Funktionen:** `testSWM()` (zeigt pro Sauna, ob REST oder Ticos greift), `testPhoenixbad()`, `testFresch()`, `debugFreschAPI()`, `testClaudius()`, `testAlert()`, `removeTriggers()`

## Data Cleansing (`cleansing.gs`)

Eigene Script-Datei im selben Apps-Script-Projekt, täglicher Trigger um 03:00. Sie **löscht nichts**, sondern schreibt eine Spalte `Qualitaet` (Spalte J, ans Ende) mit einem Befund pro Zeile. Dadurch ist der Lauf idempotent, Schwellen bleiben nachträglich änderbar, und die Unterscheidung zwischen „Sauna war leer" und „Quelle war kaputt" bleibt erhalten.

| Befund | Bedeutung |
|---|---|
| `OK` | unauffällig |
| `AUSSERHALB` | außerhalb der Öffnungszeit laut `isSaunaOpen()`, inkl. Revision |
| `TAG_OHNE_BETRIEB` | ganzer Tag während der Öffnungszeit auf 0 |
| `SPAET_AUF` / `FRUEH_ZU` | Nullserie ≥ 3 Slots am Tagesrand, dazwischen echter Betrieb |
| `QUELLE_EINGEFROREN` | Quelle lieferte Cache statt Echtzeit |
| `ZU_WENIG_MESSUNGEN` | zu wenige Messungen am Tag für eine Beurteilung |

**Die Frozen-Erkennung ist der heikle Teil.** Ein konstanter Wert allein ist *kein* Fehler — eine ruhige Sauna steht stundenlang bei 2 Gästen, und die Claudius-Ampel kennt nur 11 Stufen. Eine naive Regel hätte 65 % der Claudius-Zeilen verworfen. Ausschlaggebend ist deshalb:
- **bei SWM die Gleichzeitigkeit** über mehrere Saunen desselben Betreibers. Am 26.07.2026 froren alle vier gleichzeitig ein und tauten im selben Slot wieder auf — das ist eindeutig quellenseitig.
- **bei Phoenixbad, Fresch und Claudius** die Werthöhe gegenüber dem Sauna-Median, weil sie je die einzige Sauna ihres Betreibers sind und die Gleichzeitigkeitsprüfung dort nie greifen kann. Damit werden genau die Phoenixbad-Zeilen vom 01.–08.04.2026 erkannt, also die WP-Rocket-Ära vor der AJAX-Umstellung.

Bekannte Lücke: die Klassifikation prüft die Öffnungszeit zuerst. Defekte Messwerte außerhalb der Öffnungszeit bekommen deshalb `AUSSERHALB` statt eines Defektbefunds und bleiben als graue Outlier-Zellen sichtbar.

## Bedingtes Fetchen

Phoenixbad, Fresch und Claudius werden **nur abgefragt, wenn `isSaunaOpen()` true ist.** Grund: Der Phoenixbad-Endpoint liefert außerhalb der Öffnungszeiten gecachte Werte, die als echte Messungen im Sheet landen würden. Die SWM-Saunen laufen dagegen unkonditioniert durch — Nullwerte außerhalb der Öffnungszeit werden im Frontend als Outlier dargestellt (siehe `cellH()`).

## Alerting — bewusste Design-Entscheidungen

Diese Punkte sind das Ergebnis mehrerer Iterationen und sollen **nicht** zurückgedreht werden:

- **Zero-Streak-Schwelle steht auf 2**, nicht 4. Bei 30-Min-Intervall schlägt der Alert damit nach einer Stunde an.
- **Die Annahme hinter der Schwelle stimmt nicht mehr ganz.** Ursprünglich galt: keine Sauna hat während der Öffnungszeit wirklich 0 Besucher. Für **Cosimawellenbad** ist das im August 2026 nachweislich falsch — die Sauna ist offen und steht auch laut SWM-eigener Echtzeitanzeige real auf 0. Ein Null-Streak-Alert für Cosima ist damit ein korrekt ausgelöster, aber sachlich falscher Alarm. Die Schwelle deswegen **nicht** hochsetzen (siehe oben); falls es stört, eher Cosimawellenbad gezielt von der Prüfung ausnehmen.
- **Die Kapazitäts-Anomalie-Prüfung wurde bewusst entfernt.** Die Sprünge in den Max-Werten sind zu groß, das erzeugt nur Rauschen. Nicht wieder einbauen.
- **Alerts feuern nur bei echten Problemen.** Keine täglichen "alles in Ordnung"-Mails — `dailyHealthCheck()` mailt nur bei `hasIssue`, loggt aber immer ins Health Log.
- **Duplikat-Schutz:** maximal ein Alert pro Typ pro Tag, umgesetzt über `CacheService` mit 72000 s TTL (20 h) und einem aus dem Betreff abgeleiteten Key.
- **Revision unterdrückt Fehlalarme:** Saunen in einer Revisionsperiode gelten im Health Check als "IN REVISION (erwartet)" statt "KEINE DATEN".

## `isSaunaOpen(saunaName, dateTime)`

Zero-Streak-Detection darf nicht mit einem pauschalen 8–22-Fenster arbeiten — das erzeugte Fehlalarme um 08:36 für Saunen, die erst um 09:00 öffnen. Die Funktion prüft stattdessen die individuellen Öffnungszeiten pro Sauna und bekannte Revisionsperioden.

**Zeitzonen-Falle:** Die Wochentagsermittlung nutzt `Utilities.formatDate(date, "Europe/Berlin", "u")` und `% 7`. Ohne die explizite Zeitzone rutscht die Zuordnung bei UTC-Grenzen um einen Tag. Das war die Ursache für kaputte Feiertagsfilter.

---

# Frontend (`index.html`)

Kein Build-Step, keine Dependencies, kein npm, keine Tests. Jeder Push auf `main` ist nach 1–2 Minuten live unter `https://feigelbinder.github.io/sauna-heatmap#sauna2026`.

## Entwickeln und Deployen

```sh
open index.html                 # lokal im Browser (Hash #sauna2026 manuell anhängen)
git add -A && git commit -m … && git push   # Deploy = Push auf main
curl -sL "<API-URL aus index.html>" | head -c 400   # Sheet-Endpoint prüfen
```

Es gibt keinen Lint- und keinen Testlauf. Die einzige Verifikation ist: `VERSION` hochzählen, pushen, Seite laden und die Fußzeile prüfen — steht dort noch die alte Version, liefert GitHub Pages noch die alte Datei aus.

## Datenfluss im Frontend

`fetchAll()` → `render()` → `process()`. Alles läuft über globale Variablen (`raw`, `sel`, `vollAt`, `exclOn`, `exclFerien`, `showBW`, `showConf`, `wFilt`); jede Interaktion ruft schlicht `render()` neu auf, das `process()` komplett neu rechnet und `innerHTML` des Containers ersetzt. Kein diffing, kein State-Management — Event-Handler werden in `bindEvents()` nach jedem Render neu gesetzt.

`process()` filtert `raw` (Feiertage, Ferien, ausgewählte Sauna, Wetter), aggregiert nach `Wochentag|Uhrzeit` zu `{avg,min,max,n}` und schiebt daraus das 4h-Fenster über alle Tage.

`sel === '__all__'` ist ein gültiger Zustand (aggregiert über alle Saunen, ohne Öffnungszeiten- und Damenzeit-Filter), aber es gibt derzeit **kein UI-Element, das ihn setzt** — nur die Kacheln, die konkrete Saunennamen liefern.

## Kernparameter

- **Zeitraster:** `TS` läuft 07:00–23:30 in 30-Min-Slots
- **Empfehlungsfenster:** `WIN = 8` Slots = 4 Stunden. Die Top-6-Vorschläge dürfen sich maximal zur Hälfte überlappen (`maxOv = WIN/2`), sonst kommen sechs Varianten desselben Zeitfensters raus
- **Farbskala:** relativ zu `vollAt` (Default 70, per Slider 20–100). Bei `vollAt = 70` ist eine Zelle mit 70% bereits voll rot — nicht linear auf 100% skaliert, weil 70% praktisch schon zu voll ist
- **Konfidenz:** unter 10 Messpunkten pro Zelle wird gestrichelt markiert (nur wenn Toggle an)
- **Qualitätsfilter:** `QUAL_BLOCK` listet die Befunde aus `cleansing.gs`, die ausgeschlossen werden; `isQualBad()` wertet sie aus. Das ist bewusst eine **Blockliste, keine Positivliste** — frisch erfasste Zeilen haben noch keinen Befund, weil das Cleansing nur nachts läuft, und dürfen nicht den laufenden Tag leeren. `AUSSERHALB` steht bewusst nicht drin: Öffnungszeiten prüft das Frontend selbst, und Werte außerhalb sind als graue Outlier gewollt. Der Filter greift an drei Stellen — `process()`, `getLatest()`, `getLastPerSauna()`; wer eine vierte Auswertung über `raw` baut, muss ihn dort mitnehmen. Abschaltbar über den Toggle „Nur geprüfte Daten"
- **Wetter:** über 2 mm Tagesniederschlag gilt als Regentag. Tage ohne Wetterdaten werden nicht ausgefiltert
- **Layout:** unter 640px wird die Heatmap transponiert — Wochentage als Spalten, Zeiten als Zeilen. Tooltips laufen dort über `touchstart` statt Hover

## Zellzustände in `cellH()`

Die Reihenfolge ist bedeutungstragend:

1. **Damenzeit** → schraffiert mit ♀
2. **Außerhalb der Öffnungszeit, aber Daten vorhanden** → grauer Text ohne Farbe (Messfehler-Outlier, sichtbar aber irrelevant)
3. **Außerhalb der Öffnungszeit, keine Daten** → fast unsichtbar
4. **Geöffnet, keine Daten** → gestrichelter Rahmen
5. **Geöffnet, Daten vorhanden** → farbige Zelle, **auch bei 0%** (0 während der Öffnungszeit ist eine echte Information)

## Zugangsschutz

URL-Hash `#sauna2026` als Gate plus `noindex,nofollow` Meta. Kein echter Schutz, nur gegen Google-Indexierung und Zufallsfunde. Eine `robots.txt` gab es mal in der Planung, liegt aber aktuell **nicht** im Repo.

**Das Gate ist die häufigste Fehldiagnose.** Der Check steht als allererste Anweisung im Script und beendet es bei falschem Hash mit `throw new Error('auth')` — dargestellt wird dann nur „Zugang: URL mit korrektem Hash erforderlich", kein Fetch, keine Konsolenmeldung außer dem Throw. Eine „leere" oder „kaputte" Seite ist fast immer nur der fehlende Hash, nicht ein Deploy- oder API-Problem. Der Hash muss auch lokal dran: `file:///…/index.html#sauna2026`.

---

# Geteiltes Domänenwissen — Achtung Duplikat

Diese Informationen existieren **doppelt**, im Frontend als Konstanten und im Backend in `isSaunaOpen()`:

- Öffnungszeiten pro Sauna (`SAUNA_HRS`) — identisches Format in beiden Dateien
- Revisionstermine 2026 (`REVISION`) — **unterschiedliches Datumsformat**: Frontend `'13.04.2026'`, Backend `'2026-04-13'`. Beim Nachziehen nicht einfach kopieren
- Damenzeiten (`DAMEN`) — existieren **nur im Frontend**; das Backend kennt keine Damenzeiten und sammelt an Damentagen ganz normal weiter

Wenn sich eine Öffnungszeit oder ein Revisionstermin ändert, muss das an **beiden** Stellen nachgezogen werden. Sonst filtert das Frontend anders als das Backend alarmiert.

Bereits vorhandene Divergenzen (nicht versehentlich "wegräumen", ohne die Ursache zu klären):
- **Westbad-Revision endet unterschiedlich**: Frontend `01.09.2026`, Backend `2026-08-31`. Beides ist ohnehin eine Schätzung
- **Claudius Therme** existiert nur im Backend. Im Frontend fehlen `SAUNA_HRS`, `SAUNA_URL` und `DAMEN_TXT` dafür — die Sauna erscheint zwar in der Heatmap (Sheet-Daten), aber `saunaIsOpen()` liefert für unbekannte Namen pauschal `true`, also wird nichts als "geschlossen" ausgegraut. Auch der Name der Datei/UI sagt "München", Claudius liegt in Köln

Sonderfälle, die schon eingebaut sind und leicht übersehen werden:
- Müllersches Volksbad hat freitags nur bis 15:00 Damenzeit, nicht ganztägig
- Fresch hat Ladies Day am ersten Dienstag im Monat — wird nur als Textinfo angezeigt, nicht in der Heatmap ausgegraut, weil monatlich zu selten für eine Wochenraster-Darstellung
- Phoenixbad hat keinen Damentag, aber mittwochs Familientag bis 20:00 (kein Ausschlusskriterium)
- Westbad ist wegen Filteranlagen-Sanierung ab 27.04.2026 bis vermutlich Herbst geschlossen (Enddatum geschätzt auf 01.09.2026)

---

# Harte Constraints und Bug-Historie

## Datum und Zeit — hier steckten die meisten Fehler

- **`exDatum()` muss ISO-Strings über `new Date()` parsen**, nicht per String-Split. Google Sheets liefert UTC: `2026-04-03T22:00:00.000Z` ist in Berlin bereits der 4. April. String-Split ergibt den falschen Tag und verschiebt sämtliche Daten — das hat den Feiertagsfilter Samstage statt Karfreitage ausblenden lassen.
- **`DD.MM.YYYY`-Strings nie mit `<`/`>` vergleichen oder mit `.sort()` sortieren.** Das ist alphabetisch: `"01.05.2026" < "30.04.2026"` ist `true`. Dafür gibt es `cmpDe()` und `sortDeDates()`. Verstöße dagegen erzeugten Anzeigen wie „01.05.2026 – 30.04.2026" und falsche „letzter Datenpunkt"-Angaben.
- **Zeitrundung ist Abrunden, nicht Runden** (`floorT()`): Minuten ≥ 30 → `:30`, sonst `:00`. Ein Messwert von 07:46 gehört in den 07:30-Slot, weil die Sauna um 07:30 geöffnet hat.
- **Serverseitig** formatiert `doGet()` alle Date-Objekte mit `Utilities.formatDate(val, 'Europe/Berlin', 'yyyy-MM-dd HH:mm:ss')`. Ohne das kommen UTC-ISO-Strings beim Frontend an.

## Auslastung

Immer aus `Personen / Max Kapazität` berechnen, **nie** aus der vorberechneten `Auslastung %`-Spalte des Sheets. Die Spaltenbezeichnung schwankt zwischen `Max Kapazitaet` und `Max Kapazität` — `fCol()` matcht deshalb unscharf.

**Nicht alle Zeilen sind Personenzahlen.** Claudius Therme schreibt einen Ampel-Score in die Personen-Spalte (`score` 0–5, `maxScore` 5) — die Quelle liefert keine Kopfzahlen. Prozentwerte sind dort also grob gerastert (Schritte von 10 %), Absolutwerte bedeutungslos.

## Apps-Script-Deployment

- Es darf nur **eine** `doGet()`-Funktion im Script existieren
- Beim Redeploy immer die **bestehende Bereitstellung bearbeiten** (Stift-Icon → Neue Version). Niemals „Neue Bereitstellung" — das erzeugt eine neue URL, und das Frontend zeigt danach ins Leere
- Nach längeren Pausen kann der Sheet-Zugriff die Berechtigung verlieren („Das Dokument fehlt"). Fix: `doGet` einmal manuell im Editor ausführen und die Berechtigung neu erteilen

## Testing

Es gibt keine Testsuite. Externe Fetches sind in Sandbox-Umgebungen durch CSP geblockt — echtes Testen geht nur über die live GitHub-Pages-URL nach einem Push oder lokal im Browser mit geöffneter Datei. Backend-Funktionen werden über die `test*()`-Funktionen im Apps-Script-Editor geprüft, nicht von hier aus.

## Vorfälle, die sich nicht wiederholen sollen

**Rewrite-from-scratch hat Funktionen verschluckt.** Bei einer Neufassung des Apps Scripts fielen `fetchFresch()` und `doGet()` stillschweigend raus — beide Features waren danach tot, ohne Fehlermeldung. Bei Änderungen am Backend gilt: auf dem bestehenden Code aufbauen, nicht neu schreiben. Wenn ein Rewrite unvermeidbar ist, vorher die Funktionsliste des Originals durchgehen und danach abgleichen.

**Phoenixbad lieferte zwei Tage lang Nullen.** WP Rocket Caching servierte statisches HTML mit Platzhalterwerten, die echten Zahlen kamen per AJAX nach. Das Scraping las die Platzhalter. Deshalb jetzt der direkte AJAX-Endpoint. Fresch hat dasselbe Muster — auch dort wird die API direkt angesprochen statt HTML zu parsen.

**Inkrementelle Patches driften.** Nach vielen kleinen Edits am Frontend häuften sich Inkonsistenzen (verwaiste Variablennamen, tote Codepfade), bis nur ein sauberer Neuschrieb der Datei half. Bei größeren Umbauten lieber gleich zusammenhängend arbeiten.

---

# Konventionen

- **Versionskonstanten bei jeder Änderung hochzählen.** Jede der drei Dateien hat eine, weil man bei keiner von außen sieht, welcher Stand tatsächlich läuft:
  - `VERSION` in `index.html` → Fußzeile; zeigt, ob GitHub Pages schon die neue Fassung ausliefert
  - `TRACKER_VERSION` in `apps-script.gs` → Abschlusszeile jedes `fetchAll()`-Laufs
  - `CLEANSING_VERSION` in `cleansing.gs` → jede Logzeile und jeder Health-Log-Eintrag
  
  Bei den `.gs`-Dateien ist das die einzige Möglichkeit, eine Drift zwischen Repo-Kopie und Apps-Script-Projekt zu erkennen: `showVersions()` im Editor ausführen und mit dem Repo vergleichen. Stimmen die Nummern nicht überein, ist eine Seite nicht nachgezogen.
- Domänenwissen als Konstanten-Objekte oben im Script halten, nicht in die Renderlogik streuen
- Deutsche UI-Texte, deutsche Datumsformate

## Aufgehobener Constraint: ES5

Der Bestandscode ist durchgehend ES5 — `var`, `function`, ausschließlich einfache Anführungszeichen, keine Template Literals. Der Grund war rein logistisch: Das Deployment lief per Copy-Paste vom iPhone, und iOS ersetzt gerade Anführungszeichen durch typografische, was modernes JS sofort zerschießt.

Mit Git-Workflow existiert dieses Problem nicht mehr. **Neuer Code darf modernes JavaScript nutzen.** Ein Rewrite des Bestands ist nicht nötig, aber auch nicht verboten.

---

# Richtung

Genug Wochen Daten sammeln, um verlässliche Muster über Wochentage, Uhrzeiten und Saunen hinweg zu erkennen. Die Konfidenzanzeige existiert genau dafür — solange Zellen unter 10 Messpunkten liegen, sind die Empfehlungen nicht belastbar.