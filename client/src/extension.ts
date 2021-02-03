"use strict";

import * as path from "path";
import * as child_process from "child_process";
import { ExtensionContext, window as Window, commands as Commands, OutputChannel, workspace as Workspace, TextEditor } from "vscode";
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, TransportKind } from "vscode-languageclient";
let client: LanguageClient;
let outputChannel: OutputChannel;

function runKinx(outputChannel: OutputChannel, filename: string, text: string, value: string) {
    let settings = Workspace.getConfiguration("kinx");
    let exepath = settings.get("execPath");
    if (exepath === "") exepath = "kinx";

    let dirname = path.dirname(filename);
    let orgdir = process.cwd();
    process.chdir(dirname);
    let kinx = child_process.exec('"' + exepath + '" -i kinx ' + value, (_error, stdout, stderr) => {
        if (stdout) {
            outputChannel.appendLine(stdout);
        }
        if (stderr) {
            outputChannel.appendLine(stderr);
        }
    });
    let srccode = "var tmr = new SystemTimer(); try { " + text + " } finally { System.println('----\nelapsed: %f' % tmr.elapsed()); }\n__END__";
    kinx.stdin?.write(srccode);
    kinx.stdin?.end();
    process.chdir(orgdir);
}

function runKinxHook(filename: string, text: string, args: string, mode: string) {
    if (outputChannel == null) {
        outputChannel = Window.createOutputChannel("Kinx Output");
    }
    outputChannel.show(true);
    outputChannel.appendLine("[" + mode + "] Started at " + new Date(Date.now()).toString());
    outputChannel.appendLine("----");
    runKinx(outputChannel, filename, text, args ?? "");
}

function runKinxArgsHook(filename: string, text: string, mode: string) {
    Window.showInputBox({
        prompt: 'Input arguments for the script.',
        placeHolder: 'Input Script Arguments'
    }).then((value) => {
        runKinxHook(filename, text, value ?? "", mode);
    });
}

function runScript(editor: TextEditor | undefined, selmode: boolean, args: boolean) {
    if (editor != null) {
        let doc = editor.document;
        let filename = doc?.fileName;
        if (filename != null) {
            let text = selmode ? doc?.getText(editor.selection) : doc?.getText();
            if (text != null) {
                if (args) {
                    runKinxArgsHook(filename, text, selmode ? "Range" : "Full");
                } else {
                    runKinxHook(filename, text, "", selmode ? "Range" : "Full");
                }
            }
        }
    }
}

export function activate(context: ExtensionContext): void {
    context.subscriptions.push(Commands.registerCommand('kinx.run', () => {
        runScript(Window.activeTextEditor, false, false);
    }));
    context.subscriptions.push(Commands.registerCommand('kinx.runRange', () => {
        runScript(Window.activeTextEditor, true, false);
    }));
    context.subscriptions.push(Commands.registerCommand('kinx.runArgs', () => {
        runScript(Window.activeTextEditor, false, true);
    }));
    context.subscriptions.push(Commands.registerCommand('kinx.runRangeArgs', () => {
        runScript(Window.activeTextEditor, true, true);
    }));

    const serverModule = context.asAbsolutePath(path.join("server", "out", "server.js"));
    const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"], cwd: process.cwd() };
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc, options: { cwd: process.cwd() } },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions,
        },
    };
    const clientOptions: LanguageClientOptions = {
        synchronize: {
            configurationSection: 'kinx',
        },
        documentSelector: [{
            scheme: "file",
            language: "kinx",
        }],
        diagnosticCollectionName: "Kinx Diagnositics",
        revealOutputChannelOn: RevealOutputChannelOn.Never,
    };

    try {
        client = new LanguageClient("Kinx Language Server", serverOptions, clientOptions);
    } catch (err) {
        Window.showErrorMessage("The extension couldn't be started. See the output channel for details.");
        return;
    }

    client.registerProposedFeatures();
    context.subscriptions.push(
        client.start(),
    );
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
