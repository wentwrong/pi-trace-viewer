// Parses a Pi JSONL trace (or a JSON array / single object). Invalid lines are skipped and reported, never fatal.
export function parseTrace(text) {
  text = String(text ?? '').replace(/^\uFEFF/, '');
  const entries = [], skipped = [];
  const add = (value, line) => (value && typeof value === 'object' && !Array.isArray(value) ? entries.push(value) : skipped.push(line));
  let whole;
  try { whole = JSON.parse(text); } catch {}
  if (Array.isArray(whole)) whole.forEach((value, i) => add(value, i + 1));
  else if (whole !== undefined) add(whole, 1);
  else text.split(/\r?\n/).forEach((line, i) => { if (!line.trim()) return; try { add(JSON.parse(line), i + 1); } catch { skipped.push(i + 1); } });
  return { entries, skipped };
}
