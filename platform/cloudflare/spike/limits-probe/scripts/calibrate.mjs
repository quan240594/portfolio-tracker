// Node-side calibration of the burn loop: prints how many loop iterations take 1 ms of CPU on THIS machine.
// (Workers freeze Date.now()/performance.now(), so the Worker burns a fixed amount of work, not "until a deadline".)
export function burn(iters) {
  let x = 123456789;
  let acc = 0;
  for (let i = 0; i < iters; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    acc = (acc + (x & 0xff)) | 0;
  }
  return acc;
}
const N = 20_000_000;
burn(1_000_000);
const t0 = process.cpuUsage();
burn(N);
const d = process.cpuUsage(t0);
const ms = (d.user + d.system) / 1000;
console.log(JSON.stringify({ iterations: N, cpuMs: Number(ms.toFixed(1)), itersPerMs: Math.round(N / ms), node: process.version, arch: process.arch }));
