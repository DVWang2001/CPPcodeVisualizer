import re, glob, os, sys, io
sys.stdout.reconfigure(encoding='utf-8')
root = r"C:\碩士\研究\papper\CPPcodeVisualizer\examples"
def strip(src):
    out=[];i=0;n=len(src)
    while i<n:
        c=src[i]
        if src.startswith('//',i):
            j=src.find('\n',i); i=n if j<0 else j; continue
        if src.startswith('/*',i):
            j=src.find('*/',i+2); i=n if j<0 else j+2; out.append(' '); continue
        m=re.match(r'R"([^(]*)\(',src[i:])
        if m:
            end=')'+m.group(1)+'"'; j=src.find(end,i+m.end()); i=n if j<0 else j+len(end); out.append('""'); continue
        if c in '"\'':
            q=c; j=i+1
            while j<n and src[j]!=q:
                if src[j]==chr(92): j+=1
                if j<n and src[j]=='\n': break
                j+=1
            out.append(q+q); i=j+1; continue
        out.append(c); i+=1
    return ''.join(out)
pats = {
 'switch': r'\bswitch\s*\(',
 'do-while': r'\bdo\s*\{',
 'goto': r'\bgoto\b',
 'try/catch/throw': r'\b(try|catch|throw)\b',
 'range-for-init': r'\bfor\s*\([^;()]*;[^;()]*:[^:]',
 'range-for': r'\bfor\s*\([^;{}]*?[^:]:[^:][^;{}]*?\)',
 'class/struct': r'\b(class|struct)\s+\w+\s*(final\s*)?[:{]',
 'operator': r'\boperator\s*(\(\)|[^\w\s(]+|\w+)\s*\(',
 'lambda': r'\[[^\[\]]*\]\s*(\([^)]*\))?\s*(mutable\s*)?(->\s*[\w:<>]+\s*)?\{',
 'template': r'\btemplate\s*<',
 'function-ptr/std::function': r'std::function|\(\s*\*\s*\w+\s*\)\s*\(',
 'new/delete': r'\bnew\b|\bdelete\b',
 'long(non-ll)': r'(?<!long\s)(?<!long)\blong\b(?!\s+long)(?!\s+double)',
 'long long': r'\blong\s+long\b',
 'size_t/sizeof': r'\bsize_t\b|\bsizeof\b',
 'bits/stdc++': r'bits/stdc\+\+|ext/pb_ds|extc\+\+',
 'printf': r'\bprintf\s*\(',
 'thread/atomic/chrono': r'<thread>|<atomic>|<chrono>|std::thread',
}
files = sorted(glob.glob(os.path.join(root,'**','*.cpp'),recursive=True))
print(len(files))
res={k:[] for k in pats}
for f in files:
    raw=open(f,encoding='utf-8',errors='replace').read()
    s=strip(raw)
    # includes survived stripping? includes use <> so ok; bits check on raw include lines
    for k,p in pats.items():
        tgt = raw if k in ('bits/stdc++','thread/atomic/chrono') else s
        if k in ('bits/stdc++','thread/atomic/chrono'):
            tgt='\n'.join(l for l in raw.splitlines() if l.strip().startswith('#include'))
        c=len(re.findall(p,tgt))
        if c: res[k].append((os.path.relpath(f,root).replace(chr(92),'/'),c))
for k,v in res.items():
    print(f"{k}: {len(v)} :: "+', '.join(f"{a}({b})" for a,b in v))
