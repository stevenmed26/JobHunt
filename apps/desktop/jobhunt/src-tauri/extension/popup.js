'use strict';

const ENGINE = 'http://127.0.0.1:38471';

// ─── State machine ────────────────────────────────────────────────────────────

const STATES = ['NotJob','Offline','NoProfile','Ready','Working','Review','Success'];

function show(name) {
  STATES.forEach(s => {
    const el = document.getElementById(`state${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const atsBadge     = document.getElementById('atsBadge');
const jobTitle     = document.getElementById('jobTitle');
const jobCompany   = document.getElementById('jobCompany');
const btnScrape    = document.getElementById('btnScrape');
const btnFill      = document.getElementById('btnFill');
const btnRescrape  = document.getElementById('btnRescrape');
const btnFillAgain = document.getElementById('btnFillAgain');
const fieldsList   = document.getElementById('fieldsList');
const fieldCount   = document.getElementById('fieldCount');
const workingMsg   = document.getElementById('workingMsg');
const successCount = document.getElementById('successCount');
const statusDot    = document.getElementById('statusDot');
const statusMsg    = document.getElementById('statusMsg');

// ─── Status bar helpers ───────────────────────────────────────────────────────

function setStatus(color, msg) {
  statusDot.style.background =
    color === 'green'  ? 'var(--green)'  :
    color === 'red'    ? 'var(--red)'    :
    color === 'yellow' ? 'var(--yellow)' :
                         'rgba(255,255,255,0.2)';
  statusMsg.textContent = msg;
}

// ─── Engine comms ─────────────────────────────────────────────────────────────

async function engineGet(path) {
  const res = await fetch(`${ENGINE}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function enginePost(path, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text() || `${res.status}`);
  return res.json();
}

// ─── Content script comms ─────────────────────────────────────────────────────

function sendToContent(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

// ─── Groq fill via engine proxy ───────────────────────────────────────────────

async function fillFieldsWithGroq(fields, profile, jobDesc) {
  // Two passes — same logic as the Tauri app (applyLLM.ts)

  const isCover = (f) =>
    f.label.toLowerCase().includes('cover') ||
    f.label.toLowerCase().includes('letter') ||
    f.selector === '#cover_letter_text' ||
    f.selector === '#cover_letter';

  const shortFields = fields.filter(f => f.type !== 'file' && !isCover(f));
  const coverFields = fields.filter(f => f.type !== 'file' && isCover(f));

  const profileBlock = buildProfileBlock(profile);
  const answers = {};

  // Pass 1 — short fields
  if (shortFields.length > 0) {
    const fieldSummary = shortFields.map(f => ({
      selector: f.selector,
      label:    f.label,
      type:     f.type,
      required: f.required,
      options:  f.options.slice(0, 30).map(o => o.label),
    }));

    const system = `You are filling out a job application form.
Return ONLY a JSON array — no markdown, no explanation:
[{ "selector": "<selector>", "value": "<answer>" }, ...]

Rules:
- For select fields, value MUST exactly match one of the provided options.
- For EEO fields map profile values: male→"Male", female→"Female", prefer_not→"I prefer not to say" or closest.
  race: white→"White", black→"Black or African American", hispanic→"Hispanic or Latino", asian→"Asian", prefer_not→"Decline to self identify".
  veteran: yes→"Protected Veteran", no→"I am not a protected veteran", prefer_not→"I prefer not to say".
  disability: yes→"Yes, I have a disability", no→"No, I don't have a disability", prefer_not→"I Don't Wish to Answer".
- For sponsorship: us_citizen/green_card → No, h1b/other → Yes.
- For country questions use the applicant's country field.
- Keep answers concise (one sentence max).`;

    const user = `${profileBlock}\n\nJOB DESCRIPTION:\n${(jobDesc||'').slice(0,800)}\n\nFORM FIELDS:\n${JSON.stringify(fieldSummary, null, 2)}`;

    try {
      const data = await enginePost('/api/llm', {
        system: system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 1500,
      });
      const parsed = JSON.parse((data.text || '').replace(/```json|```/g, '').trim());
      parsed.forEach(a => { if (a.selector && a.value) answers[a.selector] = a.value; });
    } catch (e) {
      console.warn('[JobHunt] Pass 1 parse failed:', e);
    }
  }

  // Pass 2 — cover letter as plain text
  if (coverFields.length > 0) {
    const system = `You are writing a cover letter for a job application.
Write ONLY the cover letter text — plain text, no JSON, no markdown, nothing else.
3 short paragraphs separated by a blank line:
- Paragraph 1: Genuine interest in the role and company (2 sentences, use real company name).
- Paragraph 2: 2-3 relevant experiences from the resume matching the job.
- Paragraph 3: Enthusiasm and call to action (1-2 sentences).
Keep it under 300 words. No placeholders.`;

    const user = `${profileBlock}\n\nRESUME:\n${profile.resumeText||'(not provided)'}\n\nCOVER LETTER TEMPLATE:\n${profile.coverLetterText||'(not provided)'}\n\nJOB DESCRIPTION:\n${jobDesc||'(not available)'}`;

    try {
      const data = await enginePost('/api/llm', {
        system: system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 600,
      });
      const text = (data.text || '').trim();
      if (text) coverFields.forEach(f => { answers[f.selector] = text; });
    } catch (e) {
      console.warn('[JobHunt] Cover letter call failed:', e);
    }
  }

  // Merge answers back
  return fields.map(f => {
    const val = answers[f.selector];
    if (!val) return f;
    // Snap selects to valid option
    if ((f.type === 'select' || f.isReactSelect) && f.options.length > 0) {
      const exact = f.options.find(o =>
        o.label.toLowerCase() === val.toLowerCase() ||
        o.value.toLowerCase() === val.toLowerCase()
      );
      if (exact) return { ...f, value: exact.label };
      const fuzzy = f.options.find(o =>
        o.label.toLowerCase().includes(val.toLowerCase().slice(0, 6)) ||
        val.toLowerCase().includes(o.label.toLowerCase().slice(0, 6))
      );
      if (fuzzy) return { ...f, value: fuzzy.label };
    }
    return { ...f, value: val };
  });
}

function buildProfileBlock(p) {
  return `APPLICANT PROFILE:
Name: ${p.firstName||''} ${p.lastName||''}
Email: ${p.email||''}
Phone: ${p.phone||''}
Location: ${p.location||''}
Country: ${p.country||'United States'}
City: ${p.city||''}
State: ${p.state||''}
Current title: ${p.currentTitle||''}
Years experience: ${p.yearsExperience||''}
Work authorization: ${p.workAuth||''}
Requires sponsorship: ${p.requiresSponsorship ? 'yes' : 'no'}
Authorized to work: ${p.authorizedToWork !== false ? 'yes' : 'no'}
Desired salary: ${p.desiredSalary||''}
Notice period: ${p.noticePeriod||''}
LinkedIn: ${p.linkedinURL||''}
GitHub: ${p.githubURL||''}
Previously employed here: ${p.previouslyEmployed ? 'yes' : 'no'}
Employment restrictions: ${p.employmentRestrictions||'none'}
Gender (EEO): ${p.gender||'prefer_not'}
Race/ethnicity (EEO): ${p.race||'prefer_not'}
Veteran status (EEO): ${p.veteranStatus||'prefer_not'}
Disability status (EEO): ${p.disabilityStatus||'prefer_not'}`;
}

// ─── Field review UI ──────────────────────────────────────────────────────────

let currentFields = [];

function renderFields(fields) {
  currentFields = fields;
  fieldsList.innerHTML = '';
  const nonFile = fields.filter(f => f.type !== 'file');
  fieldCount.textContent = `${nonFile.length} fields`;

  nonFile.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'field-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'field-label';
    labelRow.innerHTML = `<span>${f.label}${f.required ? ' <span class="required">*</span>' : ''}</span><span class="field-type">${f.type}</span>`;
    row.appendChild(labelRow);

    const isCover = f.label.toLowerCase().includes('cover') || f.label.toLowerCase().includes('letter');
    const isLong  = f.type === 'textarea' || isCover || (f.value?.length ?? 0) > 80;

    if (f.type === 'select' || f.type === 'react-select') {
      const sel = document.createElement('select');
      sel.className = 'field-select';
      sel.innerHTML = '<option value="">— select —</option>';
      f.options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.label;
        opt.textContent = o.label;
        if (o.label === f.value) opt.selected = true;
        sel.appendChild(opt);
      });
      if (f.value && !f.options.find(o => o.label === f.value)) {
        const opt = document.createElement('option');
        opt.value = f.value; opt.textContent = f.value; opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => { currentFields[i] = { ...currentFields[i], value: sel.value }; });
      row.appendChild(sel);
    } else if (isLong) {
      const ta = document.createElement('textarea');
      ta.className = 'field-input';
      ta.rows = isCover ? 6 : 3;
      ta.value = f.value || '';
      ta.placeholder = '—';
      ta.addEventListener('input', () => { currentFields[i] = { ...currentFields[i], value: ta.value }; });
      row.appendChild(ta);
    } else {
      const inp = document.createElement('input');
      inp.className = 'field-input';
      inp.value = f.value || '';
      inp.placeholder = '—';
      inp.addEventListener('input', () => { currentFields[i] = { ...currentFields[i], value: inp.value }; });
      row.appendChild(inp);
    }

    fieldsList.appendChild(row);
  });
}

// ─── Main flow ────────────────────────────────────────────────────────────────

let currentTab  = null;
let pageInfo    = null;
let profile     = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  const url = tab.url || '';
  const isJobPage =
    url.includes('boards.greenhouse.io') ||
    url.includes('job-boards.greenhouse.io') ||
    url.includes('jobs.lever.co');

  if (!isJobPage) { show('NotJob'); setStatus('grey', 'Not a job page'); return; }

  // Check engine
  try {
    await fetch(`${ENGINE}/health`);
  } catch {
    show('Offline'); setStatus('red', 'Engine offline'); return;
  }

  // Load profile
  try {
    const p = await engineGet('/api/profile');
    if (!p || !p.firstName) { show('NoProfile'); setStatus('yellow', 'No profile saved'); return; }
    profile = p;
  } catch {
    show('NoProfile'); setStatus('yellow', 'No profile saved'); return;
  }

  // Get page info from content script
  try {
    pageInfo = await sendToContent(tab.id, { type: 'GET_PAGE_INFO' });
  } catch {
    show('NotJob'); setStatus('grey', 'Could not reach page'); return;
  }

  // Update UI
  const ats = pageInfo.ats || 'unknown';
  atsBadge.textContent = ats;
  atsBadge.className = `ats-badge ${ats}`;
  atsBadge.style.display = '';
  jobTitle.textContent   = pageInfo.title   || tab.title || '—';
  jobCompany.textContent = pageInfo.company || '—';

  setStatus('green', 'Ready');
  show('Ready');
}

async function runScrapeAndFill() {
  show('Working');
  setStatus('yellow', 'Reading form fields…');
  workingMsg.textContent = 'Reading form fields…';

  let fields;
  try {
    const res = await sendToContent(currentTab.id, { type: 'SCRAPE_FIELDS' });
    fields = res.fields;
    setStatus('yellow', `Filling ${fields.length} fields with Groq…`);
    workingMsg.textContent = `Filling ${fields.length} fields with Groq…`;
  } catch (e) {
    show('Ready');
    setStatus('red', 'Scrape failed: ' + e.message);
    return;
  }

  try {
    fields = await fillFieldsWithGroq(fields, profile, '');
  } catch (e) {
    show('Ready');
    setStatus('red', 'Groq error: ' + e.message);
    return;
  }

  // Inject immediately — no manual review step
  workingMsg.textContent = 'Injecting into form…';
  try {
    const res = await sendToContent(currentTab.id, { type: 'INJECT_FIELDS', fields });
    currentFields = fields;
    successCount.textContent = `${res.filled} of ${fields.filter(f => f.type !== 'file').length} fields filled`;
    show('Success');
    setStatus('green', 'Done — review and submit');
  } catch (e) {
    show('Ready');
    setStatus('red', 'Inject failed: ' + e.message);
  }
}

async function runInject() {
  btnFill.disabled = true;
  setStatus('yellow', 'Injecting fields…');
  try {
    const res = await sendToContent(currentTab.id, { type: 'INJECT_FIELDS', fields: currentFields });
    successCount.textContent = `${res.filled} of ${currentFields.filter(f => f.type !== 'file').length} fields filled`;
    show('Success');
    setStatus('green', 'Done — review and submit');
  } catch (e) {
    setStatus('red', 'Inject failed: ' + e.message);
  } finally {
    btnFill.disabled = false;
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

btnScrape.addEventListener('click', runScrapeAndFill);
btnRescrape.addEventListener('click', runScrapeAndFill);
btnFillAgain.addEventListener('click', () => {
  if (currentFields.length > 0) {
    renderFields(currentFields);
    show('Review');
    setStatus('green', 'Edit fields then click Fill');
  } else {
    runScrapeAndFill();
  }
});
btnFill.addEventListener('click', runInject);

// ─── Boot ─────────────────────────────────────────────────────────────────────

init().catch(e => {
  show('Offline');
  setStatus('red', e.message);
});