# Kinx Language Server

### Installing

```
npm install -g kinx-server
```


### Running the Language server

```
kinx-server --studio
```



## Editor Extension Support

* [x] Visual Studio Code
* [ ] Atom
* [ ] Sublime Text
* [ ] Vim/NeoVim
* [ ] Emacs

### Visual Studio Code

Kinx Server for VS Code is available [here]()


### Atom IDE



### Sublime Text

[LSP](https://github.com/tomv564/LSP) (untested)

```json
"kinxsvr": {
    "command": [
        "kinx-server",
        "--studio",
    ],
    "enabled": true,
    "languageId": "kinx"
}
```

### vim and neovim

1. Install `kinx-server`
2. Install [LanguageClient-neovim](https://github.com/autozimu/LanguageClient-neovim/blob/next/INSTALL.md)
3. Add the following to neovim's configuration (the case if you want to use for kinx)

```vim
let g:LanguageClient_serverCommands = {
    \ 'kinx': ['kinx-server', '--stdio'],
    \ }
```

### Emacs

[lsp-mode](https://github.com/emacs-lsp/lsp-mode) (untested)
