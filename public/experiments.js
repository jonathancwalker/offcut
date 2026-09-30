// Preserve links to works saved before Library became the home page.
const run = new URL(location.href).searchParams.get('run');
location.replace(run ? `/work.html?run=${encodeURIComponent(run)}` : '/');
