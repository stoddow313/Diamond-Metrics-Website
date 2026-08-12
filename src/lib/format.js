// Display formatting for aggregate values. null = unknown → em dash, never 0.
export function fmt(value, { decimals = 1, unit = '' } = {}) {
  if (value == null) return '—';
  let s;
  if (decimals === 3 && value < 2) s = value.toFixed(3).replace(/^0\./, '.');   // .375 baseball style
  else s = Number(value).toFixed(decimals);
  return unit ? `${s} ${unit}` : s;
}

export function downloadCsv(filename, headers, rows) {
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
