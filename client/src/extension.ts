"use strict";

import * as path from "path";
import * as child_process from "child_process";
import { ExtensionContext, window as Window, commands as Commands, OutputChannel } from "vscode";
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, TransportKind } from "vscode-languageclient";
let client: LanguageClient;
let outputChannel: OutputChannel;

function runKinx(outputChannel: OutputChannel, filename: string, text: string) {
    let dirname = path.dirname(filename);
    let orgdir = process.cwd();
    process.chdir(dirname);
    let kinx = child_process.exec("kinx -i", (_error, stdout, stderr) => {
        outputChannel.appendLine(stdout);
        outputChannel.appendLine(stderr);
    });
    kinx.stdin?.write(text + '\n__END__');
    kinx.stdin?.end();
    process.chdir(orgdir);
}

export function activate(context: ExtensionContext): void {
    context.subscriptions.push(Commands.registerCommand('kinx.run', () => {
        let doc = Window.activeTextEditor?.document;
        let filename = doc?.fileName;
        if (filename != null) {
            let text = doc?.getText();
            if (text != null) {
                if (outputChannel == null) {
                    outputChannel = Window.createOutputChannel("Kinx Output");
                }
                outputChannel.clear();
                outputChannel.show(true);
                runKinx(outputChannel, filename, text);
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
        documentSelector: [
            {
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
