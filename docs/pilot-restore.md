# Restore a private isolated server runtime

This command creates a new runtime from explicitly pinned inputs. It never
starts a server, resets the live world, edits the source archive, or accepts
the Minecraft EULA for the operator.

```bash
python3 -m tools.pilot.restore \
  --archive /private/backups/world-TIMESTAMP.tar.zst \
  --archive-sha256 REVIEWED_BACKUP_SHA256 \
  --jar /private/reviewed/server.jar \
  --jar-sha256 REVIEWED_JAR_SHA256 \
  --eula /private/existing-accepted-eula.txt \
  --output /private/new-runtime
```

The destination must not exist and its parent must exist without symlinks.
The EULA input must be an existing regular file containing exactly one active
`eula=true` setting; comments and blank lines are allowed. The command copies
that file unchanged. It does not create acceptance. The archive and JAR are
copied from stable descriptors into private staging, checked against caller
pins, and only then used. Generated runtime files are 0600 and directories
0700. Existing files are never overwritten. Failed restoration may leave a
partial runtime without a completion manifest; preserve it for diagnosis and
choose a new output path for a retry.

Accepted backup members are ordinary files/directories under `ai-world`,
`ai-world_nether`, and `ai-world_the_end`. All three roots and overworld
`level.dat` must be present. For compatibility with the existing backup script,
root `server.properties`, `usercache.json`, `ops.json`, and `whitelist.json`
are consumed but discarded, each capped at 1 MiB. Nothing else outside the
world trees is accepted. The tool never copies live configuration, player
metadata files at archive root, plugins, executables, or archive-provided EULA
files. World-contained player data remains part of the private snapshot.

The raw tar scanner rejects extensions, sparse entries, links, devices,
traversal, duplicate and conflicting paths, truncation, and malformed padding
or termination. Names are bounded in length/depth and implicit directories are
counted. Decompression has a five-minute deadline and bounded output; errors
are reported without echoing archive contents. Default bounds are 8 GiB
compressed/archive input, 512 MiB JAR, 4 GiB expanded payload and 100,000
members/expanded paths. The storage checks reserve 40 GiB; a reviewed filesystem
policy can supply `--reserve-bytes`. Storage checks cannot reserve space
against unrelated concurrent writers.

The generated properties bind gameplay to loopback on port 25585, disable
RCON/query/status, require online authentication, and use `level-name=ai-world`.
These are isolation settings, not a claim of experimental equivalence to the
live server. Startup must additionally use the controller's network namespace;
a loopback address alone is not its security boundary.

`runtime-manifest.json` is written last and identifies the snapshot and JAR,
restored file hashes and sizes, discarded entries, and `restored_not_started`.
The CLI prints its SHA-256 for the controller to pin. `verify_runtime` checks
all listed files and rejects unlisted files, symlinks, unsafe configuration and
nonprivate paths before launch. Hashes establish byte identity only: Minecraft
format validity, exact server version, readiness, the loaded world, and trial
validity remain unverified until separate real-server qualification.

Automated regression tests use
small synthetic `.tar` and `.tar.zst` archives and a non-executable fake JAR.

## Offline Paper bootstrap cache

Paperclip requires a vanilla-server cache before its first boot. For a pinned
Paper JAR that declares `META-INF/download-context`, add
`--bootstrap /private/cache/mojang_1.21.4.jar` to restore. The destination filename
and SHA-256 are derived from that pinned JAR's bounded metadata. The supplied
cache is copied and hashed from a stable descriptor, then listed in the runtime
manifest. Nothing is downloaded and existing generated libraries are not copied.
The launcher still has no network access.

Only the declared `cache/mojang_<numeric-version>.jar` file is permitted. A
wrong cache hash, unsupported declaration, or altered manifest is rejected.
Older runtime manifests without a bootstrap field remain valid; omitting the
cache may cause an honest offline startup failure. The bootstrap cache is an
explicit input, never discovered automatically from the live server directory.
