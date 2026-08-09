// ============================================
// doGet() – API Endpoint fuer Heatmap Dashboard
// Gibt alle Daten zurueck (oder optional ?days=N)
// ============================================
function doGet(e) {
  var ss = SpreadsheetApp.openById('1PCvPFyERck2HMAF2W5HBqccXq1nGsmrUpNos-e4if5M');
  var sheet = ss.getSheets().filter(function(s) {
    return s.getSheetId() == 372330793;
  })[0] || ss.getSheets()[0];
  
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  
  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var val = data[r][c];
      if (val instanceof Date) {
        obj[headers[c]] = Utilities.formatDate(val, 'Europe/Berlin', 'yyyy-MM-dd HH:mm:ss');
      } else {
        obj[headers[c]] = val;
      }
    }
    rows.push(obj);
  }

  return ContentService
    .createTextOutput(JSON.stringify(rows))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================
// Fresch Freising – Sauna Auslastung via Gips API
// ============================================
var FRESCH_URL = 'https://www.fresch-freising.de/freisingGips/Gips?SessionMandant=Freising&Anwendung=CMSWebpageElement&Methode=ShowHTMLAusgabe&RessourceID=1269655&Call.KeepLastSessionAnwendung=J&nocache=';
var FRESCH_SAUNA_MAX = 150;

function fetchFresch() {
  try {
    var url = FRESCH_URL + new Date().getTime();
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var content = response.getContentText().trim();
    
    if (content.length === 0) {
      Logger.log('Fresch: Leere Antwort');
      return null;
    }
    
    var obj = JSON.parse(content);
    if (obj != null && obj.ZoneUsages != null) {
      for (var i = 0; i < obj.ZoneUsages.length; i++) {
        if (obj.ZoneUsages[i].Name == 'Sauna') {
          var current = obj.ZoneUsages[i].Current;
          return {
            currentPersons: current,
            maxCapacity: FRESCH_SAUNA_MAX,
            occupancyPercent: Math.round((current / FRESCH_SAUNA_MAX) * 100)
          };
        }
      }
    }
    
    Logger.log('Fresch: Keine Sauna-Zone gefunden in: ' + content.substring(0, 500));
    return null;
  } catch (e) {
    Logger.log('Fresch Fehler: ' + e.message);
    return null;
  }
}

function testFresch() {
  var result = fetchFresch();
  Logger.log('Fresch Sauna: ' + JSON.stringify(result));
}

function debugFreschAPI() {
  var response = UrlFetchApp.fetch(FRESCH_URL, { muteHttpExceptions: true });
  var html = response.getContentText();
  
  var scripts = html.match(/<script[^>]*src=['"]([^'"]+)['"]/gi) || [];
  Logger.log('=== SCRIPT TAGS ===');
  for (var i = 0; i < scripts.length; i++) {
    Logger.log(scripts[i]);
  }
  
  var patterns = [
    /https?:\/\/[^\s'"<>]+(?:counter|auslastung|capacity|occupancy|visitor|gate)[^\s'"<>]*/gi,
    /(?:fetch|ajax|XMLHttpRequest|\.get|\.post)\s*\(\s*['"]([^'"]+)['"]/gi,
    /(?:api|endpoint|dataUrl|url)\s*[:=]\s*['"]([^'"]+)['"]/gi
  ];
  
  Logger.log('=== API URLS ===');
  for (var i = 0; i < patterns.length; i++) {
    var matches = html.match(patterns[i]) || [];
    for (var j = 0; j < matches.length; j++) {
      Logger.log(matches[j]);
    }
  }
  
  var block = html.match(/Auslastung[\s\S]{0,500}?100\s*%/i);
  if (block) {
    Logger.log('=== AUSLASTUNG BLOCK ===');
    Logger.log(block[0]);
  }
}


// ============================================
// Muenchen Saunen Auslastungs-Tracker v3
// Alle 7 SWM Saunen + Phoenixbad + Fresch
// MIT FAIL-SAFES & ALERTING
// ============================================
// Anleitung:
// 1. ALERT_EMAIL anpassen
// 2. "fetchAll" einmal manuell ausfuehren (Berechtigung erteilen)
// 3. "setupTriggers" einmal ausfuehren
//
// Zum Stoppen: "removeTriggers" ausfuehren
// ============================================

var ALERT_EMAIL = "DEINE_EMAIL@gmail.com";  // <-- ANPASSEN!

var SHEET_NAME = "Saunen Auslastung";
var SHEET_LOG = "Health Log";
var INTERVAL_MINUTES = 30;

// Nach 2x hintereinander 0 Personen -> Alert (= 1 Stunde bei 30-Min-Intervall)
var ZERO_STREAK_THRESHOLD = 2;

// ---- SWM Saunen ----
// SWM hat die Migration von Ticos auf den eigenen Endpoint abgeschlossen.
// .rest/bath/visitorCount liefert alle Baeder in EINEM Call, Zuordnung per areaId.
//
// ACHTUNG Ticos: Der alte Endpoint ist tot, faellt aber nicht aus. Er antwortet
// weiterhin mit HTTP 200 und personCount:0 fuer JEDE Sauna. Als Fallback ist er
// damit schaedlich - er hat fuer Cosimawellenbad (ab 20.06.2026) und Nordbad
// (ab 06.06.2026) monatelang Nullen ins Sheet geschrieben, jeweils ab dem
// Revisionstermin der Sauna. Deshalb KEIN Ticos-Fallback mehr: lieber NO_DATA
// loggen als eine Null erfinden. Konstante bleibt nur fuer testSWM() stehen.
var SWM_REST_API = "https://www.swm.de/.rest/bath/visitorCount";
var SWM_TICOS_API = "https://counter.ticos-systems.cloud/api/gates/counter";  // tot, s.o.
var SWM_SAUNAS = [
  { name: "Cosimawellenbad",       areaId: 75, ticosId: "30191" },
  { name: "Dantebad",              areaId: 33, ticosId: "30200" },
  { name: "Michaelibad",           areaId: 9,  ticosId: "30203" },
  { name: "Muellersches Volksbad", areaId: 87, ticosId: "30204" },
  { name: "Nordbad",               areaId: 63, ticosId: "30185" },
  { name: "Suedbad",               areaId: 81, ticosId: "30188" },
  { name: "Westbad",               areaId: 18, ticosId: "30207" }
];

// ---- Phoenixbad (AJAX Endpoint) ----
var PHOENIX_AJAX = "https://phoenixbad.de/wp-admin/admin-ajax.php";

// ---- Claudius Therme Koeln (HTML Gaeste-Ampel) ----
var CLAUDIUS_URL = "https://www.claudius-therme.de/";

// ---- Oeffnungszeiten pro Sauna (aus WebApp uebernommen) ----
// Format: {def: ['HH:MM','HH:MM']} oder pro Wochentag {Montag: [...], ...}
var SAUNA_HRS = {
  Cosimawellenbad:        { def: ['09:00','23:00'] },
  Dantebad:               { def: ['07:30','23:00'] },
  Michaelibad:            { def: ['07:30','23:00'] },
  'Muellersches Volksbad':{ def: ['09:00','23:00'] },
  Nordbad:                { def: ['07:30','23:00'] },
  Suedbad:                { def: ['09:00','23:00'] },
  Westbad:                { def: ['07:30','23:00'] },
  'Phoenixbad Sauna':     {
    Montag:['09:00','23:00'], Dienstag:['09:00','23:00'],
    Mittwoch:['09:00','23:00'], Donnerstag:['09:00','23:00'],
    Freitag:['09:00','23:30'], Samstag:['08:00','23:30'],
    Sonntag:['08:00','23:00']
  },
  'Fresch Sauna':         { def: ['09:00','22:00'] },
  'Claudius Therme':      { def: ['09:00','24:00'] }
};

// ---- Revisionszeiten 2026 (Sauna komplett geschlossen) ----
// Format: [Name, Von (inkl.), Bis (inkl.)]
var REVISION = [
  ['Dantebad',               '2026-04-13', '2026-04-30'],
  ['Westbad',                '2026-04-27', '2026-08-31'],
  ['Michaelibad',            '2026-04-27', '2026-05-11'],
  ['Suedbad',                '2026-05-11', '2026-05-24'],
  ['Muellersches Volksbad',  '2026-05-25', '2026-06-08'],
  ['Nordbad',                '2026-06-08', '2026-06-22'],
  ['Cosimawellenbad',        '2026-06-22', '2026-07-06']
];


/**
 * Prueft ob eine Sauna zu einem gegebenen Zeitpunkt geoeffnet ist.
 * Beruecksichtigt individuelle Oeffnungszeiten UND Revisionszeiten.
 * @param {string} saunaName - Name der Sauna (wie in SWM_SAUNAS/Sheet)
 * @param {Date} dateTime - Zeitpunkt (als Date-Objekt)
 * @returns {boolean}
 */
function isSaunaOpen(saunaName, dateTime) {
  var dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  var berlinDay = Utilities.formatDate(dateTime, "Europe/Berlin", "u"); // 1=Mo .. 7=So
  var dayIndex = parseInt(berlinDay) % 7; // convert to JS: 0=So, 1=Mo...
  var dayName = dayNames[dayIndex];
  var timeStr = Utilities.formatDate(dateTime, "Europe/Berlin", "HH:mm");
  var dateStr = Utilities.formatDate(dateTime, "Europe/Berlin", "yyyy-MM-dd");

  // 1. Revision-Check: komplett geschlossen?
  for (var i = 0; i < REVISION.length; i++) {
    if (REVISION[i][0] === saunaName && dateStr >= REVISION[i][1] && dateStr <= REVISION[i][2]) {
      return false;
    }
  }

  // 2. Oeffnungszeiten-Check
  var hrs = SAUNA_HRS[saunaName];
  if (!hrs) return true; // unbekannte Sauna -> kein Filter

  var schedule = hrs[dayName] || hrs.def;
  if (!schedule) return true;

  return timeStr >= schedule[0] && timeStr < schedule[1];
}


/**
 * Hauptfunktion: Alle Saunen abfragen und ins Sheet schreiben
 */
function fetchAll() {
  var now = new Date();
  var dateStr = Utilities.formatDate(now, "Europe/Berlin", "dd.MM.yyyy");
  var weekday = Utilities.formatDate(now, "Europe/Berlin", "EEEE");
  var time = Utilities.formatDate(now, "Europe/Berlin", "HH:mm");
  var sheet = getOrCreateSheet();
  var rows = [];
  var issues = [];

  // --- SWM Saunen ---
  // Schritt 1: Neuen REST-Endpoint EINMAL abfragen (liefert alle Baeder).
  // Daraus eine Map areaId -> {current, max} bauen.
  var swmAreaMap = {};
  try {
    var restResp = UrlFetchApp.fetch(SWM_REST_API, { muteHttpExceptions: true });
    if (restResp.getResponseCode() === 200) {
      var restJson = JSON.parse(restResp.getContentText());
      if (restJson && restJson.data) {
        for (var li = 0; li < restJson.data.length; li++) {
          var areaList = restJson.data[li].area_list || [];
          for (var ai = 0; ai < areaList.length; ai++) {
            swmAreaMap[areaList[ai].area_id] = {
              current: areaList[ai].customer_amount,
              max: areaList[ai].customer_amount_max
            };
          }
        }
      }
    } else {
      issues.push({ sauna: "SWM REST", type: "HTTP_ERROR", detail: "Status " + restResp.getResponseCode() });
    }
  } catch (e) {
    issues.push({ sauna: "SWM REST", type: "EXCEPTION", detail: e.message });
  }

  // Schritt 2: Pro Sauna aus der Map lesen. Kein Ticos-Fallback (s. Kommentar
  // bei SWM_SAUNAS) - fehlende Daten werden als NO_DATA geloggt, nicht als 0.
  for (var i = 0; i < SWM_SAUNAS.length; i++) {
    var s = SWM_SAUNAS[i];
    try {
      var current = null;
      var max = null;

      if (s.areaId != null && swmAreaMap[s.areaId]) {
        current = swmAreaMap[s.areaId].current;
        max = swmAreaMap[s.areaId].max;
      }

      if (current == null || max == null) {
        issues.push({
          sauna: s.name,
          type: "NO_DATA",
          detail: "REST lieferte keine Daten fuer area " + s.areaId
        });
        continue;
      }

      rows.push([
        now, dateStr, weekday, time,
        "SWM", s.name,
        current, max,
        max > 0 ? Math.round((current / max) * 100) : 0
      ]);

    } catch (e) {
      issues.push({
        sauna: s.name,
        type: "EXCEPTION",
        detail: e.message
      });
    }
  }

  // --- Phoenixbad via AJAX ---
  // Phoenixbad-Endpoint liefert gecachte Daten ausserhalb der Oeffnungszeiten,
  // daher nur abfragen wenn geoeffnet
  if (isSaunaOpen("Phoenixbad Sauna", now)) {
    try {
      var phoenix = fetchPhoenixbad();
      if (phoenix) {
        rows.push([
          now, dateStr, weekday, time,
          "Phoenixbad", "Phoenixbad Sauna",
          phoenix.currentPersons, phoenix.maxCapacity, phoenix.occupancyPercent
        ]);
      } else {
        issues.push({
          sauna: "Phoenixbad Sauna",
          type: "PARSE_ERROR",
          detail: "Konnte Daten nicht extrahieren"
        });
      }
    } catch (e) {
      issues.push({
        sauna: "Phoenixbad Sauna",
        type: "EXCEPTION",
        detail: e.message
      });
    }
  }

  // --- Fresch Freising via Gips API ---
  if (isSaunaOpen("Fresch Sauna", now)) {
    try {
      var fresch = fetchFresch();
      if (fresch) {
        rows.push([
          now, dateStr, weekday, time,
          "Fresch Freising", "Fresch Sauna",
          fresch.currentPersons, fresch.maxCapacity, fresch.occupancyPercent
        ]);
      } else {
        issues.push({
          sauna: "Fresch Sauna",
          type: "PARSE_ERROR",
          detail: "Konnte Daten nicht extrahieren"
        });
      }
    } catch (e) {
      issues.push({
        sauna: "Fresch Sauna",
        type: "EXCEPTION",
        detail: e.message
      });
    }
  }

  // --- Claudius Therme Koeln via HTML Gaeste-Ampel ---
  if (isSaunaOpen("Claudius Therme", now)) {
    try {
      var claudius = fetchClaudius();
      if (claudius) {
        rows.push([
          now, dateStr, weekday, time,
          "Claudius Therme", "Claudius Therme",
          claudius.score, claudius.maxScore, claudius.occupancyPercent
        ]);
      } else {
        issues.push({
          sauna: "Claudius Therme",
          type: "PARSE_ERROR",
          detail: "Gaeste-Ampel nicht parsebar"
        });
      }
    } catch (e) {
      issues.push({
        sauna: "Claudius Therme",
        type: "EXCEPTION",
        detail: e.message
      });
    }
  }

  // --- Daten schreiben ---
  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
         .setValues(rows);
  }

  // --- Fail-Safe Check ---
  checkZeroStreaks(sheet);

  // --- Issues loggen ---
  if (issues.length > 0) {
    logIssues(now, issues);
  }

  Logger.log(rows.length + "/" + (SWM_SAUNAS.length + 3) +
             " Saunen erfasst, " + issues.length + " Issues | " +
             dateStr + " " + time);
}


// =====================
// PHOENIXBAD (AJAX statt HTML-Scrape)
// =====================

function fetchPhoenixbad() {
  var url = PHOENIX_AJAX + "?action=updateLiveVisitors&area=Sauna";
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    Logger.log("Phoenixbad HTTP " + response.getResponseCode());
    return null;
  }

  var html = response.getContentText();
  var freeMatch = html.match(/data-free="(\d+)"/);
  var pctMatch = html.match(/width:\s*([\d.]+)%/);

  if (!freeMatch || !pctMatch) {
    Logger.log("Phoenixbad Parse-Fehler. HTML: " + html.substring(0, 200));
    return null;
  }

  var freeSpots = parseInt(freeMatch[1]);
  var occupancyPct = parseFloat(pctMatch[1]);

  var maxCapacity;
  if (occupancyPct === 0) {
    maxCapacity = freeSpots;
  } else {
    maxCapacity = Math.round(freeSpots / (1 - occupancyPct / 100));
  }

  return {
    freeSpots: freeSpots,
    currentPersons: maxCapacity - freeSpots,
    maxCapacity: maxCapacity,
    occupancyPercent: Math.round(occupancyPct)
  };
}


// =====================
// CLAUDIUS THERME (HTML Gaeste-Ampel)
// 5 Anker-Icons: full/half/empty, serverseitig gerendert
// Score 0-5 in 0.5er Schritten, gemappt auf 0-100%
// =====================

function fetchClaudius() {
  var response = UrlFetchApp.fetch(CLAUDIUS_URL, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    Logger.log("Claudius HTTP " + response.getResponseCode());
    return null;
  }

  var html = response.getContentText();

  // HTML-Kommentare zaehlen: "full anchor", "half anchor", "empty anchor"
  var fullCount = (html.match(/<!-- full anchor/g) || []).length;
  var halfCount = (html.match(/<!-- half anchor/g) || []).length;

  // Score: full=1, half=0.5 (von max 5)
  var score = fullCount + (halfCount * 0.5);
  var maxScore = 5;
  var occupancyPercent = Math.round((score / maxScore) * 100);

  // Textuellen Status extrahieren (niedrig/mittel/hoch/etc.)
  var statusMatch = html.match(/Gästeaufkommen\s+(\w+)/i) ||
                    html.match(/G.steaufkommen\s+(\w+)/i);
  var statusText = statusMatch ? statusMatch[1] : "unbekannt";

  Logger.log("Claudius: " + score + "/5 (" + statusText + ") = " + occupancyPercent + "%");

  return {
    score: score,
    maxScore: maxScore,
    occupancyPercent: occupancyPercent,
    statusText: statusText
  };
}


// =====================
// FAIL-SAFE: Zero-Streak Detection
// Alarmiert wenn eine Sauna 2x hintereinander 0 Personen meldet,
// aber NUR wenn die Sauna laut Oeffnungszeiten auch offen sein sollte.
// Beruecksichtigt individuelle Oeffnungszeiten + Revisionszeiten.
// =====================

function checkZeroStreaks(sheet) {
  var now = new Date();

  var data = sheet.getDataRange().getValues();
  if (data.length < ZERO_STREAK_THRESHOLD + 1) return;

  var allSaunaNames = SWM_SAUNAS.map(function(s) { return s.name; });
  allSaunaNames.push("Phoenixbad Sauna");
  allSaunaNames.push("Fresch Sauna");
  allSaunaNames.push("Claudius Therme");

  var alerts = [];

  allSaunaNames.forEach(function(saunaName) {
    // Ist diese Sauna JETZT ueberhaupt geoeffnet?
    if (!isSaunaOpen(saunaName, now)) return;

    // Letzte N Eintraege fuer diese Sauna finden
    var entries = [];
    for (var i = data.length - 1; i >= 1 && entries.length < ZERO_STREAK_THRESHOLD; i--) {
      if (data[i][5] === saunaName) {
        entries.push({
          persons: data[i][6],
          time: data[i][3],
          timestamp: data[i][0]
        });
      }
    }

    if (entries.length >= ZERO_STREAK_THRESHOLD) {
      // Nur Eintraege zaehlen die waehrend der Oeffnungszeit waren
      var openEntries = entries.filter(function(e) {
        if (e.timestamp instanceof Date) {
          return isSaunaOpen(saunaName, e.timestamp);
        }
        return true; // im Zweifel zaehlen
      });

      if (openEntries.length >= ZERO_STREAK_THRESHOLD) {
        var allZero = openEntries.every(function(e) { return e.persons === 0; });
        if (allZero) {
          alerts.push(saunaName + " (" + ZERO_STREAK_THRESHOLD +
                       "x in Folge 0 Personen waehrend Oeffnungszeit, letzte: " +
                       openEntries[0].time + ")");
        }
      }
    }
  });

  if (alerts.length > 0) {
    sendAlert(
      "Null-Streak erkannt",
      "Folgende Saunen melden waehrend ihrer Oeffnungszeiten " +
      "wiederholt 0 Personen. Moeglicherweise ist die Datenquelle defekt:\n\n" +
      alerts.join("\n") +
      "\n\nPruefe die Datenquellen und aktualisiere ggf. das Script."
    );
  }
}


// =====================
// TAEGLICHER HEALTH CHECK (laeuft 1x taeglich um 23:30)
// =====================

function dailyHealthCheck() {
  var sheet = getOrCreateSheet();
  var data = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), "Europe/Berlin", "dd.MM.yyyy");

  var allSaunaNames = SWM_SAUNAS.map(function(s) { return s.name; });
  allSaunaNames.push("Phoenixbad Sauna");
  allSaunaNames.push("Fresch Sauna");
  allSaunaNames.push("Claudius Therme");

  var todayCounts = {};
  var todayZeros = {};

  allSaunaNames.forEach(function(name) {
    todayCounts[name] = 0;
    todayZeros[name] = 0;
  });

  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === today) {
      var name = data[i][5];
      if (todayCounts.hasOwnProperty(name)) {
        todayCounts[name]++;
        if (data[i][6] === 0) todayZeros[name]++;
      }
    }
  }

  var lines = [];
  var hasIssue = false;
  var today_iso = Utilities.formatDate(new Date(), "Europe/Berlin", "yyyy-MM-dd");

  allSaunaNames.forEach(function(name) {
    var total = todayCounts[name];
    var zeros = todayZeros[name];
    var status = "OK";

    // Ist die Sauna gerade in Revision? Dann ist 0 = normal
    var inRevision = false;
    for (var i = 0; i < REVISION.length; i++) {
      if (REVISION[i][0] === name && today_iso >= REVISION[i][1] && today_iso <= REVISION[i][2]) {
        inRevision = true;
        break;
      }
    }

    if (inRevision) {
      status = "IN REVISION (erwartet)";
    } else if (total === 0) {
      status = "KEINE DATEN";
      hasIssue = true;
    } else if (zeros / total > 0.5) {
      status = "VERDAECHTIG (" + zeros + "/" + total + " Nullwerte)";
      hasIssue = true;
    }

    lines.push(name + ": " + total + " Messungen, " + zeros + " Nullwerte -> " + status);
  });

  if (hasIssue) {
    sendAlert(
      "Tagesbericht " + today,
      "Health Check fuer heute:\n\n" + lines.join("\n") +
      "\n\nSaunen mit KEINE DATEN oder VERDAECHTIG brauchen Aufmerksamkeit."
    );
  }

  logHealthCheck(today, todayCounts, todayZeros, allSaunaNames);
}


// =====================
// HEALTH LOG SHEET
// =====================

function logIssues(timestamp, issues) {
  var sheet = getOrCreateLogSheet();
  issues.forEach(function(issue) {
    sheet.appendRow([
      timestamp,
      Utilities.formatDate(timestamp, "Europe/Berlin", "HH:mm"),
      issue.sauna,
      issue.type,
      issue.detail
    ]);
  });
}

function logHealthCheck(dateStr, counts, zeros, names) {
  var sheet = getOrCreateLogSheet();
  names.forEach(function(name) {
    var status = "OK";
    if (counts[name] === 0) {
      status = "KEINE_DATEN";
    } else if (zeros[name] / counts[name] > 0.5) {
      status = "VERDAECHTIG";
    }
    sheet.appendRow([
      new Date(), dateStr, name,
      "HEALTH_CHECK",
      "Messungen: " + counts[name] + ", Nullwerte: " + zeros[name] + " -> " + status
    ]);
  });
}

function getOrCreateLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOG);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_LOG);
    var headers = ["Timestamp", "Uhrzeit/Datum", "Sauna", "Typ", "Detail"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(1, 1, 1, headers.length).setBackground("#cc4125");
    sheet.getRange(1, 1, 1, headers.length).setFontColor("#ffffff");
    sheet.getRange("A:A").setNumberFormat("dd.MM.yyyy HH:mm:ss");
    sheet.setFrozenRows(1);
  }

  return sheet;
}


// =====================
// ALERTING
// =====================

function sendAlert(subject, body) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "alert_" + subject.replace(/[^a-zA-Z]/g, "").substring(0, 30);

  if (cache.get(cacheKey)) {
    Logger.log("Alert unterdrueckt (bereits heute gesendet): " + subject);
    return;
  }

  try {
    MailApp.sendEmail({
      to: ALERT_EMAIL,
      subject: "[Sauna-Tracker] " + subject,
      body: body +
            "\n\n---\n" +
            "Gesendet: " + Utilities.formatDate(new Date(), "Europe/Berlin", "dd.MM.yyyy HH:mm") +
            "\nSheet: " + SpreadsheetApp.getActiveSpreadsheet().getUrl()
    });

    cache.put(cacheKey, "sent", 72000);
    Logger.log("Alert gesendet: " + subject);

  } catch (e) {
    Logger.log("Alert konnte nicht gesendet werden: " + e.message);
  }
}


// =====================
// DATEN-SHEET
// =====================

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var headers = [
      "Timestamp", "Datum", "Wochentag", "Uhrzeit",
      "Betreiber", "Sauna", "Personen", "Max Kapazitaet", "Auslastung %"
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(1, 1, 1, headers.length).setBackground("#4a86c8");
    sheet.getRange(1, 1, 1, headers.length).setFontColor("#ffffff");
    sheet.getRange("A:A").setNumberFormat("dd.MM.yyyy HH:mm:ss");
    sheet.setFrozenRows(1);

    var widths = [160, 100, 100, 70, 100, 170, 80, 110, 100];
    for (var i = 0; i < widths.length; i++) {
      sheet.setColumnWidth(i + 1, widths[i]);
    }
  }

  return sheet;
}


// =====================
// TRIGGER SETUP
// =====================

/**
 * Alle Trigger einrichten - EINMAL manuell ausfuehren!
 *   1. Datenerfassung alle 30 Min
 *   2. Taeglicher Health Check um 23:30
 */
function setupTriggers() {
  removeTriggers();

  ScriptApp.newTrigger("fetchAll")
    .timeBased()
    .everyMinutes(INTERVAL_MINUTES)
    .create();

  ScriptApp.newTrigger("dailyHealthCheck")
    .timeBased()
    .atHour(23)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log("Trigger aktiv: Daten alle " + INTERVAL_MINUTES +
             " Min + Health Check taeglich 23:30");
  fetchAll();
}

/**
 * Alle Trigger entfernen = Tracking stoppen
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log("Alle Trigger entfernt");
}


// =====================
// TEST-FUNKTIONEN
// =====================

function testPhoenixbad() {
  var result = fetchPhoenixbad();
  Logger.log("Phoenixbad: " + JSON.stringify(result));
}

function testClaudius() {
  var result = fetchClaudius();
  Logger.log("Claudius Therme: " + JSON.stringify(result));
}

function testSWM() {
  // Zeigt fuer jede SWM-Sauna welche Quelle greift und welcher Wert kommt
  var swmAreaMap = {};
  var restResp = UrlFetchApp.fetch(SWM_REST_API, { muteHttpExceptions: true });
  if (restResp.getResponseCode() === 200) {
    var restJson = JSON.parse(restResp.getContentText());
    (restJson.data || []).forEach(function(loc) {
      (loc.area_list || []).forEach(function(a) {
        swmAreaMap[a.area_id] = { current: a.customer_amount, max: a.customer_amount_max };
      });
    });
  }
  SWM_SAUNAS.forEach(function(s) {
    if (s.areaId != null && swmAreaMap[s.areaId]) {
      var m = swmAreaMap[s.areaId];
      Logger.log(s.name + ": REST area " + s.areaId + " -> " + m.current + "/" + m.max);
    } else if (s.ticosId) {
      var t = UrlFetchApp.fetch(SWM_TICOS_API + "?organizationUnitIds=" + s.ticosId, { muteHttpExceptions: true });
      var td = JSON.parse(t.getContentText());
      var v = (td && td.length > 0) ? td[0].personCount + "/" + td[0].maxPersonCount : "KEINE DATEN";
      Logger.log(s.name + ": Ticos " + s.ticosId + " -> " + v);
    } else {
      Logger.log(s.name + ": KEINE QUELLE");
    }
  });
}

function testAlert() {
  sendAlert("Test-Alert", "Das ist ein Test. Wenn du das liest, funktioniert das Alerting.");
}