"use strict";

import {
    CompletionItem,
    CompletionItemKind,
    // CodeActionKind,
    createConnection,
    Diagnostic,
    DiagnosticSeverity,
    Position,
    ProposedFeatures,
    Range,
    TextDocumentPositionParams,
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
let kinxExePath = 'kinx';

const keywords = [
    // Module control
    "__END__", "__LINE__", "__FILE__",
    "_import", "_function", "_class", "_module", "_namespace", "using", "import",

    // Namespace/Class/Module
    "namespace", "class", "module", "public", "private", "mixin", /* "protected" */

    // Flow control
    "if", "else", "for", "in", "do", "while", "switch", "case", "default",
    "break", "continue",
    "try", "catch", "finally", "throw",
    "function", "native", "return", "yield",

    // Special values
    "undefined", "null", "true", "false",

    // Typename/Declaration/Instanciation/Cast
    "int", "dbl", "bin", "big", "str", "ary", "obj",
    "var", "const", "enum", "new", "as",

    // Typecheck
    "isNull", "isUndefined", "isDefined", "isInteger", "isBigInteger", "isNumber",
    "isString", "isDouble", "isBinary", "isFunction", "isArray", "isObject",

    // Predefined
    "System", "SystemTimer", "Fiber", "File",
];

const predefinedMethods: any = {
    "System:Class": [
        "PLATFORM",
        "abort", "defineException", "exec", "gc", "getopt",
        "halt", "isUtf8Bytes", "localtime",
        "print", "println",
        "sleep", "try",
    ],
    "File:Class": [
        "APPEND", "BINARY", "READ", "TEXT", "WRITE",
        "dirclose", "direntry", "diropen",
        "exists", "filedate", "filesize", "setFiledate",
        "isDirectory", "isSymlink",
        "load", "mkdir", "open", "remove", "rename", "unlink",
    ],
    "File": [
        "APPEND", "BINARY", "READ", "TEXT", "WRITE",
        "isFile", "mkdir", "load", "close",
        "readLine", "eachLine",
        "filedate", "filesize", "setFiledate",
        "getch", "geti", "putch",
        "peek", "print", "println",
        "rename", "unlink", "source",
    ],
    "SystemTimer": [
        "restart", "elapsed",
    ],
};

class KinxUtility {
    public isUpperCase(c: string) {
        return /^[A-Z]+$/g.test(c);
    }

    public checkFilePath(dirname: string, candidate: string) {
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
     * Translate the name to the kind.
     * @param name the name.
     */
    public getKindName(name: string) {
        switch (name) {
        case "var":      return "variable";
        case "const":    return "const";
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

    public makeDefaultVarMap(srcbuf: string[]) {
        let candidate: any = {
            "$stdin":  { "File": true },
            "$stdout": { "File": true },
            "$stderr": { "File": true },
        };
        for (let i = 0, l = srcbuf.length; i < l; ++i) {
            let result = srcbuf[i].match(/([$_a-zA-Z0-9]+)\s*=\s*new\s+(?:[$_a-zA-Z0-9]+\.)*([$_a-zA-Z0-9]+)\(/);
            if (result != null) {
                let varname = result[1];
                let typename = result[2];
                candidate[varname] ??= {};
                candidate[varname][typename] = true;
            }
        }
        return candidate;
    }

    /**
     * Search the text in the source code.
     * @param symbolmap check to duplicate the text.
     * @param text the text to be searched.
     * @param srcbuf source code buffer.
     * @param lineNumber line number of error.
     */
    public searchName(symbolmap: any, text: string, srcbuf: string[], lineNumber: number, checkDup: boolean, resetDup: boolean) {
        let srcline = srcbuf[lineNumber];
        if (srcline != null) {
            let line = srcline.replace(/"(\\"|[^"])+?"|'(\\'|[^'])+?'/g, (match) => {
                return match.replace(/([^%]+)|(%\{[^\}]+\})/g, (str) => {
                    if (str.charAt(0) == '%') {
                        return str;
                    }
                    return ' '.repeat(str.length);
                });
            });
            let re = new RegExp("\\b" + text.replace(/\+|\||\*|\[|\]/, "\\$1") + "\\b", 'g');
            let found;
            while ((found = re.exec(line)) != null) {
                let index = found.index;
                const key = text + ":" + lineNumber + ":" + index;
                if (resetDup) {
                    delete symbolmap[key];
                }
                if (!checkDup) {
                    return [index, index + text.length];
                }
                if (symbolmap[key] == null) {
                    symbolmap[key] = true;
                    return [index, index + text.length];
                }
            }
        }
        return [-1, -1];
    }

    public checkTypeArray(diagnostics: Diagnostic[], defs: string[], refs: string[], range: Range) {
        if (range == null) {
            return;
        }
        let len1 = defs.length;
        let len2 = refs.length;
        let len = len1 < len2 ? len1 : len2;
        for (let i = 0; i < len; ++i) {
            if (defs[i] === "-" || defs[i] === "Any" || refs[i] === "-" || refs[i] === "Any") {
                continue;
            }
            if (defs[i] != refs[i]) {
                let nth = i === 0 ? "1st" : (i === 1 ? "2nd" : (i === 2 ? "3rd" : ((i+1)+"th")));
                const diagnostic: Diagnostic = Diagnostic.create(
                    range,
                    "The " + nth + " argument type should be " + defs[i] + ", but it is " + refs[i] + ".",
                    DiagnosticSeverity.Error,
                    "",
                    "Semantic Check",
                );
                diagnostics.push(diagnostic);
            }
        }
    }

    /**
     * Parameter analysis
     * @param uri uri string
     */
    public setOptions(uristring: string) {
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

    public getPreviousToken(srcline: string, end: number) {
        let re = new RegExp("[$_a-zA-Z][$_a-zA-Z0-9]*", 'g');
        let found;
        while ((found = re.exec(srcline)) != null) {
            let last = found.index + found[0].length;
            if (last == end) {
                return found[0];
            }
        }
        return "";
    }

    public getTypenameOnDecl(defs: any[], name: string, line: number) {
        let index = -1;
        if (defs != null) {
            for (let i = 0, l = defs.length; i < l; ++i) {
                let data = defs[i];
                if (data.text === name) {
                    let range = data.location.range;
                    if (index >= 0 && range.start.line > line) {
                        break;
                    }
                    index = i;
                }
            }
        }
        if (index >= 0) {
            return defs[index].typename;
        }
        return null;
    }
}

class KinxDiagnosticsChecker {

    /**
     * Normal error message analysis.
     * @param diagnostics diagnostics array to be sent.
     * @param lineNumber line number of error.
     * @param srcbuf source code buffer.
     * @param errmsg actual error message.
     */
    public normalCheck(diagnostics: Diagnostic[], lineNumber: number, srcbuf: string[], errmsg: string) {
        if (srcbuf.length <= lineNumber) lineNumber = srcbuf.length - 1;
        let start = 0, end = -1;
        let srcline = srcbuf[lineNumber];
        if (srcline != null) {
            let chkvar = new RegExp("\\s+for\\s+\\(([^\\)]+)\\)");
            let resvar = chkvar.exec(errmsg);
            if (resvar != null) {
                let varname = resvar[1];
                let index = srcline.indexOf(varname);
                if (index >= 0) {
                    start = index;
                    end = start + varname.length;
                }
            }
            if (end < 0) {
                end = srcline.length;
                let re = new RegExp("[^\\s]");
                let result = re.exec(srcline);
                if (result != null) {
                    start = result.index;
                }
            }
        }
        if (end < 0) {
            end = 1;
        }
        const range: Range = {
            start: { line: lineNumber, character: start < 0 ? 0 : start },
            end: { line: lineNumber, character: end },
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

    /**
     * Error in another file.
     * @param diagnostics diagnostics array to be sent.
     * @param symbolmap check to duplicate errors.
     * @param filename filename in error.
     * @param srcbuf source code buffer.
     * @param errmsg actual error message.
     */
    public usingCheck(diagnostics: Diagnostic[], symbolmap: any, filename: string, srcbuf: string[], errmsg: string) {
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
    public symbolCheck(diagnostics: Diagnostic[], symbolmap: any, symbol: string, lineNumber: number, srcbuf: string[], errmsg: string) {
        let srcline = srcbuf[lineNumber];
        if (srcline != null) {
            let re = new RegExp("\\b" + symbol.replace(/\+|\||\*|\[|\]/, "\\$1") + "\\b", 'g');
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

}

class KinxLanguageServer {

    private tokenBuffer_: any;
    private semanticCheck_: any;
    private srcCode_: any;
    private symbols_: any;
    private methods_: any;
    private varTypeMap_: any;
    private inheritMap_: any;
    private scope_: any[];
    private args_: any;
    private curArgs_: any;
    private checker_: KinxDiagnosticsChecker;
    private utils_: KinxUtility;

    constructor() {
        this.tokenBuffer_ = {};
        this.semanticCheck_ = {};
        this.srcCode_ = {};
        this.symbols_ = {};
        this.methods_ = {};
        this.varTypeMap_ = {};
        this.inheritMap_ = {};
        this.scope_ = [];
        this.args_ = {};
        this.curArgs_ = null;
        this.checker_ = new KinxDiagnosticsChecker();
        this.utils_ = new KinxUtility();
    }

    public getSemanticCheckedTokens(uri: string) {
        return this.semanticCheck_[uri];
    }

    private setSymbolInfo(uri: string, text: string, type: string, arglist: any, retTypename: string) {
        let args = Array.isArray(arglist.args) ? arglist.args.map((e: string) => e === '-' ? "Any" : e) : [];
        if (this.scope_.length > 0 && (type === "public" || type === "class")) {
            let scope = this.scope_[this.scope_.length - 1].name;
            this.methods_[uri][scope] ??= {}
            this.methods_[uri][scope][text] = {
                kind: CompletionItemKind.Method,
                args: args,
                retTypename: retTypename
            };
            return this.methods_[uri][scope][text];
        }

        this.symbols_[uri][text] = {
            kind: this.utils_.isUpperCase(text.charAt(0)) ? CompletionItemKind.Class : CompletionItemKind.Variable
        };
        return null;
    }

    private getMethodCandidate(uri: string, className: string, methodName: string) {
        let types = [ className ];
        while (types.length > 0) {
            let typename: string | undefined = types.pop();
            if (typename != null) {
                if (this.methods_[uri] && this.methods_[uri][typename] && this.methods_[uri][typename][methodName]) {
                    return this.methods_[uri][typename][methodName];
                }
                if (this.inheritMap_[uri].hasOwnProperty(typename)) {
                    Object.keys(this.inheritMap_[uri][typename]).forEach((name: string) => {
                        types.push(name);   // add inherit class name.
                    });
                }
            }
        }
        return null;
    }

    /**
     * Check the symbol location.
     * @param tokens result buffer.
     * @param symbolmap check to duplicate.
     * @param filename the filename of checking.
     * @param message actual message.
     * @param srcbuf source code buffer.
     */
    private checkLocation(diagnostics: Diagnostic[], uri: string, tokens: any, symbolmap: any, filename: string, dirname: string, message: string, srcbuf: string[]) {
        // console.log(message);
        if (tokens.curCallInfo != null) {
            if (message == "#callend") {
                if (tokens.curCallInfo.finfo != null && tokens.curCallInfo.finfo.args != null) {
                    this.utils_.checkTypeArray(diagnostics, tokens.curCallInfo.finfo.args, tokens.curCallInfo.args, tokens.curCallInfo.range);
                }
                tokens.curCallInfo = null;
                return;
            }
            let result = message.match(/#callarg\t([0-9]+)\t([^\t]+)/);
            if (result != null) {
                let index = parseInt(result[1]);
                tokens.curCallInfo.args[index] = result[2];
            }
            return;
        }
        let result = message.match(/#call\t([^\t]+)\t([^\t]+)\t(\d+)\t([^\t]+)\t(\d+)/);
        if (result != null) {
            var [scope, text] = result[1].split("#");
            if (text == null) {
                text = scope;
                scope = "-";
            }
            let file2 = result[4];
            let lineNumber2 = parseInt(result[5]) - 1;
            tokens.curCallInfo = {
                scope: scope,
                text: text,
                file1: result[2],
                lineNumber1: parseInt(result[3]) - 1,
                file2: file2,
                lineNumber2: lineNumber2,
                args: [],
            };
            let key = tokens.curCallInfo.text + ":" + tokens.curCallInfo.lineNumber2 + ":" + tokens.curCallInfo.file2;
            if (scope === "-") {
                tokens.curCallInfo.finfo = tokens.func[key];
            } else {
                tokens.curCallInfo.finfo = this.getMethodCandidate(uri, scope, text);
            }
            if (filename === tokens.curCallInfo.file1) {
                let [start, end] = this.utils_.searchName(symbolmap, tokens.curCallInfo.text, srcbuf, tokens.curCallInfo.lineNumber1, false, false);
                tokens.curCallInfo.range = {
                    start: { line: tokens.curCallInfo.lineNumber1, character: start },
                    end: { line: tokens.curCallInfo.lineNumber1, character: end }
                };
            }
            return;
        }
        result = message.match(/#vartype\t([^\t]+)\t([^\t]+)/);
        if (result != null) {
            let varname = result[1];
            let typename = result[2];
            this.varTypeMap_[uri][varname] ??= {};
            this.varTypeMap_[uri][varname][typename] = true;
            return;
        }
        result = message.match(/#method\t([^\t]+)#([^\t]+)\t([^\t]+)\t(\d+)\t(\d+)\t(\d+)/);
        if (result != null) {
            this.getMethodCandidate(uri, scope, text)
            let classname = result[1];
            let methodname = result[2];
            let file = result[3];
            let line = parseInt(result[4]) - 1;;
            let pos1 = parseInt(result[5]);
            let pos2 = parseInt(result[6]);
            let finfo = this.getMethodCandidate(uri, classname, methodname);
            if (finfo) {
                let filepath = path.join(dirname, file);
                let data = {
                    kind: "function", text: methodname, typename: "Function", retTypename: finfo.retTypename, argList: finfo.args,
                    location: { uri: URI.file(filepath).toString(),
                        range: {
                            start: { line: line, character: pos1 },
                            end: { line: line, character: pos2 }
                        }
                    },
                    definition: finfo.definition
                };
                tokens.ref.push(data);
            }
            return;
        }
        result = message.match(/#scope\t(start|end)\t(function|class)(?:\t([^\t]+))?/);
        if (result != null) {
            let isEnd = result[1] === "end";
            let isClass = result[2] === "class";
            let name = result[3];
            if (isClass) {
                if (isEnd) {
                    this.scope_.pop();
                } else {
                    this.scope_.push({ name: name });
                }
            }
            if (name != null) {
                if (isEnd) {
                    this.curArgs_ = null;
                } else {
                    let scope = this.scope_.join('#');
                    this.args_[scope] ??= {};
                    this.args_[scope][name] = this.curArgs_ = { args: [], isClass: isClass };
                }
            }
            return;
        }
        if (this.curArgs_ != null) {
            result = message.match(/#arg\t([0-9]+)\t([^\t]+)/);
            if (result != null) {
                let index = parseInt(result[1]);
                this.curArgs_.args[index] = (result[2] === '-') ? "Any" : result[2];
                return;
            }
        }
        result = message.match(/#define\t(var|const|class|module|function|public|private|native)\t([^\t]+)\t([^\t]+)\t(\d+)(?:\t(Function#|FunctionRef#)?([^\t]+))?/);
        if (result != null) {
            let kindbase = result[1];
            let kind = this.utils_.getKindName(kindbase);
            let text = result[2];
            let file = result[3];
            let lineNumber = parseInt(result[4]) - 1;
            let isFunction = result[5] === "Function#";
            let typename = isFunction ? "Function" : result[6];
            let retTypename = isFunction ? result[6] : null;
            let argList = { args: [] };
            let symbolinfo = null;
            if (kind == "function") {
                let key = text+":"+lineNumber;
                this.curArgs_.file = file;
                this.curArgs_.line = lineNumber;
                tokens.func[key+":"+file] = argList = this.curArgs_;
                symbolinfo = this.setSymbolInfo(uri, text, kindbase, this.curArgs_, retTypename ?? "Any");
                this.curArgs_ = null;
            } else if (kind == "class") {
                let key = text+":"+lineNumber;
                this.curArgs_.file = file;
                this.curArgs_.line = lineNumber;
                tokens.func[key+":"+file] = argList = this.curArgs_;
                this.setSymbolInfo(uri, text, kindbase, this.curArgs_, text);
                this.curArgs_ = null;
            } else {
                this.setSymbolInfo(uri, text, kindbase, [], retTypename ?? "Any");
            }
            if (kindbase == "public" && tokens.def.length > 0) {
                let prev = tokens.def[tokens.def.length - 1];
                if (prev && prev.kind === "variable" && prev.text === text) {
                    tokens.def.pop();
                }
            }
            if (filename === file) {
                let [start, end] = this.utils_.searchName(symbolmap, text, srcbuf, lineNumber, true, true);
                if (start >= 0 && end >= 0) {
                    let filepath = path.join(dirname, filename);
                    let data = {
                        kindbase: kindbase,
                        kind: kind, text: text, typename: typename, retTypename: retTypename, argList: argList.args,
                        location: { uri: URI.file(filepath).toString(), range: {
                            start: { line: lineNumber, character: start },
                            end: { line: lineNumber, character: end } } }
                    };
                    tokens.def.push(data);
                    if (kind !== "class" && kind !== "const") {
                        tokens.count[text+":"+lineNumber] = {
                            count: kind == "function" ? 1 : 0,
                            data: data,
                        };
                    }
                    if (kind === "class" && typename !== "") {
                        this.inheritMap_[uri][text] ??= {};
                        this.inheritMap_[uri][text][typename] = true;
                    }
                    if (symbolinfo != null) {
                        symbolinfo.definition = data.location;
                    }
                }
            } else {
                if (symbolinfo != null) {
                    let file2 = this.utils_.checkFilePath(dirname, file);
                    let code = fs.readFileSync(file2, "utf8");
                    let codebuf = code.split(/\r?\n/);
                    let [start2, end2] = this.utils_.searchName(symbolmap, text, codebuf, lineNumber, false, false);
                    if (start2 >= 0 && end2 >= 0) {
                        symbolinfo.definition = { uri: URI.file(file2).toString(), range: {
                            start: { line: lineNumber, character: start2 },
                            end: { line: lineNumber, character: end2 } } };
                    }
                }
                if (kind === "class" && typename !== "") {
                    this.inheritMap_[uri][text] ??= {};
                    this.inheritMap_[uri][text][typename] = true;
                }
            }
            return;
        }
        result = message.match(/#ref\t(var|key)\t([^\t]+)\t([^\t]+)\t(\d+)(?:\t([^\t]+)\t(\d+))?(?:\t(Function#|Native#)?([^\t]+))?/);
        if (result != null) {
            let filepath = path.join(dirname, filename);
            let kind = result[1] === "var" ? "variable" : "keyname";
            let text = result[2];
            let file1 = result[3];
            let lineNumber1 = parseInt(result[4]) - 1;
            if (filename === file1) {
                let isFunction = result[7] === "Function#";
                let isNative = result[7] === "Native#";
                let typename = (isFunction || isNative) ? "Function" : result[8];
                let retTypename = (isFunction || isNative) ? result[8] : null;
                let [start1, end1] = this.utils_.searchName(symbolmap, text, srcbuf, lineNumber1, true, false);
                if (kind === "keyname") {
                    let data = {
                        kind: kind, text: text,
                        location: { uri: URI.file(filepath).toString(), range: {
                            start: { line: lineNumber1, character: start1 },
                            end: { line: lineNumber1, character: end1 } } }
                    };
                    tokens.ref.push(data);
                    return;
                }
                let file2 = result[5];
                let lineNumber2 = parseInt(result[6]) - 1;
                let key = text + ":" + lineNumber2 + ":" + file2;
                let argList = tokens.func[key] != null ? tokens.func[key] : { args: [] };
                if (filename === file2) {
                    let [start2, end2] = this.utils_.searchName(symbolmap, text, srcbuf, lineNumber2, false, false);
                    if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                        let def = tokens.count[text+":"+lineNumber2];
                        let data = {
                            kindbase: isNative ? "native" : (isFunction ? "function" : ""),
                            kind: kind, text: text, typename: typename, retTypename: retTypename, argList: argList.args,
                            location: { uri: URI.file(filepath).toString(), range: {
                                start: { line: lineNumber1, character: start1 },
                                end: { line: lineNumber1, character: end1 } } },
                            definition: { uri: URI.file(filepath).toString(), range: {
                                start: { line: lineNumber2, character: start2 },
                                end: { line: lineNumber2, character: end2 } } }
                        };
                        tokens.ref.push(data);
                        if (def != null) {
                            def.count++;
                        }
                    }
                } else {
                    file2 = this.utils_.checkFilePath(dirname, file2);
                    let code = fs.readFileSync(file2, "utf8");
                    let codebuf = code.split(/\r?\n/);
                    let [start2, end2] = this.utils_.searchName(symbolmap, text, codebuf, lineNumber2, false, false);
                    if (start1 >= 0 && end1 >= 0 && start2 >= 0 && end2 >= 0) {
                        let data = {
                            kind: kind, text: text, typename: typename, retTypename: retTypename, argList: argList.args,
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
     * Do compile the code
     * @param src source code string
     */
    private compile(uri: string, diagnostics: Diagnostic[], url: string, src: string) {
        let tokens: any = { ref: [], def: [], count: {}, func: {} };
        this.symbols_[uri] = [];
        this.semanticCheck_[uri] = [];
        this.tokenBuffer_[uri] = tokens;
        this.scope_ = [];
        this.methods_[uri] = {};
        this.inheritMap_[uri] = {};

        this.srcCode_[uri] = src.split(/\r?\n/);
        const srcbuf = this.srcCode_[uri];
        this.varTypeMap_[uri] = this.utils_.makeDefaultVarMap(srcbuf);

        const symbolmap: any = {};
        let [filename, dirname, fileopt, diropt] = this.utils_.setOptions(url);
        const buf = childProcess.execSync('"' + kinxExePath + '" -ic --output-location --error-code=0 ' + fileopt + ' ' + diropt, { timeout: 10000, input: src + '\n__END__' });
        const msgs = buf.toString();
        const msgbuf = msgs.split(/\r?\n/);
        for (let i = 0, l = msgbuf.length; i < l; ++i) {
            let errmsg = msgbuf[i];
            if (errmsg.length > 0 && errmsg.charAt(0) == '#') {
                this.checkLocation(diagnostics, uri, tokens, symbolmap, filename, dirname, errmsg, srcbuf);
                continue;
            }
            let result = errmsg.match(/(?:Symbol|Type)\(([^\)]+)\).+?<([^>]+)>:(\d+)/);
            if (result == null) {
                result = errmsg.match(/.+?<([^>]+)>:(\d+)/);
                if (result != null) {
                    let file = result[1];
                    if (file === filename) {
                        this.checker_.normalCheck(diagnostics, parseInt(result[2]) - 1, srcbuf, errmsg);
                    } else {
                        this.checker_.usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
                    }
                }
            } else {
                let file = result[2];
                if (file === filename) {
                    this.checker_.symbolCheck(diagnostics, symbolmap, result[1], parseInt(result[3]) - 1, srcbuf, errmsg);
                } else {
                    this.checker_.usingCheck(diagnostics, symbolmap, file, srcbuf, errmsg);
                }
            }
        }

        this.symbols_[uri] = Object.keys(this.symbols_[uri]).map((name: string) => ({
            name: name,
            kind: this.symbols_[uri][name].kind,
        }));

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
            const range = info.data.location.range;
            if (info.count != 0) {
                this.semanticCheck_[uri].push({ line: range.start.line, start: range.start.character, end: range.end.character, tokenTypesIndex: 1 });
            } else {
                const diagnostic: Diagnostic = Diagnostic.create(
                    range,
                    "The variable(" + info.data.text + ") is defined but not used.",
                    DiagnosticSeverity.Warning,
                    "",
                    "Semantic Check",
                );
                diagnostics.push(diagnostic);
                this.semanticCheck_[uri].push({ line: range.start.line, start: range.start.character, end: range.end.character, tokenTypesIndex: 0 });
            }
        }

        // console.log(JSON.stringify(tokens.count,undefined,4));
        // console.log(JSON.stringify(this.methods_,undefined,4));
        // console.log(JSON.stringify(tokens.ref,undefined,4));
        // console.log(JSON.stringify(diagnostics,undefined,4));
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

    private getHoverInfoOf(uri: string, locations: any[], position: Position) {
        let line = position.line;
        let character = position.character;
        for (let i = 0, l = locations.length; i < l; ++i) {
            let data = locations[i];
            if (data.kind === "keyname") {
                continue;
            }
            let location = data.location;
            let range = location.range;
            if (range.start.line === line) {
                if (range.start.character <= character && character <= range.end.character && data.text != null) {
                    let typename = data.typename != null ? data.typename : "Any";
                    if (data.text == typename) {
                        let finfo = this.getMethodCandidate(uri, typename, typename);
                        let args = finfo ? (finfo.args ?? []) : [];
                        return [typename, null, {
                            contents: { language: "kinx", value: "class " + data.text + "(" + args.join(", ") + ")"},
                            range: range
                        }];
                    }
                    if (typename == "Function") {
                        let functype = data.kindbase == null ? "function" : data.kindbase;
                        let args = data.argList || [];
                        let retTypename = data.retTypename || "Any";
                        return [typename, args, {
                            contents: { language: "kinx", value: functype + " " + data.text + "(" + args.join(", ") + ") : " + retTypename},
                            range: range
                        }];
                    }
                    return [typename, null, {
                        contents: { language: "kinx", value: data.text + " as " + typename },
                        range: range
                    }];
                }
            }
        }
        return [undefined, undefined, undefined];
    }

    public getHoverInfo(uri: string, position: Position) {
        let [t1, a1, info] = this.getHoverInfoOf(uri, this.tokenBuffer_[uri].ref, position);
        if (info == null || t1 === "Function") {
            let [t2, a2, c2] = this.getHoverInfoOf(uri, this.tokenBuffer_[uri].def, position);
            if (info == null) {
                info = c2;
            } else if (t2 === "Function" && a1.length < a2.length) {
                info = c2;
            }
        }
        return info;
    }

    private getCompletionCandidateByTypename(methods: any, uri: string, basetype: string) {
        let types = [ basetype ];
        while (types.length > 0) {
            let typename: string | undefined = types.pop();
            if (typename != null) {
                if (this.inheritMap_[uri].hasOwnProperty(typename)) {
                    Object.keys(this.inheritMap_[uri][typename]).forEach((name: string) => {
                        types.push(name);   // add inherit class name.
                    });
                }
                if (this.methods_[uri].hasOwnProperty(typename)) {
                    Object.keys(this.methods_[uri][typename]).forEach((method: string) => {
                        methods[method] = true;
                    });
                }
                if (predefinedMethods.hasOwnProperty(typename)) {
                    let prelist: string[] = predefinedMethods[typename];
                    prelist.forEach((method: string) => {
                        methods[method] = true;
                    });
                }
            }
        }
    }

    public getCompletionCandidates(uri: string, position: Position): CompletionItem[] {
        const srcbuf = this.srcCode_[uri];
        const srcline = srcbuf[position.line];
        const lastChar = srcline.charAt(position.character - 1);
        let candidates: any;
        let index = 0;
        switch (lastChar) {
        case ':':
            candidates = [
                { label: "int", kind: CompletionItemKind.TypeParameter, data: 0 },
                { label: "big", kind: CompletionItemKind.TypeParameter, data: 1 },
                { label: "dbl", kind: CompletionItemKind.TypeParameter, data: 2 },
                { label: "bin", kind: CompletionItemKind.TypeParameter, data: 3 },
                { label: "str", kind: CompletionItemKind.TypeParameter, data: 4 },
            ];
            break;
        case '.':
            var token = this.utils_.getPreviousToken(srcline, position.character - 1);
            let list: string[] | null = predefinedMethods.hasOwnProperty(token + ":Class") ? predefinedMethods[token + ":Class"] : null;
            if (list == null && this.methods_[uri] != null && this.methods_[uri].hasOwnProperty(token)) {
                let scope = this.methods_[uri][token];
                if (scope != null) {
                    list = Object.keys(scope);
                }
            }
            if (list == null) {
                // Check the nearest declaration.
                let typename = this.utils_.getTypenameOnDecl(this.tokenBuffer_[uri].def, token, position.line);
                if (typename != null) {
                    let methods: any = {};
                    this.getCompletionCandidateByTypename(methods, uri, typename);
                    list = Object.keys(methods);
                    if (list.length == 0) {
                        list = null;
                    }
                }
            }
            if (list == null && this.varTypeMap_[uri] != null && this.varTypeMap_[uri].hasOwnProperty(token)) {
                // Check possible types.
                var typenamelist = Object.keys(this.varTypeMap_[uri][token]);
                let methods: any = {};
                typenamelist.map((typename) => {
                    this.getCompletionCandidateByTypename(methods, uri, typename);
                });
                list = Object.keys(methods);
                if (list.length == 0) {
                    list = null;
                }
            }
            if (list != null) {
                // dot completion means always it is a method.
                candidates = list.map((name: string) => ({
                    label: name,
                    kind: CompletionItemKind.Method,
                    data: ++index,
                }));
            }
            break;
        default:
            candidates = keywords.map((el: string) => ({
                label: el,
                kind: CompletionItemKind.Keyword,
                data: ++index,
            }));
            var tokenx = this.utils_.getPreviousToken(srcline, position.character).toLowerCase();
            candidates = candidates.concat(this.symbols_[uri].filter((el: any) => el.name.toLowerCase() !== tokenx).map((el: any) => ({
                label: el.name,
                kind: el.kind,
                data: ++index,
            })));
            break;
        }
        return candidates;
    }

}

let server: KinxLanguageServer = new KinxLanguageServer();

interface Settings {
    kinx: KinxSettings;
}
interface KinxSettings {
    execPath: string;
}

connection.onInitialize(() => {
    documents = new TextDocuments(TextDocument);
    setupDocumentsListeners();

    return {
        capabilities: {
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: [ '.', ':' ]
            },
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
                    tokenTypes: [ "comment", "variable" ],
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

connection.onDidChangeConfiguration((change) => {
    let settings = <Settings>change.settings;
    if (settings.kinx != null) {
        kinxExePath = settings.kinx.execPath || 'kinx';
        console.log(settings.kinx);
        console.log(settings.kinx.execPath);
        console.log(kinxExePath);
    }
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    return server.getCompletionCandidates(params.textDocument.uri, params.position);
});

connection.onRequest("textDocument/semanticTokens", (params) => {
    let builder = new SemanticTokensBuilder();
    const tokens: any[] = server.getSemanticCheckedTokens(params.textDocument.uri);
    if (tokens != null) {
        tokens.forEach(el => {
            builder.push(el.line, el.start, el.end - el.start, el.tokenTypesIndex, 0);
        });
    }
    return builder.build();
});

connection.onRequest("textDocument/definition", (params) => {
    return server.getDefinition(params.textDocument.uri, params.position);
});

connection.onRequest("textDocument/hover", (params) => {
    return server.getHoverInfo(params.textDocument.uri, params.position);
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
