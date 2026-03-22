import { ANSI, formatInlineCode, getTerminalSeparator, stripAnsi } from "./ansi.js";

function isTableSeparatorLine(line) {
  return /^[\s|:-]+$/.test(line) && line.includes("-");
}

function parseTableRow(line) {
  const normalizedLine = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return normalizedLine.split("|").map((cell) => cell.trim());
}

function renderTable(lines) {
  const rows = lines.map(parseTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    const paddedRow = [...row];
    while (paddedRow.length < columnCount) {
      paddedRow.push("");
    }
    return paddedRow;
  });

  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...normalizedRows.map((row) => stripAnsi(formatInlineCode(row[columnIndex])).length))
  );

  const border = `${ANSI.gray}+${columnWidths.map((width) => "-".repeat(width + 2)).join("+")}+${ANSI.reset}`;
  const renderedRows = [border];

  normalizedRows.forEach((row, rowIndex) => {
    const formattedCells = row.map((cell, cellIndex) => {
      const formattedCell = formatInlineCode(cell);
      const visibleLength = stripAnsi(formattedCell).length;
      const paddedCell = `${formattedCell}${" ".repeat(columnWidths[cellIndex] - visibleLength)}`;
      if (rowIndex === 0) {
        return `${ANSI.bold}${ANSI.cyan}${paddedCell}${ANSI.reset}`;
      }
      return paddedCell;
    });

    renderedRows.push(`${ANSI.gray}|${ANSI.reset} ${formattedCells.join(` ${ANSI.gray}|${ANSI.reset} `)} ${ANSI.gray}|${ANSI.reset}`);

    if (rowIndex === 0) {
      renderedRows.push(border);
    }
  });

  renderedRows.push(border);
  return renderedRows;
}

export function formatMarkdownForTerminal(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const renderedLines = [];
  let inCodeBlock = false;
  let codeLanguage = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        renderedLines.push(`${ANSI.gray}${getTerminalSeparator()}${ANSI.reset}`);
        renderedLines.push("");
        inCodeBlock = false;
        codeLanguage = "";
      } else {
        codeLanguage = line.slice(3).trim();
        renderedLines.push("");
        renderedLines.push(`${ANSI.gray}${getTerminalSeparator()}${ANSI.reset}`);
        if (codeLanguage) {
          renderedLines.push(`${ANSI.gray}[${codeLanguage}]${ANSI.reset}`);
        }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      renderedLines.push(`${ANSI.green}  ${line}${ANSI.reset}`);
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparatorLine(lines[index + 1])) {
      const tableLines = [line];
      index += 2;

      while (index < lines.length && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }

      index -= 1;
      renderedLines.push("");
      renderedLines.push(...renderTable(tableLines));
      renderedLines.push("");
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      renderedLines.push("");
      renderedLines.push(`${ANSI.gray}${getTerminalSeparator()}${ANSI.reset}`);
      renderedLines.push("");
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      renderedLines.push("");
      renderedLines.push(`${ANSI.bold}${ANSI.cyan}${formatInlineCode(headingMatch[2].trim())}${ANSI.reset}`);
      renderedLines.push("");
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const indentation = listMatch[1];
      const marker = listMatch[2];
      const content = formatInlineCode(listMatch[3]);
      renderedLines.push(`${indentation}${ANSI.cyan}${marker}${ANSI.reset} ${content}`);
      continue;
    }

    renderedLines.push(formatInlineCode(line));
  }

  return renderedLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
