'use strict';

// background.js — service worker
// Handles the floating button click message from content.js,
// runs the full scrape → Groq fill → inject pipeline without opening the popup.

const ENGINE = 'http://127.0.0.1:38471';

async function engineGet(path) {
  const res = await fetch(`${ENGINE}${path}`);
  if (!res.ok) throw new Error(`Engine ${res.status}`);
  return res.json();
}

async function enginePost(path, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text() || `Engine ${res.status}`);
  return res.json();
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(r);
    });
  });
}

function setFloat(tabId, state, msg) {
  chrome.tabs.sendMessage(tabId, { type: 'SET_FLOAT_STATE', state, msg }).catch(() => null);
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runAutoApply(tabId) {
  setFloat(tabId, 'working', 'Reading fields…');

  // 1. Check engine + load profile
  let profile;
  try {
    profile = await engineGet('/api/profile');
    if (!profile || !profile.firstName) throw new Error('No profile saved — open JobHunt app first');
  } catch (e) {
    setFloat(tabId, 'error', 'Engine offline');
    return;
  }

  // 2. Scrape fields from the live page
  let fields;
  try {
    const res = await sendToTab(tabId, { type: 'SCRAPE_FIELDS' });
    fields = res.fields;
    setFloat(tabId, 'working', `Filling ${fields.length} fields…`);
  } catch (e) {
    setFloat(tabId, 'error', 'Scrape failed');
    return;
  }

  // 3. Fill with Groq
  try {
    fields = await fillWithGroq(fields, profile);
  } catch (e) {
    setFloat(tabId, 'error', 'Groq error');
    return;
  }

  // 4. Inject into page
  try {
    const res = await sendToTab(tabId, { type: 'INJECT_FIELDS', fields });
    setFloat(tabId, 'done', `${res.filled} fields filled`);
  } catch (e) {
    setFloat(tabId, 'error', 'Inject failed');
  }
}

// ─── Groq fill (mirrors popup.js and applyLLM.ts) ────────────────────────────

async function fillWithGroq(fields, profile) {
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
- EEO gender: male→"Male", female→"Female", prefer_not→"I prefer not to say" or closest.
- EEO race: white→"White", black→"Black or African American", hispanic→"Hispanic or Latino", asian→"Asian", prefer_not→"Decline to self identify".
- EEO veteran: yes→"Protected Veteran", no→"I am not a protected veteran", prefer_not→"I prefer not to say".
- EEO disability: yes→"Yes, I have a disability", no→"No, I don't have a disability", prefer_not→"I Don't Wish to Answer".
- Sponsorship: us_citizen/green_card → No, h1b/other → Yes.
- Country questions: use the applicant's country field.
- One sentence max per answer.`;

    const user = `${profileBlock}\n\nFORM FIELDS:\n${JSON.stringify(fieldSummary, null, 2)}`;

    try {
      const data = await enginePost('/api/llm', {
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 1500,
      });
      const parsed = JSON.parse((data.text || '').replace(/```json|```/g, '').trim());
      parsed.forEach(a => { if (a.selector && a.value) answers[a.selector] = a.value; });
    } catch (e) {
      console.warn('[JobHunt BG] Pass 1 failed:', e);
    }
  }

  // Pass 2 — cover letter as plain text
  if (coverFields.length > 0) {
    const system = `You are writing a cover letter for a job application.
Write ONLY the cover letter as plain text — no JSON, no markdown, nothing else.
3 short paragraphs separated by a blank line. Under 300 words. No placeholders.`;

    const user = `${profileBlock}\n\nRESUME:\n${profile.resumeText || '(not provided)'}\n\nCOVER LETTER TEMPLATE:\n${profile.coverLetterText || '(not provided)'}`;

    try {
      const data = await enginePost('/api/llm', {
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 600,
      });
      const text = (data.text || '').trim();
      if (text) coverFields.forEach(f => { answers[f.selector] = text; });
    } catch (e) {
      console.warn('[JobHunt BG] Cover letter failed:', e);
    }
  }

  // Merge
  return fields.map(f => {
    const val = answers[f.selector];
    if (!val) return f;
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
Name: ${p.firstName || ''} ${p.lastName || ''}
Email: ${p.email || ''}
Phone: ${p.phone || ''}
Location: ${p.location || ''}
Country: ${p.country || 'United States'}
City: ${p.city || ''}
State: ${p.state || ''}
Current title: ${p.currentTitle || ''}
Years experience: ${p.yearsExperience || ''}
Work authorization: ${p.workAuth || ''}
Requires sponsorship: ${p.requiresSponsorship ? 'yes' : 'no'}
Authorized to work: ${p.authorizedToWork !== false ? 'yes' : 'no'}
Desired salary: ${p.desiredSalary || ''}
Notice period: ${p.noticePeriod || ''}
LinkedIn: ${p.linkedinURL || ''}
GitHub: ${p.githubURL || ''}
Previously employed here: ${p.previouslyEmployed ? 'yes' : 'no'}
Employment restrictions: ${p.employmentRestrictions || 'none'}
Gender (EEO): ${p.gender || 'prefer_not'}
Race/ethnicity (EEO): ${p.race || 'prefer_not'}
Veteran status (EEO): ${p.veteranStatus || 'prefer_not'}
Disability status (EEO): ${p.disabilityStatus || 'prefer_not'}`;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'FLOAT_BTN_CLICKED' && sender.tab?.id) {
    runAutoApply(sender.tab.id);
  }
});