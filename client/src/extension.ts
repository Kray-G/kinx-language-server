"use strict";

import * as path from "path";
import * as child_process from "child_process";
import { ExtensionContext, window as Window, commands as Commands, OutputChannel, workspace as Workspace } from "vscode";
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, TransportKind } from "vscode-languageclient";
let client: LanguageClient;
let outputChannel: OutputChannel;

function runKinx(outputChannel: OutputChannel, filename: string, text: string) {
    let settings = Workspace.getConfiguration("kinx");
    let exepath = settings.get("execPath");
    if (exepath === "") exepath = "kinx";

    let dirname = path.dirname(filename);
    let orgdir = process.cwd();
    process.chdir(dirname);
    let kinx = child_process.exec('"' + exepath + '" -i', (_error, stdout, stderr) => {
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

function runKinxHook(filename: string, text: string, mode: string) {
    if (outputChannel == null) {
        outputChannel = Window.createOutputChannel("Kinx Output");
    }
    outputChannel.show(true);
    outputChannel.appendLine("[" + mode + "] Started at " + new Date(Date.now()).toString());
    outputChannel.appendLine("----");
    runKinx(outputChannel, filename, text);
}

export function activate(context: ExtensionContext): void {
    context.subscriptions.push(Commands.registerCommand('kinx.run', () => {
        let doc = Window.activeTextEditor?.document;
        let filename = doc?.fileName;
        if (filename != null) {
            let text = doc?.getText();
            if (text != null) {
                runKinxHook(filename, text, "Full");
            }
        }
    }));
    context.subscriptions.push(Commands.registerCommand('kinx.runRange', () => {
        let editor = Window.activeTextEditor;
        let doc = editor?.document;
        let filename = doc?.fileName;
        if (filename != null) {
            let text = doc?.getText(editor?.selection);
            if (text != null) {
                runKinxHook(filename, text, "Range");
            }
        }
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
