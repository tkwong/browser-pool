#!/bin/bash
# Approved stopgap #4: alert when the browser-pool pods' cgroup shmem climbs past
# a sane ceiling. Baseline on a healthy pool is ~506 MiB/pod (one LIVE Xvfb
# framebuffer each) = ~3.0 GiB aggregate; the leak is ORPHAN segments stacking on
# top of that. 8 GiB means orphans are back and climbing toward the 3.44 GiB
# per-pod ceiling.
#
# No notification stack needed: exits non-zero on breach, so the unit shows in
# `systemctl --failed` and the journal line carries an ALERT prefix.
set -u
THRESHOLD_MIB=${THRESHOLD_MIB:-8192}
STAT=${STAT:-/sys/fs/cgroup/kubepods.slice/memory.stat}

if [ ! -r "$STAT" ]; then
  echo "SHMEM_ALERT=unknown reason=cannot_read_$STAT"
  exit 1
fi

bytes=$(awk '$1=="shmem"{print $2; found=1} END{if(!found) print 0}' "$STAT")
mib=$(( bytes / 1048576 ))

pods=0
worst=0
worst_pod=""
for d in /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod*.slice; do
  [ -d "$d" ] || continue
  s=$(awk '$1=="shmem"{print $2; found=1} END{if(!found) print 0}' "$d/memory.stat" 2>/dev/null)
  p=$(( ${s:-0} / 1048576 ))
  pods=$(( pods + 1 ))
  if [ "$p" -gt "$worst" ]; then worst=$p; worst_pod=$(basename "$d"); fi
done

if [ "$mib" -gt "$THRESHOLD_MIB" ]; then
  echo "SHMEM_ALERT kubepods_shmem=${mib}MiB threshold=${THRESHOLD_MIB}MiB pods=$pods worst_pod_shmem=${worst}MiB worst_pod=$worst_pod"
  exit 2
fi

echo "shmem_ok kubepods_shmem=${mib}MiB threshold=${THRESHOLD_MIB}MiB pods=$pods worst_pod_shmem=${worst}MiB"
exit 0
