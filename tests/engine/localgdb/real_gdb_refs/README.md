# Real GDB 16.3 ground truth: reference parameters and std::array / std::string varobjs

Captured 2026-10-05 from `gdb --interpreter=mi2` (GNU gdb 16.3 Debian, libstdc++ pretty-printers loaded from
/etc/gdb/gdbinit, `-enable-pretty-printing`), program compiled `g++ -g -O0`, stopped at the breakpoint in `f` /
`e2e_bp`. The `.expected.txt` files are the raw `^done/^error` result records for the commands in the matching
`.mi.txt` (addresses and thread-id are the real ones; compare modulo `@0x...`/0x... addresses).

Findings these files pin (they contradict earlier comments in `varobj.js`, which extrapolated from
`-stack-list-variables`):
- `-var-create` / `-var-evaluate-expression` / `-var-update` of a REFERENCE variable never carry the `@0xADDR: `
  prefix, for printer types (vector, string, set) and scalars alike. `-stack-list-arguments` still does for
  non-printer values (`@0x...: 7`, `@0x...: {_M_elems = {1, 2, 3}}`).
- `std::array<T,N>` has no pretty-printer in this GDB: varobj value `{...}`, numchild 1, children
  `NAME.public` (value "") -> `NAME.public._M_elems` (value `[N]`, type `std::__array_traits<T, N>::_Type`,
  numchild N) -> `NAME.public._M_elems.0 ...` (exp "0", ...). The frontend's ArrayParser "Strategy 2" consumes
  exactly this shape.
Regenerate: run the `.mi.txt` against a binary built from the matching `.cpp` (docker image
cppcodevisualizer-gdbgui has gdb 16.3 + printers): `HOME=/nonexistent gdb -q --interpreter=mi2 BIN < X.mi.txt`.
