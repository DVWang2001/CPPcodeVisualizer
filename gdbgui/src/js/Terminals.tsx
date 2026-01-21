import React from "react";
import GdbApi from "./GdbApi";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { store } from "statorgfc";
import "xterm/css/xterm.css";
import constants from "./constants";
import Actions from "./Actions";
import MonacoEditor from "@monaco-editor/react";

function customKeyEventHandler(config: {
  pty_name: string;
  pty: Terminal;
  canPaste: boolean;
  pidStoreKey: string;
}) {
  return async (e: KeyboardEvent): Promise<boolean> => {
    if (!(e.type === "keydown")) {
      return true;
    }
    if (e.shiftKey && e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === "c") {
        const toCopy = config.pty.getSelection();
        navigator.clipboard.writeText(toCopy);
        config.pty.focus();
        return false;
      } else if (key === "v") {
        if (!config.canPaste) {
          return false;
        }
        const toPaste = await navigator.clipboard.readText();

        GdbApi.getSocket().emit("pty_interaction", {
          data: { pty_name: config.pty_name, key: toPaste, action: "write" }
        });
        return false;
      }
    }
    return true;
  };
}

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export class Terminals extends React.Component<any, { programOutput: string }> {
  userPtyRef: React.RefObject<any>;
  programPtyRef: React.RefObject<any>;
  gdbguiPtyRef: React.RefObject<any>;

  constructor(props: any) {
    super(props);
    this.userPtyRef = React.createRef();
    this.programPtyRef = React.createRef();
    this.gdbguiPtyRef = React.createRef();
    this.terminal = this.terminal.bind(this);

    this.state = {
      programOutput: "Program output -- Programs being debugged are connected to this terminal.\nYou can read output here.\n\n"
    };
  }

  terminal(ref: React.RefObject<any>) {
    let className = "relative bg-black p-0 m-0 h-full align-baseline ";
    return (
      <div className={className}>
        <div className="absolute h-full w-full align-baseline  " ref={ref}></div>
      </div>
    );
  }

  render() {
    let terminalsClass = "w-full h-full relative grid grid-cols-3 gap-2";
    return (
      <div className={terminalsClass}>
        {this.terminal(this.userPtyRef)}
        {/* <GdbGuiTerminal /> */}
        {this.terminal(this.gdbguiPtyRef)}

        {/* Replaced Program Pty with Monaco Editor */}
        <div className="h-full w-full overflow-hidden bg-white relative">
          <div className="absolute top-0 left-0 bg-gray-100 text-xs px-2 py-1 z-10 border-b border-gray-300">Standard Output</div>
          <MonacoEditor
            height="100%"
            language="plaintext"
            theme="light"
            value={this.state.programOutput}
            editorDidMount={(getValue: any, editor: any) => {
              editor.onDidChangeModelContent(() => {
                this.setState({ programOutput: getValue() });
              });
            }}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              fontFamily: "monospace",
              renderLineHighlight: "all",
              hideCursorInOverviewRuler: true,
              overviewRulerLanes: 0
            }}
          />
        </div>
      </div>
    );
  }

  componentDidMount() {
    const fitAddon = new FitAddon();
    // const programFitAddon = new FitAddon(); // No longer needed
    const gdbguiFitAddon = new FitAddon();

    const userPty = new Terminal({
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 9999
    });
    userPty.loadAddon(fitAddon);
    userPty.open(this.userPtyRef.current!);
    userPty.writeln(`running command: ${store.get("gdb_command")}`);
    userPty.writeln("");
    userPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({
        pty_name: "user_pty",
        pty: userPty,
        canPaste: true,
        pidStoreKey: "gdb_pid"
      })
    );
    GdbApi.getSocket().on("user_pty_response", function (data: string) {
      userPty.write(data);
    });
    userPty.onKey((data, ev) => {
      GdbApi.getSocket().emit("pty_interaction", {
        data: { pty_name: "user_pty", key: data.key, action: "write" }
      });
      if (data.domEvent.code === "Enter") {
        Actions.onConsoleCommandRun();
      }
    });

    // Program Pty Replacement Logic
    GdbApi.getSocket().on("program_pty_response", (pty_response: string) => {
      // Strip ANSI codes for plain text editor
      const cleanText = pty_response.replace(ansiRegex, '');
      this.setState(prevState => ({
        programOutput: prevState.programOutput + cleanText
      }));
    });

    const gdbguiPty = new Terminal({
      cursorBlink: false,
      macOptionIsMeta: true,
      scrollback: 9999,
      disableStdin: true
      // theme: { background: "#888" }
    });
    gdbguiPty.write(constants.xtermColors.grey);
    gdbguiPty.writeln("gdbgui output (read-only)");
    gdbguiPty.writeln(
      "Copy/Paste available in all terminals with ctrl+shift+c, ctrl+shift+v"
    );
    gdbguiPty.write(constants.xtermColors.reset);

    gdbguiPty.attachCustomKeyEventHandler(
      // @ts-expect-error
      customKeyEventHandler({ pty_name: "unused", pty: gdbguiPty, canPaste: false })
    );

    gdbguiPty.loadAddon(gdbguiFitAddon);
    gdbguiPty.open(this.gdbguiPtyRef.current!);
    // gdbguiPty is written to elsewhere
    store.set("gdbguiPty", gdbguiPty);

    const interval = setInterval(() => {
      fitAddon.fit();
      // programFitAddon.fit(); // No longer needed
      gdbguiFitAddon.fit();
      const socket = GdbApi.getSocket();

      if (socket.disconnected) {
        return;
      }
      socket.emit("pty_interaction", {
        data: {
          pty_name: "user_pty",
          rows: userPty.rows,
          cols: userPty.cols,
          action: "set_winsize"
        }
      });

      // Program Pty resizing is no longer relevant for Monaco, 
      // but maybe keep backend happy? Or just omit.
      // Omit since we are not displaying it via xterm.
    }, 2000);

    setTimeout(() => {
      fitAddon.fit();
      // programFitAddon.fit();
      gdbguiFitAddon.fit();
    }, 0);
  }
}
