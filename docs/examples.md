
# Examples
## Code Examples
View code examples on [GitHub](https://github.com/cs01/gdbgui/tree/master/examples).

## gdbgui Invocation Examples

launch gdbgui

```
gdbgui
```

(Loading a program from the command line, `--args`, and `--gdb-cmd` were removed together with the server-side gdb; programs are written in the editor and run by the in-browser wasm engine.)

run on port 8080 instead of the default port

```
gdbgui --port 8080
```



run on a server and host on 0.0.0.0. Accessible to the outside world as long as port 80 is not blocked.

```
gdbgui -r
```

Same as previous but will prompt for a username and password

```
gdbgui -r --auth
```

Same as previous but with encrypted https connection.
```
openssl req -newkey rsa:2048 -nodes -keyout private.key -x509 -days 365 -out host.cert
```
```
gdbgui -r --auth --key private.key --cert host.cert
```

Don't automatically open the browser when launching

```
gdbgui -n
```
