const ts = () => new Date().toISOString().slice(11, 19);
const quiet = process.env.LOG_LEVEL === 'warn';
export const log = {
  info: (m: string) => { if (!quiet) console.log(`${ts()} ${m}`); },
  warn: (m: string) => console.warn(`${ts()} ⚠ ${m}`),
  error: (m: string) => console.error(`${ts()} ✖ ${m}`),
};
