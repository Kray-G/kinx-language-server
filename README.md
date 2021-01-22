# kinx-language-server

The Kinx Language Server for VSCode.

# Getting Started

Now this product is under construction. It works with a debug mode only.

1. Install Kinx.
2. Add the path of Kinx to the PATH environment variable.
3. Run VSCode under `kinx-language-server` directory.
4. Press `[F5]` key to run it with a debug mode.
5. Load your Kinx source code.

# Features

* Highlight a source code.
* Detects a script error.
* Detects an unused variable though it is defined.
* Run the current script file on the VSCode.
* Auto-completion.

## Highlight

Your source code will be displayed with a highlight.
It will be suited with your theme color.

![Highlight](docs/images/highlight.png)

## Error

Compile Error will be detected as an error.
You can find and fix it easily.

![Error](docs/images/error.png)

## Warning

Unused variables are detected as a warning.
It is not an error, but you can check it easily.

![Warning](docs/images/warning.png)

## Run Script

You can run your script code on the fly even without saving.
It is easy because of clicking a icon or just pressing a <kbd>Ctrl-R</kbd> key.

![Run](docs/images/run.png)

## Auto Complete

Auto completion is available.
It suggests public methods collected from the class automatically, and it will also include methods on a base class.

![AutoComp](docs/images/autocomp.png)

# License

This project is licensed under the **MIT License**.
See the [LICENSE](LICENSE) file for details.

