import { ANSI, formatInlineCode, getTerminalSeparator, stripAnsi } from "./ansi.js";

const TABLE_SEPARATOR_REGEX = /^[\s|:-]+$/;
const TABLE_ROW_TRIM_REGEX = /^\||\|$/g;
const HORIZONTAL_RULE_REGEX = /^\s*---+\s*$/;
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;
const LIST_REGEX = /^(\s*)([-*+]|\d+\.)\s+(.+)$/;
const NEWLINE_CRLF_REGEX = /\r\n/g;
const MULTIPLE_NEWLINES_REGEX = /\n{3,}/g;

/**
 * Checks if a string line is a table separator line.
 * @param {string} line The line to check.
 * @returns {boolean} True if it is a separator line.
 */
function isTableSeparatorLine(line) {
  return TABLE_SEPARATOR_REGEX.test(line) && line.includes("-");
}

/**
 * Parses a markdown table row into an array of cells.
 * @param {string} line The table row string.
 * @returns {string[]} The cell contents.
 */
function parseTableRow(line) {
  const normalizedLine = line.trim().replace(TABLE_ROW_TRIM_REGEX, "");
  return normalizedLine.split("|").map((cell) => cell.trim());
}

/**
 * Renders a markdown table into terminal-formatted strings.
 * @param {string[]} lines The lines constituting the table.
 * @returns {string[]} Rendered terminal lines.
 */
function renderTable(lines) {
  const rows = lines.map(parseTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));

  // Optimization: Pad rows without repeatedly cloning and pushing
  const normalizedRows = rows.map((row) => {
    if (row.length === columnCount) return row;
    const paddedRow = new Array(columnCount).fill("");
    for (let i = 0; i < row.length; i++) {
      paddedRow[i] = row[i];
    }
    return paddedRow;
  });

  // Calculate visible widths
  const columnWidths = new Array(columnCount).fill(0);
  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
    const row = normalizedRows[rowIndex];
    for (let colIndex = 0; colIndex < columnCount; colIndex++) {
      const visibleLength = stripAnsi(formatInlineCode(row[colIndex])).length;
      if (visibleLength > columnWidths[colIndex]) {
        columnWidths[colIndex] = visibleLength;
      }
    }
  }

  const border = `${ANSI.gray}+${columnWidths.map((width) => "-".repeat(width + 2)).join("+")}+${ANSI.reset}`;
  const renderedRows = [border];

  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
    const row = normalizedRows[rowIndex];
    const formattedCells = new Array(columnCount);

    for (let cellIndex = 0; cellIndex < columnCount; cellIndex++) {
      const cell = row[cellIndex];
      const formattedCell = formatInlineCode(cell);
      const visibleLength = stripAnsi(formattedCell).length;
      const paddedCell = `${formattedCell}${" ".repeat(columnWidths[cellIndex] - visibleLength)}`;

      if (rowIndex === 0) {
        formattedCells[cellIndex] = `${ANSI.bold}${ANSI.cyan}${paddedCell}${ANSI.reset}`;
      } else {
        formattedCells[cellIndex] = paddedCell;
      }
    }

    renderedRows.push(
      `${ANSI.gray}|${ANSI.reset} ${formattedCells.join(` ${ANSI.gray}|${ANSI.reset} `)} ${ANSI.gray}|${ANSI.reset}`
    );

    if (rowIndex === 0) {
      renderedRows.push(border);
    }
  }

  renderedRows.push(border);
  return renderedRows;
}

/**
 * Formats Markdown text for display in the terminal.
 * @param {string} text The Markdown text.
 * @returns {string} The formatted terminal output.
 */
export function formatMarkdownForTerminal(text) {
  const lines = text.replace(NEWLINE_CRLF_REGEX, "\n").split("\n");
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

    if (HORIZONTAL_RULE_REGEX.test(line)) {
      renderedLines.push("");
      renderedLines.push(`${ANSI.gray}${getTerminalSeparator()}${ANSI.reset}`);
      renderedLines.push("");
      continue;
    }

    const headingMatch = HEADING_REGEX.exec(line);
    if (headingMatch) {
      renderedLines.push("");
      renderedLines.push(
        `${ANSI.bold}${ANSI.cyan}${formatInlineCode(headingMatch[2].trim())}${ANSI.reset}`
      );
      renderedLines.push("");
      continue;
    }

    const listMatch = LIST_REGEX.exec(line);
    if (listMatch) {
      const indentation = listMatch[1];
      const marker = listMatch[2];
      const content = formatInlineCode(listMatch[3]);
      renderedLines.push(`${indentation}${ANSI.cyan}${marker}${ANSI.reset} ${content}`);
      continue;
    }

    renderedLines.push(formatInlineCode(line));
  }

  return renderedLines.join("\n").replace(MULTIPLE_NEWLINES_REGEX, "\n\n").trimEnd();
}
