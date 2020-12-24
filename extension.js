"use strict";
const vscode = require("vscode");
const languageclient = require("vscode-languageclient");

let client;
// function helloWorld() {
//   vscode.window.showInformationMessage('Hello, world!')
// }

function activate(context) {
    try {
      // Register command exampple.
      // context.subscriptions.push(vscode.commands.registerCommand('kinx.helloWorld', helloWorld));

      const serverOptions = {
            command: "node",
            args: [
                context.extensionPath + "/kinx.js",
                "--language-server"
            ]
        };
        const clientOptions = {
            documentSelector: [
                {
                    scheme: "file",
                    language: "kinx",
                }
            ],
        };
        client = new languageclient.LanguageClient("Kinx Language Server", serverOptions, clientOptions);
        context.subscriptions.push(client.start());
    } catch (e) {
        vscode.window.showErrorMessage("kinx-language-server couldn't be started.");
    }
}

function deactivate() {
    if (client) return client.stop();
}

module.exports = { activate, deactivate }
