> The server-side gdb was removed: the in-browser wasm engine is the only engine. Questions below that assumed a real gdb process (custom gdb executable, raw gdb output, `--gdb-args`, inferior tty, LLDB/rr) no longer apply.

## How can I see what commands are being sent to the engine?
Go to Settings and check the box that says `Print all sent commands in console, including those sent automatically by gdbgui`

## Does this work with LLDB?
No. There is no gdb or LLDB process; the in-browser wasm engine answers the UI's gdb/MI-style commands.

## Can this debug Python?
No. It only runs C++ in the browser wasm engine.

## Help! There isn't a button for something I want to do. What should I do?
The vast majority of common use cases are handled in the UI, and to keep the UI somewhat simple I do not intend on making UI support for every single command. If you think there should be a UI element for a command or function, create an issue on GitHub and I will consider it.
