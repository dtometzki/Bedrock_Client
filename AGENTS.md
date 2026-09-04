# Arbeitsregeln fuer dieses Repository

Diese Regeln gelten fuer alle Aenderungen im Repository, einschliesslich Code,
Tests, Dokumentation und Konfiguration.

## Verbindlicher Branch- und Pull-Request-Workflow

1. Vor jeder Aenderung den Git-Status pruefen. Vorhandene Aenderungen des Nutzers
   erhalten und nicht ungefragt in eigene Commits aufnehmen.
2. Fuer jeden eigenstaendigen Aenderungsauftrag einen separaten Branch mit einem
   aussagekraeftigen Namen unter `codex/` anlegen, zum Beispiel
   `codex/fix-chat-validation`. Von der aktuellen Zielbranch-Version ausgehen;
   standardmaessig ist die Zielbranch `main`. Einen bereits zum selben Auftrag
   gehoerenden Arbeitsbranch weiterverwenden.
3. Alle Anpassungen und Commits ausschliesslich auf diesem Arbeitsbranch
   durchfuehren. Keine direkten Aenderungen, Commits oder Pushes auf `main`
   oder andere geschuetzte Branches.
4. Die Aenderungen pruefen, auf dem Arbeitsbranch committen und diesen pushen.
5. Einen Pull Request gegen die Zielbranch erstellen. Titel und Beschreibung
   muessen Problem, Loesung und durchgefuehrte Pruefungen nachvollziehbar nennen.
6. Den PR zur persoenlichen Pruefung durch den Nutzer offen lassen. Den Branch,
   aktuellen Commit und passende manuelle Testschritte mit erwarteten Ergebnissen
   nennen. Bei reinen Dokumentationsaenderungen genuegt die inhaltliche Pruefung
   durch den Nutzer. Die lokale Arbeitskopie auf dem PR-Branch fuer seinen Test
   bereithalten, sofern der Nutzer nichts anderes wuenscht.
7. Erst mergen, nachdem der Nutzer den aktuellen PR-Stand selbst getestet bzw.
   geprueft und den Merge ausdruecklich freigegeben hat. Gruene CI, eigene
   Agententests, Schweigen oder eine fruehere Freigabe fuer einen anderen Stand
   ersetzen diese Freigabe nicht. Nach weiteren Aenderungen erneut zur Pruefung
   vorlegen. Kein Auto-Merge aktivieren und keine Automationen einrichten, die
   diese Freigabe umgehen.
8. Zusaetzlich muessen alle erforderlichen CI-Pruefungen und Reviews erfolgreich
   abgeschlossen sein. Ausschliesslich ueber den PR mergen und dabei pruefen,
   dass dessen aktueller Head-Commit dem freigegebenen Stand entspricht. Keine
   lokalen Merges mit anschliessendem Push auf `main` und kein Umgehen von
   Branch-Schutz, fehlgeschlagenen Checks oder vorgeschriebenen Freigaben.
9. Nach dem Merge den Status kontrollieren und dem Nutzer den Pull Request
   sowie das Ergebnis nennen. Wenn ein erforderlicher Check, ein Review oder
   eine Berechtigung fehlt, den konkreten offenen Punkt melden; nicht als
   gemergt ausgeben.
10. Nach bestaetigtem PR-Merge kann der zugehoerige Arbeitsbranch lokal und auf
    dem Remote bereinigt werden. Zuerst auf die Zielbranch wechseln und den
    gemergten Stand per Fast-forward uebernehmen. Vor dem Loeschen sicherstellen,
    dass keine ungesicherten Aenderungen, nicht uebernommenen Folge-Commits,
    weiteren offenen PRs oder aktiven Worktrees auf diesen Branch angewiesen
    sind. Nur den abgeschlossenen Arbeitsbranch loeschen; `main` und andere
    geschuetzte Branches behalten. Bei Unsicherheit den Branch stehen lassen.

Auch Aenderungen an dieser Datei folgen diesem Workflow. Eine ausdrueckliche
Anweisung des Nutzers, beispielsweise nur einen Entwurf zu erstellen oder noch
nicht zu mergen, hat Vorrang.

## Architektur und Wartbarkeit

- Native ES-Module und die unterstuetzten Node-Versionen beibehalten: mindestens
  Node 20; CI prueft Node 20 und 22. Keine APIs einfuehren, die auf einer dieser
  Versionen fehlen.
- Gemeinsame Bedrock-, Stream-, Verlaufs- und Nutzungslogik in den vorhandenen
  Modulen halten. CLI und Weboberflaeche sollen bei Fehlern, Abbruch, Verlauf und
  Kostenberechnung konsistent bleiben; keine zweite Implementierung duplizieren.
- Neue Abhaengigkeiten nur mit konkretem Nutzen hinzufuegen. Bei Updates auch
  `package-lock.json` aktualisieren. Gebuendelte Dateien unter `src/web/vendor/`
  nicht manuell patchen; nachvollziehbare Upstream-Versionen mit Lizenzhinweisen
  verwenden und Sicherheitsupdates nicht allein auf `npm audit` stuetzen, da
  diese Dateien nicht als npm-Abhaengigkeiten erfasst sind.
- Aenderungen auf den Auftrag begrenzen. Bestehende CLI-Optionen, gespeicherte
  Einstellungen und Session-Dateien kompatibel halten; notwendige Migrationen
  explizit behandeln. Geaendertes Nutzerverhalten in der README dokumentieren.

## Sicherheitsregeln

- Webzugriff standardmaessig auf Loopback begrenzen. Token-, Host- und
  Origin-Pruefungen sowie CSP und Sicherheitsheader nicht abschwaechen. Neue
  API-Routen mit Zugriff auf Nutzerdaten oder AWS muessen authentifiziert sein.
- Request-URLs und JSON-Felder vor der Verarbeitung validieren: Typen, Laengen,
  erlaubte Werte und Groessenlimits pruefen, statt beliebige Objekte mit
  `String(...)` zu konvertieren. Ungueltige Eingaben mit einem passenden 4xx-Status
  ablehnen; sie duerfen weder den Prozess beenden noch die Sitzung blockieren.
- Modellantworten, Dateinamen und externe Fehlermeldungen als nicht
  vertrauenswuerdig behandeln. Im Browser `textContent` oder die vorhandene
  Markdown-Bereinigung nutzen; im Terminal Steuersequenzen entfernen. Keine
  ungeprueften Inhalte an `innerHTML` oder eine Shell uebergeben.
- Anhangauswahl, Dateitypen, Anzahl, Base64-Inhalte und Groesse serverseitig
  pruefen. Keine beliebigen Dateipfade aus HTTP-Anfragen lesen. Keine Remote-
  Ressourcen aus Modellantworten automatisch laden.
- AWS-Credentials auf der Serverseite und in der SDK-Provider-Chain belassen.
  Keine Zugangsdaten, Zugriffstoken oder privaten Chat-Verlaeufe in Commits,
  Logs, Fehlermeldungen oder PR-Beschreibungen aufnehmen. Profil- und
  Regionswechsel duerfen keine Clients mit veralteten Credentials weiterverwenden.

## Fehlerbehandlung und Datenhaltung

- Sperren und Abbruchzustand mit `try/finally` ueber den gesamten Ablauf
  zuruecksetzen, einschliesslich Validierung und Vorbereitung. Parallele Anfragen,
  Verbindungsabbruch und unvollstaendige Streams beruecksichtigen.
- AWS-Aufrufe abbrechbar halten. Retries begrenzen und nur bei passenden
  transienten Fehlern durchfuehren; nach begonnener Modellausgabe nicht automatisch
  dieselbe Anfrage erneut senden. Doppelte Antworten und unnoetige Kosten vermeiden.
- Vertrauliche Dateien atomar und auf POSIX mit privaten Rechten speichern
  (Dateien `0600`, neue Konfigurationsverzeichnisse `0700`). Schreib- und
  Loeschfehler sichtbar melden, auch wenn Hilfsfunktionen nur `false` liefern.
- Bei gescheitertem Speichern eine erhaltene Antwort behalten und vor fehlender
  Persistenz warnen. Eine fehlgeschlagene Loeschung nicht als Erfolg anzeigen;
  gespeicherte Daten und sichtbaren Zustand konsistent behandeln.
- Verlaufs- und Anhangslimits erhalten. Aenderungen an Modellen, Inferenzparametern
  oder Preisen auf Auswirkungen auf Kontextgroesse, Region und Kosten pruefen.
  Kostenschaetzungen weiterhin klar von tatsaechlichen Billing-Daten unterscheiden.

## Pruefung und Uebergabe

- Bei Codeaenderungen `npm test` und `npm run lint` ausfuehren. Fuer behobene
  Fehler gezielte Regressionstests ergaenzen, wenn sie das fehlerhafte Verhalten
  sinnvoll absichern.
- Bei reinen Dokumentationsaenderungen Inhalt und `git diff --check` pruefen;
  vorgeschriebene CI-Pruefungen gelten weiterhin.
- Automatisierte Tests sollen keine echten AWS-Anfragen oder Kosten ausloesen.
  AWS-Aufrufe durch Test-Doubles ersetzen. Temporaere Konfigurationsverzeichnisse
  verwenden und Umgebungsvariablen sowie Mocks danach wiederherstellen.
- Bei betroffenen Fehlerpfaden auch pruefen, dass die naechste gueltige Anfrage
  wieder funktioniert und vorhandene Daten erhalten bleiben. Relevante Faelle
  sind ungueltige Eingaben, Authentifizierung, parallele Anfragen, Stream-Abbruch
  und Dateisystemfehler; keine Tests schreiben, die nur Implementierungsdetails
  nachbilden.
- Testergebnisse ehrlich berichten: durchgefuehrte, fehlgeschlagene oder durch
  die Umgebung blockierte Pruefungen unterscheiden. Ein Sandbox-Fehler ist kein
  nachgewiesener Produktfehler und kein erfolgreicher Test.
- Zur Uebergabe PR-Link, Commit, relevante Aenderungen und kurze manuelle
  Testschritte nennen. Falls ein vorgeschlagener manueller Test AWS aufruft,
  darauf hinweisen. Den PR bis zur ausdruecklichen Freigabe nach dem Nutzertest
  offen lassen.
