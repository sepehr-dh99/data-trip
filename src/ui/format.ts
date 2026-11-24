export function humanSize(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined || n < 0) return undefined;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Number(v.toFixed(1))} ${u[i]}`;
}
