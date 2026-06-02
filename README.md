# CPPcodeVisualizer

**An interactive C++ debugger built for teaching** — step through code while STL containers animate in real time, with synchronized voice narration at every line.

Built on top of [gdbgui](https://github.com/cs01/gdbgui), CPPcodeVisualizer adds a full educational layer: instructors author step-by-step lessons in JSON, students load a lesson file and press Play to watch the program execute with animated container diagrams and spoken explanations — no extra setup needed.

---

## Screenshots

<!-- TODO: replace with animated GIF of the container visualizer in action -->
> *Container visualization + TTS playback demo coming soon.*

---

## Features

- **Animated STL containers** — `vector`, `stack`, `queue`, `deque`, `list`, `set`, `map`, `string`, 2D arrays — rendered as diagrams that update live as the program steps
- **Synchronized TTS narration** — each line speaks a customizable script with variable values substituted in at runtime
- **JSON lesson format** — one file encodes source code, breakpoints, guide text, TTS script, and layout config for every line
- **Auto-step playback** — `[next]` / `[continue]` / `[step-in]` directives inside TTS scripts drive the debugger automatically
- **Element highlighting** — mark specific indices with named or custom colors: `{arr[i]:red}`, `{stack[-1]:yellow}`
- **Sandbox execution** — user programs run in a restricted environment (seccomp filter + resource limits) safe for classroom deployment
- **13 ready-made lessons** — covering sorting, BFS maze, recursion, linked lists, and more (see [Example Lessons](#example-lessons))

---

## Quick Start (Docker)

```bash
git clone -b Develop https://github.com/DVWang2001/CPPcodeVisualizer.git
cd CPPcodeVisualizer
docker-compose up
```

Open **http://localhost:5000** in your browser. No local GDB or compiler installation required.

---

## How to Use

### Running a lesson

1. Click **Import JSON** in the top bar and load any file from the `10個經典案例/` directory.
2. The source code, breakpoints, guide annotations, and TTS scripts are loaded automatically.
3. Click **Run** — the debugger steps through the program, animating each container and reading the narration aloud.
4. You can also drive the debugger manually; guide text and visualizations update at every breakpoint hit.

### Authoring a lesson

See [AUTHORING_GUIDE.md](AUTHORING_GUIDE.md) for the full syntax reference. A minimal lesson looks like:

```json
{
  "version": "1.0",
  "project_name": "my_lesson",
  "source_code": "#include <vector>\n...",
  "line_data": {
    "7": {
      "guide": "Now arr = {arr}, index i = {i}\n{arr[i]:yellow}",
      "tts": "[next] We push {arr[i]} into the stack.",
      "layout": "sidebar:50 open:container"
    }
  },
  "breakpoints": [{ "line": "7", "is_normal_breakpoint": true }]
}
```

---

## Supported Containers

| Container | Visualization |
|-----------|--------------|
| `std::vector` / `std::array` | Horizontal cells with capacity indicator; 2D grid for nested arrays |
| `std::stack` | Right-opening container with structural bar |
| `std::queue` | Horizontal with left/right arrows |
| `std::deque` | Bidirectional horizontal container |
| `std::list` | Double-linked rounded node chain |
| `std::set` / `std::multiset` | Brace set view or red-black tree |
| `std::map` / `std::multimap` | Key-value table or red-black tree |
| `std::unordered_map` | Key-value table |
| `std::string` | Character cell array |

---

## Syntax Quick Reference

### Guide syntax (container panel)

| Syntax | Effect |
|--------|--------|
| `{var}` | Show variable's current value |
| `{arr}` | Render the full container |
| `{arr[i]}` | Render and highlight index `i` (yellow) |
| `{arr[i]:red}` | Highlight index `i` in red |
| `{arr[-1]}` | Highlight the last element |
| `{grid[i][j]}` | Highlight cell `(i, j)` of a 2D array |

### TTS syntax (voice narration)

| Syntax | Effect |
|--------|--------|
| `{var}` | Speak variable's value |
| `[next]` | Auto step-over after speaking |
| `[continue]` | Auto continue to next breakpoint |
| `[step-in]` | Auto step-into after speaking |
| `A \| B \| C` | Speak A on 1st visit, B on 2nd, C on 3rd |
| `@N text` | Speak only from the N-th visit onward |

### Layout syntax (panel control)

| Syntax | Effect |
|--------|--------|
| `sidebar:N` | Set right sidebar width to N% |
| `open:panel1,panel2` | Expand panels |
| `close:panel1` | Collapse panel |

Available panel IDs: `container`, `visualizer`, `callgraph`, `locals`, `compile_errors`, `memory_watch`, `watch_table`

---

## Example Lessons

The `10個經典案例/` directory contains ready-to-use lessons:

| Lesson | Topic |
|--------|-------|
| `vector經典_快速排序` | Quicksort with animated pivot and partition tracking |
| `vector經典_排序` | Bubble / selection sort step-by-step |
| `vector經典_矩陣轉置` | 2D array transpose with grid visualization |
| `stack經典_Rails` | Stack simulation — UVa 514 |
| `queue經典_老鼠走迷宮` | BFS maze solving with queue animation |
| `deque經典_BrokenKeyboard` | Deque insertion/erasure — UVa 11988 |
| `list經典_串列走訪` | Linked list traversal |
| `string經典_迴文判斷` | Palindrome check with character highlighting |
| `遞迴_硬幣所有解析法` | Recursive coin enumeration |
| `for迴圈_因數抽血` | Factor extraction with loop tracing |
| `while迴圈_考拉斯猜想` | Collatz conjecture |
| `while迴圈_貪婪找零` | Greedy change-making |
| `函式_SWAP寫法` | Function call visualization |

---

## Documentation

| File | Description |
|------|-------------|
| [AUTHORING_GUIDE.md](AUTHORING_GUIDE.md) | Full guide/TTS/layout syntax reference for lesson authors |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Architecture overview for developers |
| [SYSTEM_PRINCIPLES.md](SYSTEM_PRINCIPLES.md) | Deep-dive into the data flow and key modules |

---

## Development Setup

### Requirements

- Python 3.13+
- GDB 12+ with libstdc++ pretty-printers
- Node.js 20+

### Build and run locally

```bash
# Install Python dependencies
pip install -e .

# Build frontend
export NODE_OPTIONS="--openssl-legacy-provider"   # Node 20 + Webpack 4
npm install
npm run build

# Start the server
python -m gdbgui
```

On **Windows**, use PowerShell:
```powershell
$env:NODE_OPTIONS="--openssl-legacy-provider"
npm run build
python -m gdbgui
```

---

## Contributing

Contributions are welcome. If your change is small, open a pull request directly. For larger features, please open an issue first to discuss the approach.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

---

## License

MIT.

This project is a fork of [gdbgui](https://github.com/cs01/gdbgui) by Chad Smith, extended with the educational visualization layer described above.
