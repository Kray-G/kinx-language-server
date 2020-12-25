"use strict";

import {
    // CodeActionKind,
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    TextDocuments,
    TextDocumentSyncKind,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from 'fs'
import * as process from 'process'
import * as path from 'path'
import { URI } from 'vscode-uri'
import * as childProcess from 'child_process';

const is_windows = process.platform === 'win32';
// const is_mac     = process.platform === 'darwin';
// const is_linux   = process.platform === 'linux';

// namespace CommandIDs {
//     export const fix = "kinx.fix";
// }

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection();
connection.console.info(`Kinx server running in node ${process.version}`);
let documents!: TextDocuments<TextDocument>;

connection.onInitialize(() => {
    documents = new TextDocuments(TextDocument);
    setupDocumentsListeners();

    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Full,
                willSaveWaitUntil: false,
                save: {
                    includeText: false,
                },
            },
            // codeActionProvider: {
            //     codeActionKinds: [CodeActionKind.QuickFix],
            // },
            // executeCommandProvider: {
            //     commands: [CommandIDs.fix],
            // },
        },
    };
});

const tokenBuffer: any = {};

/**
 * Normal error message analysis.
 * @param diagnostics diagnostics array to be sent.
 * @param lineNumber line number of error.
 * @param srcbuf source code buffer.
 * @param errmsg actual error message.
 */
function normalCheck(diagnostics: Diagnostic[], lineNumber: number, srcbuf: string[], errmsg: string) {
    let srcline = srcbuf[lineNumber];
    if (srcline != null) {
        let re = new RegExp("[^\\s]");
        let result = re.exec(srcline);
        if (result != null) {
            let start = result.index;
            const range: Range = {
                start: { line: lineNumber, character: start < 0 ? 0 : start },
                end: { line: lineNumber, character: srcline.length },
            };
            const diagnostic: Diagnostic = Diagnostic.create(
                range,
                errmsg,
                DiagnosticSeverity.Error,
                "",
                "Compile Error",
            );
            diagnostics.push(diagnostic);
        }
    }
}

/**
 * Error in another file.
 * @param diagnostics diagnostics array to be sent.
 * @param symbolmap check to duplicate errors.
 * @param filename filename in error.
 * @param srcbuf source code buffer.
 * @param errmsg actual error message.
 */
function usingCheck(diagnostics: Diagnostic[], symbolmap: any, filename: string, srcbuf: string[], errmsg: string) {
    const usingfile = path.basename(filename).replace(/\.[^/.]+$/, "");
    for (let i = 0, l = srcbuf.length; i < l; ++i) {
        let srcline = srcbuf[i];
        let re = new RegExp("using\\s+" + usingfile + '\\s*;');
        let result = re.exec(srcline);
        if (result != null && result.index >= 0) {
            let key = "using:" + usingfile + ':' + i;
            if (symbolmap[key] == null) {
                symbolmap[key] = true;
                const range: Range = {
                    start: { line: i, character: result.index },
                    end: { line: i, character: result.index + result[0].length },
                };
                const diagnostic: Diagnostic = Diagnostic.create(
                    range,
                    errmsg,
                    DiagnosticSeverity.Error,
                    "",
                    "Compile Error",
                );
                diagnostics.push(diagnostic);
            }
            return;
        }
    }
}

/**
 *
 * @param diagnostics diagnostics array to be sent.
 * @param symbolmap check to duplicate errors.
 * @param symbol symbol name.
 * @param lineNumber line number of error.
 * @param srcbuf source code buffer.
 * @param errmsg actual error message.
 */
function symbolCheck(diagnostics: Diagnostic[], symbolmap: any, symbol: string, lineNumber: number, srcbuf: string[], errmsg: string) {
    let srcline = srcbuf[lineNumber];
    if (srcline != null) {
        let re = new RegExp("\\b" + symbol + "\\b", 'g');
        let found;
        while ((found = re.exec(srcline)) != null) {
            let index = found.index;
            const key = symbol + ":" + lineNumber + ":" + index;
            if (symbolmap[key] == null) {
                symbolmap[key] = true;
                const range: Range = {
                    start: { line: lineNumber, character: index },
                    end: { line: lineNumber, character: index + symbol.length },
                };
                const diagnostic: Diagnostic = Diagnostic.create(
                    range,
                    errmsg,
                    DiagnosticSeverity.Error,
                    "",
                    "Compile Error",
                );
                diagnostics.push(diagnostic);
            }
        }
    }
}

/**
 * Translate the name to the kind.
 * @param name the name.
 */
function getKindName(name: string) {
    switch (name) {
    case "var":   return "variable";
    case "class": return "class";
    case "module": return "class";
    case "function": return "function";
    case "public": return "function";
    case "private": return "function";
    case "native": return "function";
    default:
        ;
    }
    return "unknown";
}

/**
 * Search the text in the source code.
 * @param symbolmap check to duplicate the text.
 * @param text the text to be searched.
 * @param srcbuf source code buffer.
 * @param lineNumber line number of error.
 */
function searchName(symbolmap: any, text: string, srcbuf: string[], lineNumber: number, checkDup: boolean) {
    let srcline = srcbuf[lineNumber];
    if (srcline != null) {
        let re = new RegExp("\\b" + text + "\\b", 'g');
        let found;
        while ((found = re.exec(srcline)) != null) {
            let index = found.index;
            if (!checkDup) {
                return [index, index + text.length];
            }
            const key = text + ":" + lineNumber + ":" + index;
            if (symbolmap[key] == null) {
                symbolmap[key] = true;
                return [index, index + text.length];
            }
        }
    }
    return [-1, -1];
}

/**
 * Check the symbol location.
 * @param tokens result buffer.
 * @param symbolmap check to duplicate.
 * @param filename the filename of checking.
 * @param message actual message.
 * @param srcbuf source code buffer.
 */
function checkLocation(tokens: any, symbolmap: any, filename: string, message: string, srcbuf: string[]) {
    // console.log(message);
    let result = message.match(/#define\t(var|class|module|function|public|private|native)\t([^\t]+)\t([^\t]+)\t(\d+)/);
    if (result != null) {
        let kind = getKindName(result[1]);
        let text = result[2];
        let file = result[3];
        let lineNumber = parseInt(result[4]) - 1;
        if (filename === file) {
            let [start, end] = searchName(symbolmap, text, srcbuf, lineNumber, true);
            if (start >= 0 && end >= 0) {
                let data = {
                    "kind": kind, "text": text,
                    "location": { "uri": filename, "range": {
                        "start": { "line": lineNumber, "character": start },
                        "end": { "line": lineNumber, "character": end } } }
                };
                tokens.def.push(data);
                tokens.count[text+":"+lineNumber] = {
                    "count": 0,
                    "data": data,
                };
            }
        }
        return;
    }
    result = message.match(/#ref\tvar\t([^\t]+)\t([^\t]+)\t(\d+)\t([^\t]+)\t(\d+)/);
    if (result != null) {
        let kind = "variable";
        let text = result[1];
        let file1 = result[2];
        let lineNumber1 = parseInt(result[3]) - 1;
        let file2 = result[4];
        let lineNumber2 = parseInt(result[5]) - 1;
        if (filename === file1) {
            let [start1, end1] = searchName(symbolmap, text, srcbuf, lineNumber1, true);
            if (filename === file2) {
                let [start2, end2] = searchName(symbolmap, text, srcbuf, lineNumber2, false);
                if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                    let data = {
                        "kind": kind, "text": text,
                        "location": { "uri": filename, "range": {
                            "start": { "line": lineNumber1, "character": start1 },
                            "end": { "line": lineNumber1, "character": end1 } } },
                        "definition": { "uri": filename, "range": {
                            "start": { "line": lineNumber2, "character": start2 },
                            "end": { "line": lineNumber2, "character": end2 } } }
                    };
                    tokens.ref.push(data);
                    if (tokens.count[text+":"+lineNumber2] != null) {
                        tokens.count[text+":"+lineNumber2].count++;
                    }
                }
            } else {
                let code = fs.readFileSync(file2, "utf8");
                let codebuf = code.split(/\r?\n/);
                let [start2, end2] = searchName(symbolmap, text, codebuf, lineNumber2, false);
                if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                    let data = {
                        "kind": kind, "text": text,
                        "location": { "uri": filename, "range": {
                            "start": { "line": lineNumber1, "character": start1 },
                            "end": { "line": lineNumber1, "character": end1 } } },
                        "definition": { "uri": file2, "range": {
                            "start": { "line": lineNumber2, "character": start2 },
                            "end": { "line": lineNumber2, "character": end2 } } }
                    };
                    tokens.ref.push(data);
                }
            }
        }
        return;
    }
    return;
}

/**
 * Parameter analysis
 * @param uri uri string
 */
function setOptions(uristring: string) {
    let fspath = URI.parse(uristring).fsPath;
    let filename = path.basename(fspath);
    let diropt = '--workdir=' + path.dirname(fspath);
    let fileopt = '--filename=' + filename;
    if (is_windows) {
        fileopt = '"' + fileopt + '"';
        diropt = '"' + diropt + '"';
    }
    return [filename, fileopt, diropt];
}

/**
 * Do compile the code
 * @param src source code string
 */
function compile(tokens: any, diagnostics: Diagnostic[], url: string, src: string)
{
    const symbolmap: any = {};
    let [filename, fileopt, diropt] = setOptions(url);
    const buf = childProcess.execSync('kinx.exe -ic --output-location --error-code=0 ' + fileopt + ' ' + diropt, { timeout: 10000, input: src + '\n__END__' });
    const msgs = buf.toString();
    const srcbuf = src.split(/\r?\n/);
    const msgbuf = msgs.split(/\r?\n/);
    for (let i = 0, l = msgbuf.length; i < l; ++i) {
        let errmsg = msgbuf[i];
        if (errmsg.length > 0 && errmsg.charAt(0) == '#') {
            checkLocation(tokens, symbolmap, filename, errmsg, srcbuf);
            continue;
        }
        let result = errmsg.match(/Symbol\(([^\)]+)\).+?<([^>]+)>:(\d+)/);
        if (result == null) {
            result = errmsg.match(/.+?<([^>]+)>:(\d+)/);
            if (result != null) {
                let file = result[1];
                if (file === filename) {
                    normalCheck(diagnostics, parseInt(result[2]) - 1, srcbuf, errmsg);
                } else {
                    usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
                }
            }
        } else {
            let file = result[2];
            if (file === filename) {
                symbolCheck(diagnostics, symbolmap, result[1], parseInt(result[3]) - 1, srcbuf, errmsg);
            } else {
                usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
            }
        }
    }
}

/**
 * Analyzes the text document for problems.
 * @param doc text document to analyze
 */
function validate(doc: TextDocument) {
    let tokens: any = { ref: [], def: [], count: {} };
    tokenBuffer[doc.uri.toString()] = tokens;
    const diagnostics: Diagnostic[] = [];
    compile(tokens, diagnostics, doc.uri, doc.getText());
    for (let info of Object.keys(tokens.count).map(k => tokens.count[k])) {
        if (info.count == 0) {
            const diagnostic: Diagnostic = Diagnostic.create(
                info.data.location.range,
                "The variable(" + info.data.text + ") is defined but not used.",
                DiagnosticSeverity.Warning,
                "",
                "Semantics Check",
            );
            diagnostics.push(diagnostic);
        }
    }
    // console.log(JSON.stringify(tokens.count));
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

function setupDocumentsListeners() {
    documents.listen(connection);

    documents.onDidOpen((event) => {
        validate(event.document);
    });

    documents.onDidChangeContent((change) => {
        validate(change.document);
    });

    documents.onDidClose((close) => {
        connection.sendDiagnostics({ uri: close.document.uri, diagnostics: []});
    });

}

// Listen on the connection
connection.listen();
