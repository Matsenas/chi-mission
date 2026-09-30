// Apply a theme chosen with the M key before first paint.
try {
  const t = JSON.parse(localStorage.getItem('chi:theme'));
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = t === 'dark' ? '#161618' : '#f3f2ef';
  }
} catch {}
