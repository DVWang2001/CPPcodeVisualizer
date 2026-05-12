import subprocess
import time

cmd = ["gdb", "-q", "-nw", "--interpreter=mi", "./test_queue.a"]
process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

commands = [
    "-break-insert test_queue.cpp:18\n",
    "-break-insert test_queue.cpp:19\n",
    "-exec-run\n",
    "-var-create qv * q\n",
    "-var-info-type qv\n",
    "-var-info-num-children qv\n",
    "-var-evaluate-expression qv\n",
    "-var-create distv * dist\n",
    "-var-info-type distv\n",
    "-var-info-num-children distv\n",
    "-var-evaluate-expression distv\n",
    "-var-list-children 1 distv\n",
    "-gdb-exit\n"
]

for c in commands:
    process.stdin.write(c)

process.stdin.flush()
out, err = process.communicate()
print("OUTPUT:")
print(out)
