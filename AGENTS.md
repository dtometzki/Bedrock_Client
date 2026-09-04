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
6. Anschliessend ueber den Pull Request mergen, sobald alle erforderlichen
   CI-Pruefungen und Reviews erfolgreich abgeschlossen sind. Keine lokalen
   Merges mit anschliessendem Push auf `main` und kein Umgehen von Branch-Schutz,
   fehlgeschlagenen Checks oder vorgeschriebenen Freigaben.
7. Nach dem Merge den Status kontrollieren und dem Nutzer den Pull Request
   sowie das Ergebnis nennen. Wenn ein erforderlicher Check, ein Review oder
   eine Berechtigung fehlt, den konkreten offenen Punkt melden; nicht als
   gemergt ausgeben.

Auch Aenderungen an dieser Datei folgen diesem Workflow. Eine ausdrueckliche
Anweisung des Nutzers, beispielsweise nur einen Entwurf zu erstellen oder noch
nicht zu mergen, hat Vorrang.

## Pruefung und Sicherheit

- Bei Codeaenderungen `npm test` und `npm run lint` ausfuehren. Fuer behobene
  Fehler gezielte Regressionstests ergaenzen, wenn sie das fehlerhafte Verhalten
  sinnvoll absichern.
- Bei reinen Dokumentationsaenderungen Inhalt und `git diff --check` pruefen;
  vorgeschriebene CI-Pruefungen gelten weiterhin.
- Tests sollen keine echten AWS-Anfragen oder Kosten ausloesen. AWS-Aufrufe
  durch Test-Doubles ersetzen.
- Keine AWS-Zugangsdaten, Zugriffstoken oder privaten Chat-Verlaeufe committen.
- Aenderungen auf den Auftrag begrenzen und sachfremde Umbauten vermeiden.
