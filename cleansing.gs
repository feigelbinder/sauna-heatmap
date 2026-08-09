// ============================================
// DATA CLEANSING fuer "Saunen Auslastung"
// ============================================
// Ergaenzungsdatei zum Tracker. Enthaelt bewusst KEIN doGet() und
// ueberschreibt keine bestehende Funktion -- einfach als zusaetzliche
// Script-Datei ins Apps-Script-Projekt einfuegen.
//
// GRUNDPRINZIP: Es wird NICHTS geloescht. Das Script schreibt eine
// zusaetzliche Spalte "Qualitaet" ans Ende des Sheets und traegt dort pro
// Zeile einen Befund ein. Dadurch ist der Lauf beliebig oft wiederholbar,
// jederzeit nachvollziehbar und bei geaenderten Regeln einfach neu zu
// rechnen. Das Filtern passiert im Frontend anhand dieser Spalte.
//
// Warum kein Loeschen: die Rohwerte sind die einzige Quelle, aus der sich
// spaeter erkennen laesst, WARUM ein Tag fehlt. Einmal geloescht ist die
// Unterscheidung zwischen "Sauna war leer" und "Datenquelle war kaputt"
// unwiederbringlich weg.
//
// ANWENDUNG:
//   previewCleansing()  -> zeigt im Log, was passieren wuerde (schreibt nicht)
//   cleanseData()       -> schreibt die Qualitaets-Spalte
//   setupCleansingTrigger() -> taeglich 03:00 automatisch
//
// Die Befunde im Einzelnen:
//   OK                  unauffaellig
//   AUSSERHALB          ausserhalb der Oeffnungszeit (inkl. Revision)
//   TAG_OHNE_BETRIEB    an dem Tag durchgehend 0 waehrend der Oeffnungszeit
//   SPAET_AUF           Nullserie am Tagesanfang, danach echter Betrieb
//   FRUEH_ZU            Nullserie am Tagesende
//   QUELLE_EINGEFROREN  mehrere Saunen desselben Betreibers gleichzeitig
//                       auf demselben Wert eingefroren
//   ZU_WENIG_MESSUNGEN  zu wenige Messungen am Tag fuer eine Beurteilung
// ============================================

// Bei jeder Aenderung hochzaehlen. Die Version steht in jeder Logzeile und in
// jedem Health-Log-Eintrag -- nur so laesst sich pruefen, ob die Fassung im
// Apps-Script-Projekt noch der Kopie im Repo entspricht. showVersions()
// ausfuehren und mit dem Repo vergleichen.
var CLEANSING_VERSION = 'v1.0';

var Q_HEADER = 'Qualitaet';

// Nullserie am Rand ab dieser Laenge = Sauna hat spaeter geoeffnet bzw.
// frueher geschlossen. 3 Slots = 1,5 Stunden. Darunter ueberwiegen echte
// Leerlaufphasen: die Verteilung der Randnullen faellt nach 2 Slots steil ab.
var EDGE_ZERO_SLOTS = 3;

// Mindestzahl Messungen an einem Tag, damit der Tag beurteilt wird.
var MIN_READINGS_PER_DAY = 6;

// Eingefrorene Quelle: ab so vielen identischen Messungen in Folge
// verdaechtig -- aber nur, wenn gleichzeitig mindestens FREEZE_MIN_SAUNAS
// Saunen desselben Betreibers einfrieren. Ein einzelner konstanter Wert ist
// KEIN Fehler: eine ruhige Sauna steht stundenlang bei 2 Gaesten, und die
// Ampel der Claudius Therme kennt ohnehin nur 11 Stufen. Erst die
// Gleichzeitigkeit ueber mehrere Saunen belegt einen Cache auf Quellenseite.
var FREEZE_MIN_RUN = 10;
var FREEZE_MIN_SAUNAS = 2;

// Phoenixbad, Fresch und Claudius sind je die einzige Sauna ihres Betreibers --
// die Gleichzeitigkeitspruefung kann dort nie greifen. Fuer diese Faelle gilt
// ersatzweise: eingefroren UND der Wert liegt ueber dem FREEZE_HIGH_FACTOR-
// fachen des ueblichen Niveaus dieser Sauna (Median aller Werte > 0). Eine
// ruhige Sauna friert bei 2 Gaesten ein, ein Cache haelt den Spitzenwert fest.
// Genau so sah der Phoenixbad-Bug aus: 186 bis 319 Personen ueber Stunden bei
// einem Median von 28.
var FREEZE_HIGH_FACTOR = 2;

// Spaltenindizes im Daten-Sheet (0-basiert), wie von fetchAll() geschrieben
var C_TIMESTAMP = 0, C_DATUM = 1, C_UHRZEIT = 3, C_BETREIBER = 4;
var C_SAUNA = 5, C_PERSONEN = 6, C_MAX = 7;


/**
 * Hauptfunktion: analysiert das gesamte Daten-Sheet und schreibt die
 * Qualitaets-Spalte neu. Idempotent -- mehrfaches Ausfuehren aendert nichts.
 */
function cleanseData() {
  runCleansing_(false);
}

/**
 * Trockenlauf: identische Analyse, schreibt aber nichts ins Sheet.
 * Vor dem ersten echten Lauf und nach jeder Regelaenderung sinnvoll.
 */
function previewCleansing() {
  runCleansing_(true);
}


function runCleansing_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" nicht gefunden');

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log('Keine Daten.');
    return;
  }

  var headers = data[0];
  var qCol = headers.indexOf(Q_HEADER);          // 0-basiert, -1 = fehlt
  var appendCol = (qCol === -1) ? headers.length : qCol;

  // ---- Schritt 1: Zeilen einlesen und nach (Sauna, Datum) gruppieren ----
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var ts = toDate_(r[C_TIMESTAMP]);
    var persons = r[C_PERSONEN];
    var max = r[C_MAX];
    var sauna = r[C_SAUNA];

    if (!ts || !sauna || typeof persons !== 'number' || typeof max !== 'number' || max <= 0) {
      rows.push({ idx: i, skip: true, flag: 'UNVOLLSTAENDIG' });
      continue;
    }

    rows.push({
      idx: i,
      skip: false,
      sauna: sauna,
      betreiber: r[C_BETREIBER],
      dateKey: Utilities.formatDate(ts, 'Europe/Berlin', 'yyyy-MM-dd'),
      time: Utilities.formatDate(ts, 'Europe/Berlin', 'HH:mm'),
      persons: persons,
      open: isSaunaOpen(sauna, ts),
      flag: 'OK'
    });
  }

  var groups = {};
  for (var j = 0; j < rows.length; j++) {
    var row = rows[j];
    if (row.skip) continue;
    if (!row.open) { row.flag = 'AUSSERHALB'; continue; }
    var key = row.sauna + '|' + row.dateKey;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  // ---- Schritt 2: Tagesbefunde ----
  var freezeRuns = [];   // fuer die betreiberweite Pruefung in Schritt 3
  var stats = {};

  for (var key in groups) {
    var day = groups[key];
    day.sort(function(a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });

    if (day.length < MIN_READINGS_PER_DAY) {
      mark_(day, 0, day.length, 'ZU_WENIG_MESSUNGEN', stats);
      continue;
    }

    var allZero = true;
    for (var k = 0; k < day.length; k++) {
      if (day[k].persons !== 0) { allZero = false; break; }
    }
    if (allZero) {
      mark_(day, 0, day.length, 'TAG_OHNE_BETRIEB', stats);
      continue;
    }

    // Nullserie am Anfang / Ende
    var lead = 0;
    while (lead < day.length && day[lead].persons === 0) lead++;
    var trail = 0;
    while (trail < day.length && day[day.length - 1 - trail].persons === 0) trail++;

    if (lead >= EDGE_ZERO_SLOTS) mark_(day, 0, lead, 'SPAET_AUF', stats);
    if (trail >= EDGE_ZERO_SLOTS) mark_(day, day.length - trail, day.length, 'FRUEH_ZU', stats);

    // Eingefrorene Serien einsammeln (noch nicht bewerten)
    var runStart = 0;
    for (var m = 1; m <= day.length; m++) {
      var same = (m < day.length) &&
                 (day[m].persons === day[m - 1].persons) &&
                 (day[m].persons > 0);
      if (!same) {
        if (m - runStart >= FREEZE_MIN_RUN && day[runStart].persons > 0) {
          freezeRuns.push({
            betreiber: day[runStart].betreiber,
            sauna: day[runStart].sauna,
            dateKey: day[runStart].dateKey,
            from: day[runStart].time,
            to: day[m - 1].time,
            rows: day.slice(runStart, m)
          });
        }
        runStart = m;
      }
    }
  }

  // ---- Schritt 3: eingefrorene Serien bewerten ----
  // Betreiber mit mehreren Saunen: Gleichzeitigkeit entscheidet.
  // Betreiber mit nur einer Sauna: Hoehe des eingefrorenen Werts entscheidet.
  var saunenProBetreiber = {};
  var werteProSauna = {};
  for (var s1 = 0; s1 < rows.length; s1++) {
    var rr = rows[s1];
    if (rr.skip) continue;
    if (!saunenProBetreiber[rr.betreiber]) saunenProBetreiber[rr.betreiber] = {};
    saunenProBetreiber[rr.betreiber][rr.sauna] = true;
    if (rr.persons > 0) {
      if (!werteProSauna[rr.sauna]) werteProSauna[rr.sauna] = [];
      werteProSauna[rr.sauna].push(rr.persons);
    }
  }

  for (var f = 0; f < freezeRuns.length; f++) {
    var a = freezeRuns[f];
    var verdaechtig = false;

    if (countKeys_(saunenProBetreiber[a.betreiber] || {}) >= FREEZE_MIN_SAUNAS) {
      var partners = {};
      for (var g = 0; g < freezeRuns.length; g++) {
        if (f === g) continue;
        var b = freezeRuns[g];
        if (b.betreiber !== a.betreiber || b.dateKey !== a.dateKey) continue;
        if (b.sauna === a.sauna) continue;
        if (a.from <= b.to && b.from <= a.to) partners[b.sauna] = true;   // Ueberlappung
      }
      verdaechtig = (countKeys_(partners) + 1 >= FREEZE_MIN_SAUNAS);
    } else {
      var med = median_(werteProSauna[a.sauna] || []);
      verdaechtig = (med > 0 && a.rows[0].persons > med * FREEZE_HIGH_FACTOR);
    }

    if (verdaechtig) {
      for (var h = 0; h < a.rows.length; h++) {
        // Randbefunde nicht ueberschreiben, die sind spezifischer
        if (a.rows[h].flag === 'OK') a.rows[h].flag = 'QUELLE_EINGEFROREN';
      }
    }
  }

  // ---- Schritt 4: Ergebnis ----
  var out = [];
  var changed = 0;
  out.push([Q_HEADER]);
  var byIdx = {};
  for (var n = 0; n < rows.length; n++) byIdx[rows[n].idx] = rows[n];
  for (var i2 = 1; i2 < data.length; i2++) {
    var rec = byIdx[i2];
    var flag = rec ? rec.flag : 'UNVOLLSTAENDIG';
    var before = (qCol === -1) ? '' : data[i2][qCol];
    if (before !== flag) changed++;
    out.push([flag]);
    stats[flag] = stats[flag] || 0;
  }

  // Zaehlung sauber ueber die Ausgabe, nicht ueber die Zwischenschritte
  var counts = {};
  for (var o = 1; o < out.length; o++) counts[out[o][0]] = (counts[out[o][0]] || 0) + 1;

  var lines = [];
  var total = out.length - 1;
  var keys = Object.keys(counts).sort(function(x, y) { return counts[y] - counts[x]; });
  for (var q = 0; q < keys.length; q++) {
    lines.push('  ' + pad_(keys[q], 22) + pad_(String(counts[keys[q]]), 8) +
               (counts[keys[q]] / total * 100).toFixed(1) + '%');
  }

  Logger.log('cleansing.gs ' + CLEANSING_VERSION +
             (dryRun ? ' [TROCKENLAUF]' : '') + ' -- Befunde ueber ' + total + ' Zeilen:');
  Logger.log(lines.join('\n'));
  Logger.log('Geaenderte Zellen gegenueber dem letzten Lauf: ' + changed);

  if (dryRun) {
    Logger.log('Trockenlauf -- es wurde nichts geschrieben. cleanseData() fuehrt es aus.');
    return;
  }

  sheet.getRange(1, appendCol + 1, out.length, 1).setValues(out);
  if (qCol === -1) {
    sheet.getRange(1, appendCol + 1).setFontWeight('bold')
         .setBackground('#4a86c8').setFontColor('#ffffff');
    sheet.setColumnWidth(appendCol + 1, 170);
  }

  logCleansing_(counts, total, changed);
}


// =====================
// HILFSFUNKTIONEN
// =====================

function mark_(day, from, to, flag, stats) {
  for (var i = from; i < to; i++) {
    day[i].flag = flag;
    stats[flag] = (stats[flag] || 0) + 1;
  }
}

function median_(arr) {
  if (!arr.length) return 0;
  var a = arr.slice().sort(function(x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function countKeys_(o) {
  var c = 0;
  for (var k in o) if (o.hasOwnProperty(k)) c++;
  return c;
}

function pad_(s, n) {
  while (s.length < n) s += ' ';
  return s;
}

/**
 * Die Timestamp-Spalte enthaelt gemischte Typen: ueberwiegend echte
 * Date-Zellen, aber rund 240 Zeilen liegen als Text "dd.MM.yyyy HH:mm:ss"
 * vor. Beides muss hier ankommen.
 */
function toDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], m[6] ? +m[6] : 0);
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function logCleansing_(counts, total, changed) {
  var sheet = getOrCreateLogSheet();
  var parts = [];
  for (var k in counts) parts.push(k + '=' + counts[k]);
  sheet.appendRow([
    new Date(),
    Utilities.formatDate(new Date(), 'Europe/Berlin', 'dd.MM.yyyy HH:mm'),
    '(alle)',
    'CLEANSING ' + CLEANSING_VERSION,
    total + ' Zeilen geprueft, ' + changed + ' Befunde geaendert | ' + parts.join(', ')
  ]);
}

/**
 * Loggt die Versionen beider Script-Dateien. Zum Abgleich mit dem Repo:
 * stimmen die Nummern nicht ueberein, ist eine Seite nicht nachgezogen.
 */
function showVersions() {
  Logger.log('apps-script.gs  ' + (typeof TRACKER_VERSION === 'undefined' ? '(fehlt)' : TRACKER_VERSION));
  Logger.log('cleansing.gs    ' + CLEANSING_VERSION);
}


// =====================
// TRIGGER
// =====================

/**
 * Taeglicher Lauf um 03:00. Bewusst nachts: der Lauf liest das komplette
 * Sheet und beurteilt ganze Tage -- am laufenden Tag waeren die Befunde
 * ohnehin noch unvollstaendig.
 */
function setupCleansingTrigger() {
  var trigs = ScriptApp.getProjectTriggers();
  for (var i = 0; i < trigs.length; i++) {
    if (trigs[i].getHandlerFunction() === 'cleanseData') ScriptApp.deleteTrigger(trigs[i]);
  }
  ScriptApp.newTrigger('cleanseData').timeBased().atHour(3).nearMinute(0).everyDays(1).create();
  Logger.log('Cleansing-Trigger aktiv: taeglich 03:00');
}
