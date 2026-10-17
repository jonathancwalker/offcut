const $ = id => document.getElementById(id);
const statuses = {ready:'Ready',running:'Running',pausing:'Pausing',paused:'Paused',completed:'Completed',stopped:'Stopped',blocked:'Blocked',closed:'Closed'};
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
async function request(path) { const response = await fetch(path, {cache:'no-store'}); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`); return body; }
function render(studies) {
  $('study-count').textContent = studies.length ? `· ${studies.length}` : '';
  $('study-list').replaceChildren(...studies.map(study => {
    const link = element('a', 'study-card'); link.href = `/study.html?study=${encodeURIComponent(study.id)}`;
    const heading = element('div', 'study-card-heading'); heading.append(element('h2', '', study.label || study.id), element('span', `study-status study-status-${study.status}`, statuses[study.status] || study.status));
    const meta = element('p', 'study-card-meta', `${study.kind || 'Study'} · ${study.progress?.total ?? 0} cells · ${new Date(study.createdAt).toLocaleDateString()}`);
    const progress = element('p', 'study-card-progress', Object.entries(study.progress?.statuses || {}).map(([status, count]) => `${count} ${statuses[status] || status.toLowerCase()}`).join(' · '));
    link.append(heading, meta, progress); return link;
  }));
  $('studies-loading').hidden = true; $('studies-error').hidden = true; $('study-list').hidden = !studies.length; $('studies-empty').hidden = Boolean(studies.length);
}
async function load() { $('studies-error').hidden = true; try { render((await request('/api/studies')).studies || []); } catch (error) { $('studies-loading').hidden = true; $('studies-error-message').textContent = error.message; $('studies-error').hidden = false; } }
$('retry-studies').addEventListener('click', load); load();
