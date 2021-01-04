"use strict";

import {
    // CodeActionKind,
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    Position,
    ProposedFeatures,
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
import { SemanticTokensBuilder } from "vscode-languageserver/lib/sematicTokens.proposed";

const is_windows = process.platform === 'win32';
// const is_mac     = process.platform === 'darwin';
// const is_linux   = process.platform === 'linux';

// namespace CommandIDs {
//     export const fix = "kinx.fix";
// }

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
connection.console.info(`Kinx server running in node ${process.version}`);
let documents!: TextDocuments<TextDocument>;

connection.onInitialize(() => {
    documents = new TextDocuments(TextDocument);
    setupDocumentsListeners();

    return {
        capabilities: {
            definitionProvider: true,
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Full,
                willSaveWaitUntil: false,
                save: {
                    includeText: false,
                },
            },
            semanticTokensProvider: {
                full: true,
                range: false,
                legend: {
                    tokenTypes: [ "comment" ],
                    tokenModifiers: [],
                }
            }
            // codeActionProvider: {
            //     codeActionKinds: [CodeActionKind.QuickFix],
            // },
            // executeCommandProvider: {
            //     commands: [CommandIDs.fix],
            // },
        },
    };
});

class KinxLanguageServer {

    tokenBuffer_: any;
    semanticCheck_: any;

    constructor() {
        this.tokenBuffer_ = {};
        this.semanticCheck_ = {};
    }

    public getSemanticCheckedTokens(uri: string) {
        return this.semanticCheck_[uri];
    }

    /**
     * Normal error message analysis.
     * @param diagnostics diagnostics array to be sent.
     * @param lineNumber line number of error.
     * @param srcbuf source code buffer.
     * @param errmsg actual error message.
     */
    private normalCheck(diagnostics: Diagnostic[], lineNumber: number, srcbuf: string[], errmsg: string) {
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
    private usingCheck(diagnostics: Diagnostic[], symbolmap: any, filename: string, srcbuf: string[], errmsg: string) {
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
    private symbolCheck(diagnostics: Diagnostic[], symbolmap: any, symbol: string, lineNumber: number, srcbuf: string[], errmsg: string) {
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
    private getKindName(name: string) {
        switch (name) {
        case "var":      return "variable";
        case "class":    return "class";
        case "module":   return "class";
        case "function": return "function";
        case "public":   return "function";
        case "private":  return "function";
        case "native":   return "function";
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
    private searchName(symbolmap: any, text: string, srcbuf: string[], lineNumber: number, checkDup: boolean) {
        let srcline = srcbuf[lineNumber];
        if (srcline != null) {
            let line = srcline.replace(/"(\\"|[^"])+?"|'(\\'|[^'])+?'/g, (match) => ' '.repeat(match.length));
            let re = new RegExp("\\b" + text + "\\b", 'g');
            let found;
            while ((found = re.exec(line)) != null) {
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

    private checkFilePath(dirname: string, candidate: string) {
        let fspath = path.join(dirname, candidate);
        try {
            if (fs.existsSync(fspath)) {
                return fspath;
            }
        } catch {
            ;
        }
        return candidate;
    }

    /**
     * Check the symbol location.
     * @param tokens result buffer.
     * @param symbolmap check to duplicate.
     * @param filename the filename of checking.
     * @param message actual message.
     * @param srcbuf source code buffer.
     */
    private checkLocation(tokens: any, symbolmap: any, filename: string, dirname: string, message: string, srcbuf: string[]) {
        // console.log(message);
        let result = message.match(/#define\t(var|class|module|function|public|private|native)\t([^\t]+)\t([^\t]+)\t(\d+)/);
        if (result != null) {
            let kind = this.getKindName(result[1]);
            let text = result[2];
            let file = result[3];
            let lineNumber = parseInt(result[4]) - 1;
            if (kind == "function") {
                let prev = tokens.def[tokens.def.length - 1];
                if (prev && prev.text == text) {
                    tokens.def.pop();
                    prev = tokens.def[tokens.def.length - 1];
                    if (prev && prev.text == text) {
                        tokens.def.pop();
                    }
                }
                delete tokens.count[text+":"+lineNumber];
                return;
            }
            if (filename === file) {
                let [start, end] = this.searchName(symbolmap, text, srcbuf, lineNumber, true);
                if (start >= 0 && end >= 0) {
                    let data = {
                        kind: kind, text: text,
                        location: { uri: URI.file(filename).toString(), range: {
                            start: { line: lineNumber, character: start },
                            end: { line: lineNumber, character: end } } }
                    };
                    tokens.def.push(data);
                    tokens.count[text+":"+lineNumber] = {
                        count: 0,
                        data: data,
                    };
                }
            }
            return;
        }
        result = message.match(/#ref\tvar\t([^\t]+)\t([^\t]+)\t(\d+)\t([^\t]+)\t(\d+)/);
        if (result != null) {
            let filepath = path.join(dirname, filename);
            let kind = "variable";
            let text = result[1];
            let file1 = result[2];
            let lineNumber1 = parseInt(result[3]) - 1;
            let file2 = result[4];
            let lineNumber2 = parseInt(result[5]) - 1;
            if (filename === file1) {
                let [start1, end1] = this.searchName(symbolmap, text, srcbuf, lineNumber1, true);
                if (filename === file2) {
                    let [start2, end2] = this.searchName(symbolmap, text, srcbuf, lineNumber2, false);
                    if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                        let data = {
                            kind: kind, text: text,
                            location: { uri: URI.file(filepath).toString(), range: {
                                start: { line: lineNumber1, character: start1 },
                                end: { line: lineNumber1, character: end1 } } },
                            definition: { uri: URI.file(filepath).toString(), range: {
                                start: { line: lineNumber2, character: start2 },
                                end: { line: lineNumber2, character: end2 } } }
                        };
                        tokens.ref.push(data);
                        if (tokens.count[text+":"+lineNumber2] != null) {
                            tokens.count[text+":"+lineNumber2].count++;
                        }
                    }
                } else {
                    file2 = this.checkFilePath(dirname, result[4]);
                    let code = fs.readFileSync(file2, "utf8");
                    let codebuf = code.split(/\r?\n/);
                    let [start2, end2] = this.searchName(symbolmap, text, codebuf, lineNumber2, false);
                    if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                        let data = {
                            kind: kind, text: text,
                            location: { uri: URI.file(filepath).toString(), range: {
                                start: { line: lineNumber1, character: start1 },
                                end: { line: lineNumber1, character: end1 } } },
                            definition: { uri: URI.file(file2).toString(), range: {
                                start: { line: lineNumber2, character: start2 },
                                end: { line: lineNumber2, character: end2 } } }
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
    private setOptions(uristring: string) {
        let fspath = URI.parse(uristring).fsPath;
        let filename = path.basename(fspath);
        let dirname = path.dirname(fspath);
        let diropt = '--workdir=' + dirname;
        let fileopt = '--filename=' + filename;
        if (is_windows) {
            fileopt = '"' + fileopt + '"';
            diropt = '"' + diropt + '"';
        }
        return [filename, dirname, fileopt, diropt];
    }

    /**
     * Do compile the code
     * @param src source code string
     */
    private compile(uri: string, diagnostics: Diagnostic[], url: string, src: string) {
        let tokens: any = { ref: [], def: [], count: {} };
        this.semanticCheck_[uri] = [];
        this.tokenBuffer_[uri] = tokens;

        const symbolmap: any = {};
        let [filename, dirname, fileopt, diropt] = this.setOptions(url);
        const buf = childProcess.execSync('kinx.exe -ic --output-location --error-code=0 ' + fileopt + ' ' + diropt, { timeout: 10000, input: src + '\n__END__' });
        const msgs = buf.toString();
        const srcbuf = src.split(/\r?\n/);
        const msgbuf = msgs.split(/\r?\n/);
        for (let i = 0, l = msgbuf.length; i < l; ++i) {
            let errmsg = msgbuf[i];
            if (errmsg.length > 0 && errmsg.charAt(0) == '#') {
                this.checkLocation(tokens, symbolmap, filename, dirname, errmsg, srcbuf);
                continue;
            }
            let result = errmsg.match(/Symbol\(([^\)]+)\).+?<([^>]+)>:(\d+)/);
            if (result == null) {
                result = errmsg.match(/.+?<([^>]+)>:(\d+)/);
                if (result != null) {
                    let file = result[1];
                    if (file === filename) {
                        this.normalCheck(diagnostics, parseInt(result[2]) - 1, srcbuf, errmsg);
                    } else {
                        this.usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
                    }
                }
            } else {
                let file = result[2];
                if (file === filename) {
                    this.symbolCheck(diagnostics, symbolmap, result[1], parseInt(result[3]) - 1, srcbuf, errmsg);
                } else {
                    this.usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
                }
            }
        }

        return tokens;
    }

    /**
     * Analyzes the text document for problems.
     * @param doc text document to analyze
     */
    public validate(doc: TextDocument) {
        const uri = doc.uri.toString();
        const diagnostics: Diagnostic[] = [];
        let tokens = this.compile(uri, diagnostics, doc.uri, doc.getText());
        for (let info of Object.keys(tokens.count).map(k => tokens.count[k])) {
            if (info.count == 0) {
                const range = info.data.location.range;
                const diagnostic: Diagnostic = Diagnostic.create(
                    range,
                    "The variable(" + info.data.text + ") is defined but not used.",
                    DiagnosticSeverity.Warning,
                    "",
                    "Semantics Check",
                );
                diagnostics.push(diagnostic);
                this.semanticCheck_[uri].push({ line: range.start.line, start: range.start.character, end: range.end.character });
            }
        }

        connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    }

    public getDefinition(uri: string, position: Position) {
        let line = position.line;
        let character = position.character;
            let locations: any[] = this.tokenBuffer_[uri].ref;
        for (let i = 0, l = locations.length; i < l; ++i) {
            let location = locations[i].location;
            let range = location.range;
            if (range.start.line === line) {
                if (range.start.character <= character && character <= range.end.character) {
                    return locations[i].definition;
                }
            }
        }
    }

}

let server: KinxLanguageServer = new KinxLanguageServer();

connection.onRequest("textDocument/semanticTokens", (params) => {
    let builder = new SemanticTokensBuilder();
    const tokens: any[] = server.getSemanticCheckedTokens(params.textDocument.uri);
    if (tokens != null) {
        tokens.forEach(el => {
            builder.push(el.line, el.start, el.end - el.start, 0, 0);
        });
    }
    return builder.build();
});

connection.onRequest("textDocument/definition", (params) => {
    return server.getDefinition(params.textDocument.uri, params.position);
});

function setupDocumentsListeners() {
    documents.listen(connection);

    documents.onDidOpen((event) => {
        server.validate(event.document);
    });

    documents.onDidChangeContent((change) => {
        server.validate(change.document);
    });

    documents.onDidClose((close) => {
        connection.sendDiagnostics({ uri: close.document.uri, diagnostics: []});
    });

}

// Listen on the connection
connection.listen();
