export async function waitForSmokeStop(milliseconds, earlyFailure) {
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
      earlyFailure,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
