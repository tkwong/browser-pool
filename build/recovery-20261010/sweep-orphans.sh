#!/bin/bash
# Approved stopgap #2: delete ONLY unattached (nattch=0) SysV shm segments inside
# each browser pod's IPC namespace. Attached segments are never touched.
# Column note: /proc/sysvipc/shm index 6 == nattch (index 5 is lpid).
set -u
python3 - <<'PY'
import json,subprocess

def sh(c):
    return subprocess.run(c,shell=True,capture_output=True,text=True)

pods={}
for cid in sh("k3s crictl ps -q").stdout.split():
    try: d=json.loads(sh(f"k3s crictl inspect {cid}").stdout)
    except Exception: continue
    pod=d["status"]["labels"].get("io.kubernetes.pod.name","")
    pid=d.get("info",{}).get("pid")
    if pod.startswith("chrome-vnc-") and pid: pods.setdefault(pod,pid)

removed=0; nominal=0
for pod,pid in sorted(pods.items()):
    rows=[r.split() for r in sh(f"nsenter -t {pid} -i cat /proc/sysvipc/shm").stdout.splitlines()[1:] if r.strip()]
    for r in rows:
        if len(r)>6 and r[6]=="0":
            if sh(f"nsenter -t {pid} -i ipcrm -m {r[1]}").returncode==0:
                removed+=1; nominal+=int(r[3])
print(f"orphans_removed={removed} nominal_MiB={round(nominal/1048576)}")
PY
