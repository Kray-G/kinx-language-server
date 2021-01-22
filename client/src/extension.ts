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
    let kinx = child_process.exec("kinx -i", (error, stdout, stderr) => {
        if (stdout) {
            outputChannel.appendLine(stdout);
        }
        if (stderr) {
            outputChannel.appendLine(stderr);
        }
        outputChannel.appendLine("----------------------------------------------------------------");
        if (error) {
            outputChannel.appendLine("Exit code = " + error.code);
        } else {
            outputChannel.appendLine("Exit code = 0");
        }
        outputChannel.appendLine("");
    });
    let srccode = "var tmr = new SystemTimer(); try { " +
                text +
                "} catch (e) {" +
                "System.println('>>> Exception Occurred'); " +
                "System.println(e.type() + ': ' + e.what()); " +
                "e.printStackTrace(); " +
                "} finally {" +
                "System.println('\n----------------------------------------------------------------'); " +
                "System.println('Elapsed(in seconds): %f' % tmr.elapsed()); " +
                "}" +
                "\n__END__";
    kinx.stdin?.write(srccode);
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
                outputChannel.show(true);
                outputChannel.appendLine("================================================================");
                outputChannel.appendLine("Started at " + new Date(Date.now()).toString());
                outputChannel.appendLine("");
                outputChannel.appendLine("---- R E S U L T -----------------------------------------------");
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
