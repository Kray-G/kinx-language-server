const childProcess = require('child_process');
const process = require("process");
const path = require("path");
const url = require('url');
let publishDiagnosticsCapable = false;
const is_windows = process.platform === 'win32';
const is_mac     = process.platform === 'darwin';
const is_linux   = process.platform === 'linux';

function sendMessage(msg) {
    const s = JSON.stringify(msg);
    process.stdout.write(`Content-Length: ${s.length}\r\n\r\n`);
    process.stdout.write(s);
}

function logMessage(message) {
    sendMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message } });
}

function sendErrorResponse(id, code, message) {
    sendMessage({ jsonrpc: "2.0", id, error: { code, message }});
}

function sendPublishDiagnostics(uri, diagnostics) {
  if (publishDiagnosticsCapable) {
      sendMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }
}

function sendParseErrorResponse() {
    // If there was an error in detecting the id in the Request object (e.g. Parse error/Invalid Request), it MUST be Null.
    // https://www.jsonrpc.org/specification#response_object
    sendErrorResponse(null, -32700, "received an invalid JSON");
}

function languageServer() {
    let buffer = Buffer.from(new Uint8Array(0));
    process.stdin.on("readable", () => {
        let chunk;
        while (chunk = process.stdin.read()) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const bufferString = buffer.toString();
        if (!bufferString.includes("\r\n\r\n")) return;

        const headerString = bufferString.split("\r\n\r\n", 1)[0];

        let contentLength = -1;
        let headerLength = headerString.length + 4;
        for (const line of headerString.split("\r\n")) {
            const [key, value] = line.split(": ");
            if (key === "Content-Length") {
                contentLength = parseInt(value, 10);
            }
        }

        if (contentLength === -1) return;
        if (buffer.length < headerLength + contentLength) return;

        try {
            const msg = JSON.parse(buffer.slice(headerLength, headerLength + contentLength));
            dispatch(msg);
        } catch (e) {
            if (e instanceof SyntaxError) {
                sendParseErrorResponse();
                return;
            } else {
                throw e;
            }
        } finally {
            buffer = buffer.slice(headerLength + contentLength);
        }
    });
}

function sendInvalidRequestResponse() {
    sendErrorResponse(null, -32600, "received an invalid request");
}

function sendMethodNotFoundResponse(id, method) {
    sendErrorResponse(id, -32601, method + " is not supported");
}

let diagnostics = [];
let symbolmap = {};
var tokens = [];

function normalCheck(lineNumber, srcbuf, errmsg) {
  let srcline = srcbuf[lineNumber];
  if (srcline != null) {
    let re = new RegExp("[^\\s]");
    let result = re.exec(srcline);
    if (result != null) {
      let start = result.index;
      diagnostics.push({
        message: errmsg,
        range: {
          start: { line: lineNumber, character: start < 0 ? 0 : start },
          end: { line: lineNumber, character: srcline.length },
        }
      });
    }
  }
}

function usingCheck(filename, srcbuf, errmsg) {
  const file = filename.replace(/\.[^/.]+$/, "");
  for (let i = 0, l = srcbuf.length; i < l; ++i) {
    let srcline = srcbuf[i];
    logMessage("using check; " + i + ": " + srcline);
    let re = new RegExp("using\\s+" + file + '\\s*;');
    let result = re.exec(srcline);
    if (result != null && result.index >= 0) {
      let key = "using:" + file + ':' + i;
      if (symbolmap[key] == null) {
        symbolmap[key] = true;
        diagnostics.push({
          message: errmsg,
          range: {
            start: { line: i, character: result.index },
            end: { line: i, character: result.index + result[0].length },
          }
        });
      }
      return;
    }
  }
}

function symbolCheck(symbol, lineNumber, srcbuf, errmsg) {
  let srcline = srcbuf[lineNumber];
  if (srcline != null) {
    let re = new RegExp("\\b" + symbol + "\\b", 'g');
    let found;
    while ((found = re.exec(srcline)) != null) {
      let index = found.index;
      const key = symbol + ":" + lineNumber + ":" + index;
      if (symbolmap[key] == null) {
        symbolmap[key] = true;
        diagnostics.push({
          message: errmsg,
          range: {
            start: { line: lineNumber, character: index },
            end: { line: lineNumber, character: index + symbol.length },
          }
        });
      }
    }
  }
}

function getKindName(name) {
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

function searchName(text, srcbuf, lineNumber) {
  let srcline = srcbuf[lineNumber];
  if (srcline != null) {
    let re = new RegExp("\\b" + text + "\\b", 'g');
    let found;
    while ((found = re.exec(srcline)) != null) {
      let index = found.index;
      const key = text + ":" + lineNumber + ":" + index;
      if (symbolmap[key] == null) {
        symbolmap[key] = true;
        return [index, index + text.length];
      }
    }
  }
  return [-1, -1];
}

function checkLocation(filename, errmsg, srcbuf) {
  /*
    TODO: Currently the location will be handled in the same file.
  */
  let result = errmsg.match(/#define\t(var|class|module|function|public|private|native)\t([^\t]+)\t([^\t]+)\t(\d+)/);
  if (result != null) {
    let kind = getKindName(result[1]);
    let text = result[2];
    let file = result[3];
    let lineNumber = parseInt(result[4]) - 1;
    if (filename === file) {
      let [start, end] = searchName(text, srcbuf, lineNumber);
      if (start >= 0 && end >= 0) {
        let data = {
          "kind": kind, "text": text,
          "location": { "uri": file, "range": {
              "start": { "line": lineNumber, "character": start },
              "end": { "line": lineNumber, "character": end } } }
        };
        tokens.push(data);
      }
    }
    return;
  }
  result = errmsg.match(/#ref\tvar\t([^\t]+)\t([^\t]+)\t(\d+)\t([^\t]+)\t(\d+)/);
  if (result != null) {
    let kind = "variable";
    let text = result[1];
    let file1 = result[2];
    let lineNumber1 = parseInt(result[3]) - 1;
    let file2 = result[4];
    let lineNumber2 = parseInt(result[5]) - 1;
    if (filename === file1 && filename === file2) {
      let [start1, end1] = searchName(text, srcbuf, lineNumber1);
      let [start2, end2] = searchName(text, srcbuf, lineNumber2);
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
        tokens.push(data);
      }
    }
    return;
  }
  return;
}

function setOptions(uri) {
  let filename = decodeURIComponent(url.parse(uri).pathname);
  if (is_windows) {
    filename = filename.replace(/^\//, '').replace(/\//g, '\\');
  }
  let diropt = '--workdir=' + path.dirname(filename);
  filename = path.basename(filename);
  let fileopt = '--filename=' + filename;
  if (is_windows) {
    fileopt = '"' + fileopt + '"';
    diropt = '"' + diropt + '"';
  }
  return [filename, fileopt, diropt];
}

function compile(uri, src) {
  let [filename, fileopt, diropt] = setOptions(uri);
  const buf = childProcess.execSync('kinx.exe -ic --output-location --error-code=0 ' + fileopt + ' ' + diropt, { timeout: 10000, input: src + '\n__END__' });
  const msg = buf.toString();
  if (msg.length == 0) {
    logMessage("No error found.");
    return;
  }
  diagnostics.length = 0;
  symbolmap = {};
  tokens = [];
  const srcbuf = src.split(/\r?\n/);
  const msgs = msg.split(/\r?\n/);
  for (let i = 0, l = msgs.length; i < l; ++i) {
    let errmsg = msgs[i];
    if (errmsg.length > 0 && errmsg.charAt(0) == '#') {
      checkLocation(filename, errmsg, srcbuf);
      continue;
    }
    let result = errmsg.match(/Symbol\(([^\)]+)\).+?([^\s]+):(\d+)/);
    if (result == null) {
      result = errmsg.match(/.+?([^\s]+):(\d+)/);
      if (result != null) {
        let file = result[1];
        if (file === filename) {
          normalCheck(parseInt(result[2]) - 1, srcbuf, errmsg);
        } else {
          usingCheck(file, srcbuf, errmsg);
        }
      }
    } else {
      let file = result[2];
      if (file === filename) {
        symbolCheck(result[1], parseInt(result[3]) - 1, srcbuf, errmsg);
      } else {
        usingCheck(file, srcbuf, errmsg);
      }
    }
  }
  sendPublishDiagnostics(uri, diagnostics);
  if (diagnostics.length === 1) {
    logMessage("1 error found.");
  } else if (diagnostics.length > 1) {
    logMessage(diagnostics.length + " error(s) found.");
  } else {
    logMessage("No error found.");
  }
}

const requestTable = {};
const notificationTable = {};

requestTable["initialize"] = (msg) => {
  const capabilities = {
    textDocumentSync: 1, // 1 means to send all text content.
  };

  if (msg.params && msg.params.capabilities) {
    if (msg.params.capabilities.textDocument && msg.params.capabilities.textDocument.publishDiagnostics) {
        publishDiagnosticsCapable = true;
    }
  }

  sendMessage({ jsonrpc: "2.0", id: msg.id, result: { capabilities } });
}

requestTable["textDocument/semanticTokens/full"] = (msg) => {
  const uri = msg.params.textDocument.uri;
  const data = [];
  let line = 0;
  let character = 0;

  logMessage(Object.keys(msg.params.textDocument));

  sendMessage({ jsonrpc: "2.0", id: msg.id, result: { data } })
}

notificationTable["textDocument/didOpen"] = (msg) => {
  const uri = msg.params.textDocument.uri;
  const text = msg.params.textDocument.text;
  compile(uri, text);
}

notificationTable["textDocument/didChange"] = (msg) => {
  if (msg.params.contentChanges.length !== 0) {
      const uri = msg.params.textDocument.uri;
      const text = msg.params.contentChanges[msg.params.contentChanges.length - 1].text;
      compile(uri, text);
  }
}

notificationTable["textDocument/didClose"] = (msg) => {
  const uri = msg.params.textDocument.uri;
  sendPublishDiagnostics(uri, []);
}

notificationTable["initialized"] = (msg) => {
  logMessage("initialized! " + process.env.KinxPath);
}

function dispatch(msg) {
    if ("id" in msg && "method" in msg) { // request
        if (msg.method in requestTable) {
            requestTable[msg.method](msg);
        } else {
            sendMethodNotFoundResponse(msg.id, msg.method)
        }
    } else if ("id" in msg) { // response
        // Ignore.
        // This language server doesn't send any request.
        // If this language server receives a response, that is invalid.
    } else if ("method" in msg) { // notification
        if (msg.method in notificationTable) {
            notificationTable[msg.method](msg);
        }
    } else { // error
        sendInvalidRequestResponse();
    }
}

if (process.argv.length !== 3) {
    console.log(`usage: ${process.argv[1]} [--language-server|FILE]`);
} else if (process.argv[2] == "--language-server") {
    languageServer();
} else {
    // TODO: interpret(process.argv[2]);
}
