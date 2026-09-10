/**
 * Linux x86-64 classic BPF for bubblewrap --seccomp. Namespaces/read-only mounts
 * provide filesystem/network isolation; this filter prevents extra processes,
 * namespace changes and kernel-backed allocations outside the address-space cap.
 * execve must remain available for bubblewrap's initial Node bootstrap. A later
 * execve replaces this same bounded process and inherits the filter and limits.
 */
export function createSandboxSeccompPolicy(platform: string = process.platform, arch: string = process.arch): Buffer {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error("Generated-skill isolation requires Linux x64 with bubblewrap and seccomp");
  }
  const instructions: Array<[number, number, number, number]> = [];
  const emit = (code: number, yes: number, no: number, value: number) => {
    instructions.push([code, yes, no, value]);
  };
  const load = (offset: number) => emit(0x20, 0, 0, offset);
  const ret = (value: number) => emit(0x06, 0, 0, value);
  const deny = (syscall: number, errno = 1) => {
    emit(0x15, 0, 1, syscall);
    ret(0x00050000 | errno);
  };

  load(4); // struct seccomp_data.arch
  emit(0x15, 1, 0, 0xc000003e); // AUDIT_ARCH_X86_64
  ret(0x80000000); // SECCOMP_RET_KILL_PROCESS: never interpret another ABI's numbers
  load(0); // syscall number
  emit(0x35, 0, 1, 0x40000000); // Reject the x32 ABI, whose arch identifier is also x86-64.
  ret(0x80000000);

  // fork/vfork; SysV/POSIX IPC; ptrace; mounts; reboot/modules; keyring;
  // perf/fanotify; handle-based opens; namespace operations; process memory;
  // memfd; BPF; execveat; userfaultfd; modern mount API; memfd_secret.
  for (const syscall of [
    29, 30, 57, 58, 64, 68, 69, 101, 155, 165, 166, 169, 175, 176, 240, 241, 248, 249, 250, 272, 298, 300, 303, 308,
    310, 311, 313, 319, 321, 322, 323, 428, 429, 430, 431, 432, 433, 442, 447,
  ])
    deny(syscall);
  for (const syscall of [304, 425, 426, 427]) deny(syscall); // Handle opens and io_uring kernel allocations.
  deny(435, 38); // clone3: ENOSYS makes libc fall back to inspectable clone flags.

  emit(0x15, 0, 4, 56); // clone
  load(16); // low 32 bits of args[0]: flags
  // The qualified glibc pthread flags share VM, FS, FILES and SIGHAND, with
  // THREAD, SYSVSEM, SETTLS, PARENT_SETTID and CHILD_CLEARTID. Requiring the
  // exact mask prevents separate descriptor tables from multiplying nofile.
  emit(0x15, 1, 0, 0x003d0f00);
  ret(0x00050001);
  ret(0x7fff0000);
  ret(0x7fff0000); // Ordinary runtime calls stay within namespace/mount/rlimit boundaries.

  const program = Buffer.alloc(instructions.length * 8);
  for (const [index, [code, yes, no, value]] of instructions.entries()) {
    program.writeUInt16LE(code, index * 8);
    program.writeUInt8(yes, index * 8 + 2);
    program.writeUInt8(no, index * 8 + 3);
    program.writeUInt32LE(value >>> 0, index * 8 + 4);
  }
  return program;
}
