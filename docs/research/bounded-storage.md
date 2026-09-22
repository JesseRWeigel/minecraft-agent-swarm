# Bounded persistent trial storage

The protected fixed-client launcher uses a fresh fixed-size ext4 image for each
attempt. Restore staging, the disposable world, Java output and runtime evidence
share that capacity. The complete image is retained after an ordinary unmount;
it is private evidence and may contain server credentials and world data.

This is an optional research dependency, outside normal swarm startup. The host
must provide the explicitly pinned FUSE2FS executable and libfuse library, a
working `/dev/fuse`, and root-owned `mkfs.ext4`, `fusermount3` and `prlimit` tools.
The launcher captures the small pinned files into the new attempt. It does not
install packages or change the live swarm. It only formats its exclusively
created image, never an existing device or operator-supplied filesystem image.

The image is fully allocated before use, after checking a 40 GiB host free-space
reserve. Formatting disables discard to retain that allocation. This is not a
quota for unrelated host processes. The default image is 2 GiB.
Restore retains a 64 MiB reserve inside that volume;
archive path, hash, member-count and expanded-size checks still apply. A backup
that cannot fit, including temporary decompression and copies, fails preparation.
This reserve is not a guaranteed amount of free space once gameplay starts.
The outer temporary filesystem is separately capped at 64 MiB; the participant's
two existing scratch filesystems remain 16 MiB each.

The FUSE daemon is a trusted host helper, outside the game's aggregate cgroup.
Its limits are 512 MiB of address space, 120 seconds of CPU time and a maximum
file size equal to the image capacity, separate from the game budget. Helper
stdout/stderr are discarded rather than accumulated on the host.
These limits do not qualify arbitrary native code or bound GPU memory.
Game acceptance requires both valid game/resource evidence and verified storage
cleanup. Missing evidence or uncertain unmount cannot yield a qualified attempt.
All failed attempts remain failures even if later controls succeed.

## Qualification

[All attempts and source pins](storage-results-2026-09-22.json) are retained:

| Case | Outcome |
| --- | --- |
| First 2 GiB forward game | Qualified, 3.582064 blocks; preceded the dead-helper cleanup fix |
| Final-source 2 GiB stationary game | Qualified negative control, zero movement |
| Final-source 2 GiB forward game | Qualified, 4.153332 blocks |
| Deliberately undersized 64 MiB launcher image | Restore rejected before game launch; clean unmount |
| Final-source 64 MiB full-volume probe | `ENOSPC` after 55,967,744 bytes; image stayed exactly 67,108,864 bytes |
| Deliberately killed FUSE helper | Invalid storage result; stale mount removed and image retained |

Both final-source game controls had normal Java/participant exits, completed game
relays, verified resource limits with no limit events, and clean scope and storage
cleanup. After unmounting, read-only `debugfs` extraction recovered each game's
result JSON and overworld `level.dat` with the exact hashes captured before
unmounting. Image hashes stayed unchanged during those checks. This verifies
those evidence files, not every Minecraft region's semantic consistency.

The full-volume probe's entire written file was also recovered after unmounting.
Earlier module and standalone development probes are included in the results.
An abrupt helper death remains an invalid attempt even when cleanup succeeds;
preserving its image does not prove filesystem consistency after that crash.

The original source archive was rehashed unchanged. No live swarm process, mode,
world or model was changed. These historical tests filled a synthetic volume or
failed during preparation. A later [running-server disk-full qualification](disk-full-qualification.md)
now covers exhaustion after the action and before terminal evidence persistence.
Neither set establishes model performance or research conclusions.

## Local reproduction

Call `run_protected_qualification` with the existing pinned archive, server JAR,
accepted EULA, cached bootstrap and client snapshot, plus `storage_tool_root`.
That directory must contain `usr/bin/fuse2fs` and
`lib/x86_64-linux-gnu/libfuse.so.2.9.9` matching the source pins in
`tools/pilot/bounded_storage.py`. Use a new private attempt path and explicit
`launch=True`. Ordinary tests do not mount filesystems or start Minecraft.

The tools came from Ubuntu packages
`fuse2fs_1.47.0-2.4~exp1ubuntu4.1_amd64.deb` and
`libfuse2t64_2.9.9-8.1build1_amd64.deb`, extracted privately without system
installation. The module checks extracted binary/library hashes, not package
names. Host libraries and protected system utilities remain trusted dependencies;
this is not a portable hermetic toolchain.

The implementation targets that qualified Ubuntu x86-64 helper build. Do not
substitute a different binary under the same pin or infer portability from unit
tests. See the [FUSE2FS manual](https://man7.org/linux/man-pages/man1/fuse2fs.1.html)
for the image mount mechanism and [whole-trial scope](scoped-trials.md) for game
process limits. Actor identity, remaining fault cases, public reproduction inputs
and the model comparison remain separate release gates.
